import { tableFromIPC } from "apache-arrow";
import type { ColumnStats, CorrelationMatrix, Credentials, RowGroupStat, SearchResults, SourceMeta } from "../lib/types";
import type { ViewExpr } from "../lib/viewExpr";
import type {
  BatchTileRequestItem,
  DataAPI,
  ExportFormat,
  QueryTileParams,
  StatsEvent,
  TileMeta,
} from "./contract";

const BASE = (import.meta.env.VITE_API_BASE as string | undefined) ?? "";

async function get<T>(path: string): Promise<T> {
  const res = await fetch(`${BASE}${path}`);
  if (!res.ok) throw new Error(`GET ${path} failed: ${res.status}`);
  return res.json();
}

async function post<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`POST ${path} failed: ${res.status}`);
  return res.json();
}

async function del(path: string): Promise<void> {
  const res = await fetch(`${BASE}${path}`, { method: "DELETE" });
  if (!res.ok) throw new Error(`DELETE ${path} failed: ${res.status}`);
}

export class HttpAdapter implements DataAPI {
  async fetchSources(): Promise<SourceMeta[]> {
    return get("/api/v1/sources");
  }

  async registerSource(uri: string, name?: string, profile?: string, credentials?: Credentials): Promise<SourceMeta> {
    return post("/api/v1/sources", { uri, name, profile, credentials });
  }

  async uploadSource(data: ArrayBuffer, name?: string, isParquet?: boolean): Promise<SourceMeta> {
    const headers: Record<string, string> = {
      "Content-Type": isParquet ? "application/x-parquet" : "application/octet-stream",
      ...(name ? { "X-TV-Name": name } : {}),
    };
    const res = await fetch(`${BASE}/api/v1/upload`, { method: "PUT", headers, body: data });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`upload failed (${res.status})${text ? `: ${text}` : ""}`);
    }
    return res.json();
  }

  async fetchProfiles(): Promise<string[]> {
    return get("/api/v1/profiles");
  }

  async getSource(id: string): Promise<SourceMeta> {
    return get(`/api/v1/sources/${id}`);
  }

  async deleteSource(id: string): Promise<void> {
    return del(`/api/v1/sources/${id}`);
  }

  async fetchViewTile(params: QueryTileParams, signal?: AbortSignal): Promise<TileMeta> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 30_000);
    const combined = signal
      ? typeof AbortSignal.any === "function"
        ? AbortSignal.any([signal, controller.signal])
        : controller.signal
      : controller.signal;
    try {
      const res = await fetch(`${BASE}/api/v1/sources/${params.viewExpr.source_id}/query/tiles`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          view_expr: params.viewExpr,
          row: params.row,
          col: params.col,
          rows: params.rows,
          cols: params.cols,
          mode: params.mode,
        }),
        signal: combined,
      });
      if (!res.ok) throw new Error(`fetchViewTile failed: ${res.status}`);
      const isProvisional = res.headers.get("x-tv-tile-status") === "provisional";
      const jobId = res.headers.get("x-tv-job-id");
      const table = tableFromIPC(await res.arrayBuffer());
      return { table, isProvisional, jobId };
    } finally {
      clearTimeout(timeoutId);
    }
  }

  async fetchViewTileBatch(
    viewExpr: ViewExpr,
    tiles: BatchTileRequestItem[],
    onTile: (idx: number, meta: TileMeta) => void,
    signal?: AbortSignal
  ): Promise<void> {
    const res = await fetch(`${BASE}/api/v1/sources/${viewExpr.source_id}/query/tiles/batch`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ view_expr: viewExpr, tiles }),
      signal,
    });
    if (!res.ok || !res.body) throw new Error(`fetchViewTileBatch failed: ${res.status}`);
    const reader = res.body.getReader();
    let pending = new Uint8Array(0);
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      const merged = new Uint8Array(pending.length + value.length);
      merged.set(pending);
      merged.set(value, pending.length);
      pending = merged;
      while (pending.length >= 8) {
        const tileIdx =
          (pending[0]! | (pending[1]! << 8) | (pending[2]! << 16) | (pending[3]! << 24)) >>> 0;
        const ipcLen =
          (pending[4]! | (pending[5]! << 8) | (pending[6]! << 16) | (pending[7]! << 24)) >>> 0;
        if (pending.length < 8 + ipcLen) break;
        const MAX_IPC_FRAME_BYTES = 512 * 1024 * 1024;
        if (ipcLen > MAX_IPC_FRAME_BYTES) {
          pending = pending.subarray(8 + ipcLen);
          continue;
        }
        if (ipcLen > 0) {
          try {
            const ipcBytes = pending.buffer.slice(
              pending.byteOffset + 8,
              pending.byteOffset + 8 + ipcLen
            );
            onTile(tileIdx, { table: tableFromIPC(ipcBytes), isProvisional: false, jobId: null });
          } catch { }
        }
        pending = pending.subarray(8 + ipcLen);
      }
    }
  }

  async fetchViewCount(viewExpr: ViewExpr): Promise<number> {
    const data = await post<{ count: number }>(
      `/api/v1/sources/${viewExpr.source_id}/query/count`,
      { view_expr: viewExpr }
    );
    return data.count;
  }

  async fetchViewSchema(viewExpr: ViewExpr): Promise<SourceMeta["columns"]> {
    const data = await post<{ columns: SourceMeta["columns"] }>(
      `/api/v1/sources/${viewExpr.source_id}/query/schema`,
      { view_expr: viewExpr }
    );
    return data.columns;
  }

  async fetchExportCode(viewExpr: ViewExpr, format: ExportFormat): Promise<string> {
    const data = await post<{ code: string }>(
      `/api/v1/sources/${viewExpr.source_id}/query/export`,
      { view_expr: viewExpr, format }
    );
    return data.code;
  }

  buildDownloadUrl(viewExpr: ViewExpr, format: "parquet" | "csv" | "arrow" | "jsonl"): string {
    const encoded = btoa(JSON.stringify(viewExpr));
    return `${BASE}/api/v1/sources/${viewExpr.source_id}/query/download?format=${format}&view_expr=${encoded}`;
  }

  async downloadBlob(_viewExpr: ViewExpr, _format: "parquet" | "csv" | "jsonl"): Promise<Blob | null> {
    return null;
  }

  async fetchColumnStats(sourceId: string, colIdx: number, bins?: number): Promise<ColumnStats> {
    const query = bins !== undefined ? `?bins=${bins}` : "";
    return get(`/api/v1/sources/${sourceId}/columns/${colIdx}/stats${query}`);
  }

  async fetchProfile(sourceId: string): Promise<ColumnStats[]> {
    return get(`/api/v1/sources/${sourceId}/profile`);
  }

  async fetchCorrelations(sourceId: string): Promise<CorrelationMatrix> {
    return get(`/api/v1/sources/${sourceId}/correlations`);
  }

  async fetchRowGroupStats(sourceId: string, colIdx: number): Promise<RowGroupStat[]> {
    return get(`/api/v1/sources/${sourceId}/columns/${colIdx}/row-group-stats`);
  }

  async fetchRowGroupStatsBatch(sourceId: string, colIndices: number[]): Promise<Record<string, RowGroupStat[]>> {
    if (colIndices.length === 0) return {};
    const cols = colIndices.join(",");
    return get(`/api/v1/sources/${sourceId}/row-group-stats/batch?cols=${cols}`);
  }

  async searchSource(sourceId: string, query: string, columns?: string[], limit = 100): Promise<SearchResults> {
    return post(`/api/v1/sources/${sourceId}/search`, { query, columns, limit });
  }

  subscribeColumnStats(
    sourceId: string,
    colIdx: number,
    bins: number,
    onEvent: (event: StatsEvent) => void,
    onCoarse?: (stats: ColumnStats) => void
  ): () => void {
    const url = `${BASE}/api/v1/sources/${sourceId}/columns/${colIdx}/stats/stream?bins=${bins}`;
    const es = new EventSource(url);

    es.addEventListener("metadata", (e) => {
      if (!(e instanceof MessageEvent)) return;
      try {
        const data = JSON.parse(e.data);
        onEvent({ type: "metadata", ...data });
      } catch { }
    });

    es.addEventListener("histogram_coarse", (e) => {
      if (!(e instanceof MessageEvent)) return;
      try {
        const coarse = JSON.parse(e.data) as ColumnStats;
        onEvent({ type: "histogram_coarse", data: coarse });
        onCoarse?.(coarse);
      } catch { }
    });

    es.addEventListener("stats", (e) => {
      if (!(e instanceof MessageEvent)) return;
      try {
        const data = JSON.parse(e.data) as ColumnStats;
        onEvent({ type: "stats", data });
      } catch { }
    });

    es.addEventListener("done", () => {
      onEvent({ type: "done" });
      es.close();
    });

    es.addEventListener("error", (e) => {
      const msg = e instanceof MessageEvent ? (e.data as string | undefined) : undefined;
      onEvent({ type: "error", message: msg ?? "unknown error" });
      es.close();
    });

    return () => es.close();
  }

  async speculativeSort(sourceId: string, viewExpr: ViewExpr, colName: string): Promise<void> {
    const sortOp = { type: "sort" as const, keys: [{ column: colName, descending: false, nulls_last: true }] };
    const anticipatedExpr = { ...viewExpr, ops: [...viewExpr.ops, sortOp] };
    await fetch(`${BASE}/api/v1/sources/${sourceId}/query/tiles`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ view_expr: anticipatedExpr, row: 0, col: 0, rows: 256, cols: 64 }),
      signal: AbortSignal.timeout(2000),
    }).catch(() => undefined);
  }
}
