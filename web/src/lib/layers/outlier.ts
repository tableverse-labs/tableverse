import type { ColumnInfo, ColumnStats } from "../types";
import { classifyDataType } from "../semantic-render";

export function renderOutlierCell(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  value: unknown,
  colInfo: ColumnInfo,
  fullStats: ColumnStats | undefined,
): void {
  const dt = classifyDataType(colInfo.data_type);
  if (dt !== "numeric") return;

  const quantiles = fullStats?.quantiles;
  if (!quantiles) return;

  const num = Number(value);
  if (!isFinite(num)) return;

  const isHigh = num > quantiles.p99;
  const isLow = num < quantiles.p1;
  if (!isHigh && !isLow) return;

  ctx.save();
  ctx.globalAlpha = 0.9;
  ctx.strokeStyle = isHigh ? "#f59e0b" : "#818cf8";
  ctx.lineWidth = 2;
  ctx.strokeRect(x + 1, y + 1, w - 2, h - 2);
  ctx.restore();
}
