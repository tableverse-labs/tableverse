import type { Table } from "apache-arrow";
import type { ColumnInfo, ColumnStats, CorrelationMatrix, Credentials, RowGroupStat, SearchResults, SourceMeta } from "../../lib/types";
import type { ViewExpr } from "../../lib/viewExpr";
import type {
  BatchTileRequestItem,
  DataAPI,
  ExportFormat,
  QueryTileParams,
  StatsEvent,
  TileMeta,
} from "../contract";
import { getDuckDB, getConnection, resetDuckDB } from "./setup";
import { buildTileSql, buildCountSql, buildViewSql, buildSchemaSql, buildExportCode, buildReaderExpr, quoteIdent } from "./sql-builder";
import { computeColumnStats, computeRowGroupStats, computeCorrelations } from "./stats";

type DuckSource = {
  id: string;
  name: string;
  filename: string;
  columns: ColumnInfo[];
  n_rows: number;
  format: "parquet" | "csv" | "arrow" | "json";
  buffer?: Uint8Array;
};

type DuckTable = { numRows: number; get(i: number): Record<string, unknown> | null };

function isWasmCrash(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return msg.includes("_setThrew") || msg.includes("unreachable") || msg.includes("RuntimeError");
}

function uid(): string {
  return crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).slice(2);
}

function detectFormat(name: string): "parquet" | "csv" | "arrow" | "json" {
  const lower = name.toLowerCase();
  if (lower.endsWith(".parquet")) return "parquet";
  if (lower.endsWith(".csv")) return "csv";
  if (lower.endsWith(".arrow")) return "arrow";
  if (lower.endsWith(".json") || lower.endsWith(".jsonl") || lower.endsWith(".ndjson")) return "json";
  return "parquet";
}

function mapDuckType(t: string): string {
  const u = t.toUpperCase();
  if (/INT|HUGEINT/.test(u)) return "integer";
  if (/FLOAT|DOUBLE|DECIMAL|NUMERIC/.test(u)) return "float";
  if (/BOOL/.test(u)) return "boolean";
  if (/TIMESTAMP/.test(u)) return "timestamp";
  if (/DATE/.test(u)) return "date";
  if (/VARCHAR|TEXT|CHAR/.test(u)) return "string";
  if (/BLOB|BINARY/.test(u)) return "binary";
  if (/LIST|ARRAY/.test(u)) return "list";
  if (/STRUCT|MAP/.test(u)) return "struct";
  return "string";
}

function schemaResultToColumns(result: DuckTable): ColumnInfo[] {
  const columns: ColumnInfo[] = [];
  for (let i = 0; i < result.numRows; i++) {
    const row = result.get(i);
    if (!row) continue;
    columns.push({
      index: i,
      name: String(row["column_name"] ?? row["Field"] ?? ""),
      data_type: mapDuckType(String(row["column_type"] ?? row["Type"] ?? "")),
      nullable: String(row["null"] ?? row["Null"] ?? "YES").toUpperCase() !== "NO",
    });
  }
  return columns;
}

export class DuckDbAdapter implements DataAPI {
  private registry = new Map<string, DuckSource>();

  private findSource(id: string): DuckSource {
    const src = this.registry.get(id);
    if (!src) throw new Error(`Source not found: ${id}`);
    return src;
  }

  async fetchSources(): Promise<SourceMeta[]> {
    return [...this.registry.values()].map((s) => this.toMeta(s));
  }

  async registerSource(uri: string, name?: string, _profile?: string, _credentials?: Credentials): Promise<SourceMeta> {
    const res = await fetch(uri);
    if (!res.ok) throw new Error(`Failed to fetch ${uri}: ${res.status}`);
    const buf = await res.arrayBuffer();
    const filename = uri.split("/").pop() ?? uri;
    return this.loadBuffer(buf, name ?? filename, filename.endsWith(".parquet"));
  }

  async uploadSource(data: ArrayBuffer, name?: string, isParquet?: boolean): Promise<SourceMeta> {
    const filename = name ?? (isParquet ? "upload.parquet" : "upload.csv");
    return this.loadBuffer(data, name ?? filename, isParquet ?? filename.endsWith(".parquet"));
  }

  async fetchProfiles(): Promise<string[]> {
    return [];
  }

  async getSource(id: string): Promise<SourceMeta> {
    return this.toMeta(this.findSource(id));
  }

  async deleteSource(id: string): Promise<void> {
    const src = this.findSource(id);
    const db = await getDuckDB();
    try {
      await db.dropFile(src.filename);
    } catch { }
    this.registry.delete(id);
  }

  async fetchViewTile(params: QueryTileParams, signal?: AbortSignal): Promise<TileMeta> {
    const src = this.findSource(params.viewExpr.source_id);
    if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
    const sql = buildTileSql(src.filename, params.viewExpr, params.row, params.rows ?? 256, src.format);
    try {
      const conn = await getConnection();
      const result = await conn.query(sql);
      return { table: result as unknown as Table, isProvisional: false, jobId: null };
    } catch (err) {
      if (isWasmCrash(err)) {
        await this.recoverAfterCrash();
        const conn = await getConnection();
        const result = await conn.query(sql);
        return { table: result as unknown as Table, isProvisional: false, jobId: null };
      }
      throw err;
    }
  }

  async fetchViewTileBatch(
    viewExpr: ViewExpr,
    tiles: BatchTileRequestItem[],
    onTile: (idx: number, meta: TileMeta) => void,
    signal?: AbortSignal
  ): Promise<void> {
    const src = this.findSource(viewExpr.source_id);
    const conn = await getConnection();
    for (let i = 0; i < tiles.length; i++) {
      if (signal?.aborted) break;
      const tile = tiles[i]!;
      const sql = buildTileSql(src.filename, viewExpr, tile.row, tile.rows, src.format);
      const result = await conn.query(sql);
      onTile(i, { table: result as unknown as Table, isProvisional: false, jobId: null });
    }
  }

  async fetchViewCount(viewExpr: ViewExpr): Promise<number> {
    const src = this.findSource(viewExpr.source_id);
    const sql = buildCountSql(src.filename, viewExpr.ops, src.format);
    const conn = await getConnection();
    const result = await conn.query(sql) as unknown as DuckTable;
    const row = result.get(0);
    return row ? Number(row["n"] ?? 0) : 0;
  }

  async fetchViewSchema(viewExpr: ViewExpr): Promise<SourceMeta["columns"]> {
    const src = this.findSource(viewExpr.source_id);
    if (viewExpr.ops.length === 0) return src.columns;
    const viewSql = buildViewSql(src.filename, viewExpr.ops, src.format);
    const conn = await getConnection();
    const result = await conn.query(`DESCRIBE SELECT * FROM (${viewSql}) LIMIT 0`) as unknown as DuckTable;
    return schemaResultToColumns(result);
  }

  async fetchExportCode(viewExpr: ViewExpr, format: ExportFormat): Promise<string> {
    const src = this.findSource(viewExpr.source_id);
    return buildExportCode(src.filename, viewExpr.ops, format);
  }

  buildDownloadUrl(_viewExpr: ViewExpr, _format: "parquet" | "csv" | "arrow" | "jsonl"): string {
    return "";
  }

  async downloadBlob(viewExpr: ViewExpr, format: "parquet" | "csv" | "jsonl"): Promise<Blob | null> {
    const src = this.findSource(viewExpr.source_id);
    const sql = buildViewSql(src.filename, viewExpr.ops, src.format);
    const conn = await getConnection();
    const db = await getDuckDB();
    const tag = `tv_export_${Date.now()}`;

    let outFile: string;
    let mimeType: string;

    if (format === "csv") {
      outFile = `${tag}.csv`;
      mimeType = "text/csv";
      await conn.query(`COPY (${sql}) TO '${outFile}' (FORMAT CSV, HEADER true)`);
    } else if (format === "jsonl") {
      outFile = `${tag}.ndjson`;
      mimeType = "application/x-ndjson";
      await conn.query(`COPY (${sql}) TO '${outFile}' (FORMAT JSON)`);
    } else {
      outFile = `${tag}.parquet`;
      mimeType = "application/octet-stream";
      await conn.query(`COPY (${sql}) TO '${outFile}' (FORMAT PARQUET)`);
    }

    try {
      const buf = await db.copyFileToBuffer(outFile);
      return new Blob([buf.slice().buffer], { type: mimeType });
    } finally {
      try { await db.dropFile(outFile); } catch { }
    }
  }

  async fetchColumnStats(sourceId: string, colIdx: number, bins = 50): Promise<ColumnStats> {
    const src = this.findSource(sourceId);
    const col = src.columns[colIdx];
    if (!col) throw new Error(`Column index out of range: ${colIdx}`);
    const conn = await getConnection();
    return computeColumnStats(conn, src.filename, col, src.n_rows, bins, src.format);
  }

  async fetchProfile(sourceId: string): Promise<ColumnStats[]> {
    const src = this.findSource(sourceId);
    const conn = await getConnection();
    return Promise.all(
      src.columns.map((col) => computeColumnStats(conn, src.filename, col, src.n_rows, 50, src.format))
    );
  }

  async fetchCorrelations(sourceId: string): Promise<CorrelationMatrix> {
    const src = this.findSource(sourceId);
    const numericCols = src.columns.filter((c) => /int|float|double|decimal|numeric/i.test(c.data_type));
    const conn = await getConnection();
    return computeCorrelations(conn, src.filename, numericCols, src.format);
  }

  async fetchRowGroupStats(sourceId: string, colIdx: number): Promise<RowGroupStat[]> {
    const src = this.findSource(sourceId);
    const col = src.columns[colIdx];
    if (!col) return [];
    const conn = await getConnection();
    return computeRowGroupStats(conn, src.filename, col, src.format);
  }

  async fetchRowGroupStatsBatch(sourceId: string, colIndices: number[]): Promise<Record<string, RowGroupStat[]>> {
    if (colIndices.length === 0) return {};
    const src = this.findSource(sourceId);
    const conn = await getConnection();
    const result: Record<string, RowGroupStat[]> = {};
    for (const idx of colIndices) {
      const col = src.columns[idx];
      if (!col) continue;
      result[String(idx)] = await computeRowGroupStats(conn, src.filename, col, src.format);
    }
    return result;
  }

  async searchSource(sourceId: string, query: string, columns?: string[], limit = 100): Promise<SearchResults> {
    const src = this.findSource(sourceId);
    const cols = columns ?? src.columns.map((c) => c.name);
    const escaped = query.replace(/'/g, "''");
    const conditions = cols
      .map((c) => `CAST(${quoteIdent(c)} AS VARCHAR) ILIKE '%${escaped}%'`)
      .join(" OR ");
    const sql = `
      SELECT row_number() OVER () - 1 AS rn
      FROM ${buildReaderExpr(src.filename, src.format)}
      WHERE ${conditions}
      LIMIT ${limit}
    `;
    const conn = await getConnection();
    const result = await conn.query(sql) as unknown as DuckTable;
    const rows: number[] = [];
    for (let i = 0; i < result.numRows; i++) {
      const row = result.get(i);
      if (row) rows.push(Number(row["rn"] ?? 0));
    }
    return { rows, total: rows.length };
  }

  subscribeColumnStats(
    sourceId: string,
    colIdx: number,
    bins: number,
    onEvent: (event: StatsEvent) => void,
    onCoarse?: (stats: ColumnStats) => void
  ): () => void {
    let cancelled = false;

    (async () => {
      try {
        const src = this.findSource(sourceId);
        const col = src.columns[colIdx];
        if (!col) {
          if (!cancelled) onEvent({ type: "error", message: `Column index out of range: ${colIdx}` });
          return;
        }

        if (cancelled) return;
        onEvent({
          type: "metadata",
          min: null,
          max: null,
          null_count: 0,
          row_count: src.n_rows,
          col_name: col.name,
        });

        if (cancelled) return;
        const conn = await getConnection();
        if (cancelled) return;
        const stats = await computeColumnStats(conn, src.filename, col, src.n_rows, bins, src.format);
        if (cancelled) return;
        onCoarse?.(stats);
        onEvent({ type: "stats", data: stats });
        onEvent({ type: "done" });
      } catch (err) {
        if (!cancelled) {
          onEvent({ type: "error", message: err instanceof Error ? err.message : String(err) });
        }
      }
    })();

    return () => { cancelled = true; };
  }

  async speculativeSort(_sourceId: string, _viewExpr: ViewExpr, _colName: string): Promise<void> {
  }

  private async recoverAfterCrash(): Promise<void> {
    resetDuckDB();
    const db = await getDuckDB();
    for (const src of this.registry.values()) {
      if (src.buffer) {
        try {
          await db.registerFileBuffer(src.filename, src.buffer);
        } catch { }
      }
    }
  }

  private toMeta(src: DuckSource): SourceMeta {
    return {
      id: src.id,
      name: src.name,
      uri: src.filename,
      format: src.format,
      kind: "local_file",
      n_rows: src.n_rows,
      n_cols: src.columns.length,
      columns: src.columns,
    };
  }

  private async loadBuffer(data: ArrayBuffer, name: string, isParquet: boolean): Promise<SourceMeta> {
    const id = uid();
    const ext = isParquet ? ".parquet" : name.includes(".") ? name.slice(name.lastIndexOf(".")) : ".csv";
    const filename = `tv_${id}${ext}`;
    const format = detectFormat(filename);

    const db = await getDuckDB();
    const buffer = new Uint8Array(data);
    await db.registerFileBuffer(filename, buffer);

    const conn = await getConnection();
    let columns: ColumnInfo[];
    let nRows: number;

    try {
      const schemaResult = await conn.query(buildSchemaSql(filename, format)) as unknown as DuckTable;
      columns = schemaResultToColumns(schemaResult);

      const countSql = `SELECT COUNT(*) AS n FROM ${buildReaderExpr(filename, format)}`;
      const countResult = await conn.query(countSql) as unknown as DuckTable;
      const countRow = countResult.get(0);
      nRows = countRow ? Number(countRow["n"] ?? 0) : 0;
    } catch (err) {
      try { await db.dropFile(filename); } catch { }
      throw err;
    }

    const src: DuckSource = { id, name, filename, columns, n_rows: nRows, format, buffer };
    this.registry.set(id, src);
    return this.toMeta(src);
  }
}
