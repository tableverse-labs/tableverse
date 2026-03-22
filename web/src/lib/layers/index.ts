import type { Table } from "apache-arrow";
import type { LayerName } from "../../stores/ui";
import type { ColumnInfo, ColumnStats, SourceMeta } from "../types";
import { tileKey } from "../viewport";
import { renderNullMapCell } from "./null-map";
import { renderDistributionCell } from "./distribution";
import { renderOutlierCell } from "./outlier";
import { renderCompletenessCell } from "./completeness";
import { renderClassBalanceCell } from "./class-balance";

export type { LayerName };

export function renderLayerCanvas(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  cellW: number,
  cellH: number,
  scrollX: number,
  scrollY: number,
  tiles: Map<string, Table>,
  viewHash: string,
  nRows: number,
  nCols: number,
  source: SourceMeta,
  allStats: Map<string, ColumnStats>,
  virtualSchema: ColumnInfo[] | null,
  activeLayers: Set<LayerName>,
  tileRows: number,
  tileCols: number,
): void {
  const dpr = window.devicePixelRatio || 1;
  ctx.clearRect(0, 0, width * dpr, height * dpr);

  const hasNull = activeLayers.has("null_map");
  const hasDistrib = activeLayers.has("distribution");
  const hasOutlier = activeLayers.has("outlier");
  const hasCompleteness = activeLayers.has("completeness");
  const hasClassBalance = activeLayers.has("class_balance");

  if (!hasNull && !hasDistrib && !hasOutlier && !hasCompleteness && !hasClassBalance) return;

  const colStart = Math.floor(scrollX / cellW);
  const rowStart = Math.floor(scrollY / cellH);
  const colEnd = Math.min(nCols, Math.ceil((scrollX + width) / cellW) + 1);
  const rowEnd = Math.min(nRows, Math.ceil((scrollY + height) / cellH) + 1);

  for (let row = rowStart; row < rowEnd; row++) {
    const tileRow = Math.floor(row / tileRows);
    const localRow = row % tileRows;
    const y = row * cellH - scrollY;

    for (let col = colStart; col < colEnd; col++) {
      const tileCol = Math.floor(col / tileCols);
      const x = col * cellW - scrollX;

      const colInfo = virtualSchema?.[col] ?? source.columns[col];
      if (!colInfo) continue;

      const qStats = source.quick_stats?.[col];
      const fullStats = allStats.get(`${source.id}:${col}`);

      const tKey = tileKey(tileRow, tileCol, viewHash);
      const tile = tiles.get(tKey);
      if (!tile) continue;

      const column = tile.getChildAt(col % tileCols);
      if (!column || localRow >= column.length) continue;

      const value = column.get(localRow);
      const isNull = value === null || value === undefined;
      const nullRate = qStats?.null_rate ?? fullStats?.null_rate ?? 0;

      if (hasNull) {
        renderNullMapCell(ctx, x, y, cellW, cellH, isNull, nullRate);
      }
      if (hasCompleteness) {
        renderCompletenessCell(ctx, x, y, cellW, cellH, isNull, colInfo, fullStats, qStats);
      }
      if (!isNull) {
        if (hasDistrib) {
          renderDistributionCell(ctx, x, y, cellW, cellH, value, colInfo, fullStats, qStats);
        }
        if (hasOutlier) {
          renderOutlierCell(ctx, x, y, cellW, cellH, value, colInfo, fullStats);
        }
        if (hasClassBalance) {
          renderClassBalanceCell(ctx, x, y, cellW, cellH, value, colInfo, fullStats);
        }
      }
    }
  }
}
