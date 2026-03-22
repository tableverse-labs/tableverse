import type { ColumnStats, CorrelationMatrix, Credentials, RowGroupStat, SearchResults, SourceMeta } from "../lib/types";
import type { ViewExpr } from "../lib/viewExpr";
import type { DataAPI } from "./contract";
import { HttpAdapter } from "./http";

export type {
  BatchTileRequestItem,
  DataAPI,
  ExportFormat,
  QueryTileParams,
  StatsEvent,
  TileMeta,
} from "./contract";

let adapter: DataAPI = new HttpAdapter();

export function setAdapter(impl: DataAPI): void {
  adapter = impl;
}

export function getAdapter(): DataAPI {
  return adapter;
}

export function fetchSources(): Promise<SourceMeta[]> {
  return adapter.fetchSources();
}

export function registerSource(uri: string, name?: string, profile?: string, credentials?: Credentials): Promise<SourceMeta> {
  return adapter.registerSource(uri, name, profile, credentials);
}

export function uploadSource(data: ArrayBuffer, name?: string, isParquet?: boolean): Promise<SourceMeta> {
  return adapter.uploadSource(data, name, isParquet);
}

export function fetchProfiles(): Promise<string[]> {
  return adapter.fetchProfiles();
}

export function getSource(id: string): Promise<SourceMeta> {
  return adapter.getSource(id);
}

export function deleteSource(id: string): Promise<void> {
  return adapter.deleteSource(id);
}

export function fetchViewTile(
  params: import("./contract").QueryTileParams,
  signal?: AbortSignal
): Promise<import("./contract").TileMeta> {
  return adapter.fetchViewTile(params, signal);
}

export function fetchViewTileBatch(
  viewExpr: ViewExpr,
  tiles: import("./contract").BatchTileRequestItem[],
  onTile: (idx: number, meta: import("./contract").TileMeta) => void,
  signal?: AbortSignal
): Promise<void> {
  return adapter.fetchViewTileBatch(viewExpr, tiles, onTile, signal);
}

export function fetchViewCount(viewExpr: ViewExpr): Promise<number> {
  return adapter.fetchViewCount(viewExpr);
}

export function fetchViewSchema(viewExpr: ViewExpr): Promise<SourceMeta["columns"]> {
  return adapter.fetchViewSchema(viewExpr);
}

export function fetchExportCode(viewExpr: ViewExpr, format: import("./contract").ExportFormat): Promise<string> {
  return adapter.fetchExportCode(viewExpr, format);
}

export function buildDownloadUrl(viewExpr: ViewExpr, format: "parquet" | "csv" | "arrow" | "jsonl"): string {
  return adapter.buildDownloadUrl(viewExpr, format);
}

export function downloadBlob(viewExpr: ViewExpr, format: "parquet" | "csv" | "jsonl"): Promise<Blob | null> {
  return adapter.downloadBlob(viewExpr, format);
}

export function fetchColumnStats(sourceId: string, colIdx: number, bins?: number): Promise<ColumnStats> {
  return adapter.fetchColumnStats(sourceId, colIdx, bins);
}

export function fetchProfile(sourceId: string): Promise<ColumnStats[]> {
  return adapter.fetchProfile(sourceId);
}

export function fetchCorrelations(sourceId: string): Promise<CorrelationMatrix> {
  return adapter.fetchCorrelations(sourceId);
}

export function fetchRowGroupStats(sourceId: string, colIdx: number): Promise<RowGroupStat[]> {
  return adapter.fetchRowGroupStats(sourceId, colIdx);
}

export function fetchRowGroupStatsBatch(sourceId: string, colIndices: number[]): Promise<Record<string, RowGroupStat[]>> {
  return adapter.fetchRowGroupStatsBatch(sourceId, colIndices);
}

export function searchSource(sourceId: string, query: string, columns?: string[], limit?: number): Promise<SearchResults> {
  return adapter.searchSource(sourceId, query, columns, limit);
}

export function subscribeColumnStats(
  sourceId: string,
  colIdx: number,
  bins: number,
  onEvent: (event: import("./contract").StatsEvent) => void,
  onCoarse?: (stats: ColumnStats) => void
): () => void {
  return adapter.subscribeColumnStats(sourceId, colIdx, bins, onEvent, onCoarse);
}

export function speculativeSort(sourceId: string, viewExpr: ViewExpr, colName: string): Promise<void> {
  return adapter.speculativeSort(sourceId, viewExpr, colName);
}
