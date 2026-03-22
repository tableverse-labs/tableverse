import type { Table } from "apache-arrow";
import type { ColumnStats, CorrelationMatrix, Credentials, RowGroupStat, SearchResults, SourceMeta } from "../lib/types";
import type { ViewExpr } from "../lib/viewExpr";

export type QueryTileParams = {
  viewExpr: ViewExpr;
  row: number;
  col: number;
  rows?: number;
  cols?: number;
  mode?: "agg";
};

export type TileMeta = {
  table: Table;
  isProvisional: boolean;
  jobId: string | null;
};

export type BatchTileRequestItem = {
  row: number;
  col: number;
  rows: number;
  cols: number;
};

export type ExportFormat =
  | "sql"
  | "python_duckdb"
  | "python_polars"
  | "python_pandas"
  | "shell"
  | "shell_csv"
  | "ansi_sql"
  | "dbt";

export type StatsEvent =
  | { type: "metadata"; min: unknown; max: unknown; null_count: number; row_count: number; col_name: string | null }
  | { type: "histogram_coarse"; data: ColumnStats }
  | { type: "stats"; data: ColumnStats }
  | { type: "done" }
  | { type: "error"; message: string };

export interface DataAPI {
  fetchSources(): Promise<SourceMeta[]>;
  registerSource(uri: string, name?: string, profile?: string, credentials?: Credentials): Promise<SourceMeta>;
  uploadSource(data: ArrayBuffer, name?: string, isParquet?: boolean): Promise<SourceMeta>;
  fetchProfiles(): Promise<string[]>;
  getSource(id: string): Promise<SourceMeta>;
  deleteSource(id: string): Promise<void>;
  fetchViewTile(params: QueryTileParams, signal?: AbortSignal): Promise<TileMeta>;
  fetchViewTileBatch(
    viewExpr: ViewExpr,
    tiles: BatchTileRequestItem[],
    onTile: (idx: number, meta: TileMeta) => void,
    signal?: AbortSignal
  ): Promise<void>;
  fetchViewCount(viewExpr: ViewExpr): Promise<number>;
  fetchViewSchema(viewExpr: ViewExpr): Promise<SourceMeta["columns"]>;
  fetchExportCode(viewExpr: ViewExpr, format: ExportFormat): Promise<string>;
  buildDownloadUrl(viewExpr: ViewExpr, format: "parquet" | "csv" | "arrow" | "jsonl"): string;
  downloadBlob(viewExpr: ViewExpr, format: "parquet" | "csv" | "jsonl"): Promise<Blob | null>;
  fetchColumnStats(sourceId: string, colIdx: number, bins?: number): Promise<ColumnStats>;
  fetchProfile(sourceId: string): Promise<ColumnStats[]>;
  fetchCorrelations(sourceId: string): Promise<CorrelationMatrix>;
  fetchRowGroupStats(sourceId: string, colIdx: number): Promise<RowGroupStat[]>;
  fetchRowGroupStatsBatch(sourceId: string, colIndices: number[]): Promise<Record<string, RowGroupStat[]>>;
  searchSource(sourceId: string, query: string, columns?: string[], limit?: number): Promise<SearchResults>;
  subscribeColumnStats(
    sourceId: string,
    colIdx: number,
    bins: number,
    onEvent: (event: StatsEvent) => void,
    onCoarse?: (stats: ColumnStats) => void
  ): () => void;
  speculativeSort(sourceId: string, viewExpr: ViewExpr, colName: string): Promise<void>;
}
