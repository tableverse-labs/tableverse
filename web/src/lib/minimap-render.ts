import type { LayerName } from "../stores/ui";
import type { ColumnInfo, ColumnStats, QuickColumnStats, RowGroupStat } from "./types";
import { nullRateColor, viridis, interpolate } from "./color-scales";

export type MinimapMode = "neutral" | LayerName;

type RGB = [number, number, number];

const LAYER_LABELS: Record<LayerName, string> = {
  null_map: "NULL RATE",
  distribution: "VALUES",
  outlier: "OUTLIERS",
  quality_alerts: "QUALITY",
  completeness: "COMPLETENESS",
  class_balance: "CLASS BALANCE",
};

const LAYER_ACCENT: Record<LayerName, string> = {
  null_map: "#ef4444",
  distribution: "#8b5cf6",
  outlier: "#f59e0b",
  quality_alerts: "#10b981",
  completeness: "#3b82f6",
  class_balance: "#ec4899",
};

export function activeMinimapLayer(activeLayers: Set<LayerName>): LayerName | null {
  for (const priority of ["null_map", "completeness", "distribution", "outlier", "quality_alerts", "class_balance"] as LayerName[]) {
    if (activeLayers.has(priority)) return priority;
  }
  return null;
}

export function layerLabel(layer: LayerName): string {
  return LAYER_LABELS[layer];
}

export function layerAccent(layer: LayerName): string {
  return LAYER_ACCENT[layer];
}

function rgbToPixel(data: Uint8ClampedArray, idx: number, rgb: RGB, alpha = 255): void {
  data[idx] = rgb[0];
  data[idx + 1] = rgb[1];
  data[idx + 2] = rgb[2];
  data[idx + 3] = alpha;
}

function fillRect(
  data: Uint8ClampedArray,
  panelW: number,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  rgb: RGB,
): void {
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      rgbToPixel(data, (y * panelW + x) * 4, rgb);
    }
  }
}

function computeLayerColor(
  rg: RowGroupStat,
  layer: LayerName,
  colStats: ColumnStats | undefined,
  qStats: QuickColumnStats | undefined,
  globalMin: number,
  globalMax: number,
  isDark: boolean,
): RGB {
  const noData: RGB = isDark ? [31, 41, 55] : [243, 244, 246];

  if (layer === "null_map") {
    const rate = rg.row_count > 0 ? rg.null_count / rg.row_count : 0;
    return nullRateColor(rate) as RGB;
  }

  if (layer === "completeness") {
    const rate = rg.row_count > 0 ? rg.null_count / rg.row_count : 0;
    const completeness = 1 - rate;
    const hue = Math.round(completeness * 120);
    const r = completeness < 0.5 ? 220 : Math.round(220 * (1 - completeness) * 2);
    const g = completeness > 0.5 ? 150 : Math.round(150 * completeness * 2);
    return [r, g, 60] as RGB;
  }

  if (layer === "distribution") {
    if (rg.mean === null) return noData;
    const range = globalMax - globalMin;
    const t = range <= 0 ? 0.5 : Math.max(0, Math.min(1, (rg.mean - globalMin) / range));
    return viridis(t) as RGB;
  }

  if (layer === "outlier") {
    if (rg.min === null || rg.max === null || rg.mean === null) return noData;
    const spread = rg.max - rg.min;
    const globalRange = globalMax - globalMin;
    const t = globalRange <= 0 ? 0.5 : Math.min(1, spread / globalRange);
    return interpolate([[254, 243, 199], [251, 191, 36], [217, 119, 6]], t) as RGB;
  }

  if (layer === "quality_alerts") {
    const nullRate = rg.row_count > 0 ? rg.null_count / rg.row_count : 0;
    const quality = 1 - nullRate;
    const r = Math.round((1 - quality) * 220 + quality * 16);
    const g = Math.round(quality * 185 + (1 - quality) * 30);
    const b = Math.round(quality * 129 + (1 - quality) * 30);
    return [r, g, b];
  }

  if (layer === "class_balance") {
    const ratio = colStats?.class_imbalance_ratio ?? 1;
    const imbalance = Math.min(1, (ratio - 1) / 19);
    return interpolate([[236, 253, 245], [52, 211, 153], [217, 70, 239]], imbalance) as RGB;
  }

  return noData;
}

export function renderMinimapLayer(
  data: Uint8ClampedArray,
  panelW: number,
  panelH: number,
  nCols: number,
  totalRows: number,
  layer: LayerName,
  rowGroupStatsByCol: Map<string, RowGroupStat[]>,
  colStats: Map<string, ColumnStats>,
  quickStats: QuickColumnStats[],
  sourceId: string,
  isDark: boolean,
): void {
  const noData: RGB = isDark ? [31, 41, 55] : [243, 244, 246];

  for (let col = 0; col < nCols; col++) {
    const x0 = Math.floor((col * panelW) / nCols);
    const x1 = Math.floor(((col + 1) * panelW) / nCols);
    if (x1 <= x0) continue;

    const key = `${sourceId}:${col}`;
    const rgStats = rowGroupStatsByCol.get(key);
    const cs = colStats.get(key);
    const qs = quickStats[col];

    if (!rgStats || rgStats.length === 0) {
      fillRect(data, panelW, x0, 0, x1, panelH, noData);
      continue;
    }

    let globalMin = Infinity;
    let globalMax = -Infinity;
    for (const rg of rgStats) {
      if (rg.min !== null && rg.min < globalMin) globalMin = rg.min;
      if (rg.max !== null && rg.max > globalMax) globalMax = rg.max;
      if (rg.mean !== null) {
        if (rg.mean < globalMin) globalMin = rg.mean;
        if (rg.mean > globalMax) globalMax = rg.mean;
      }
    }
    if (!isFinite(globalMin)) globalMin = 0;
    if (!isFinite(globalMax)) globalMax = 1;

    for (const rg of rgStats) {
      const y0 = Math.floor((rg.row_offset * panelH) / totalRows);
      const y1 = Math.floor(((rg.row_offset + rg.row_count) * panelH) / totalRows);
      const clampedY1 = Math.max(y0 + 1, Math.min(y1, panelH));
      const color = computeLayerColor(rg, layer, cs, qs, globalMin, globalMax, isDark);
      fillRect(data, panelW, x0, y0, x1, clampedY1, color);
    }
  }
}

export function renderMinimapNeutral(
  data: Uint8ClampedArray,
  panelW: number,
  panelH: number,
  nCols: number,
  totalRows: number,
  globalNullRate: number,
  rowGroupStatsByCol: Map<string, RowGroupStat[]>,
  sourceId: string,
  isDark: boolean,
): void {
  for (let y = 0; y < panelH; y++) {
    const rowStart = Math.floor((y / panelH) * totalRows);
    const rowEnd = Math.ceil(((y + 1) / panelH) * totalRows);

    let rgNullSum = 0;
    let rgCount = 0;
    for (let ci = 0; ci < nCols; ci++) {
      const stats = rowGroupStatsByCol.get(`${sourceId}:${ci}`);
      if (!stats) continue;
      for (const rg of stats) {
        if (rg.row_offset < rowEnd && rg.row_offset + rg.row_count > rowStart) {
          rgNullSum += rg.row_count > 0 ? rg.null_count / rg.row_count : 0;
          rgCount++;
        }
      }
    }

    const nullRate = rgCount > 0 ? globalNullRate * 0.3 + (rgNullSum / rgCount) * 0.7 : globalNullRate;
    const v = isDark ? Math.round((1 - nullRate) * 38 + 26) : Math.round((1 - nullRate) * 45 + 185);
    const rgb: RGB = [v, v, v];

    for (let x = 0; x < panelW; x++) {
      rgbToPixel(data, (y * panelW + x) * 4, rgb);
    }
  }
}

export function renderMinimapColumnSeparators(
  data: Uint8ClampedArray,
  panelW: number,
  panelH: number,
  nCols: number,
  isDark: boolean,
): void {
  const sepColor: RGB = isDark ? [55, 65, 81] : [209, 213, 219];
  for (let col = 1; col < nCols; col++) {
    const x = Math.floor((col * panelW) / nCols);
    if (x <= 0 || x >= panelW) continue;
    for (let y = 0; y < panelH; y++) {
      rgbToPixel(data, (y * panelW + x) * 4, sepColor);
    }
  }
}
