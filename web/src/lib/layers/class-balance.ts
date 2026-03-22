import type { ColumnInfo, ColumnStats } from "../types";
import { classifyDataType } from "../semantic-render";
import { categoricalColor } from "../color-scales";

export function renderClassBalanceCell(
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
  if (dt !== "string" && dt !== "boolean") return;

  const topValues = fullStats?.top_values;
  if (!topValues || topValues.length === 0) return;
  if (value === null || value === undefined) return;

  const strVal = String(value);
  const rank = topValues.findIndex((tv) => String(tv.value) === strVal);
  if (rank < 0) return;

  const [r, g, b] = categoricalColor(rank);
  const maxRate = topValues[0]?.rate ?? 1;
  const thisRate = topValues[rank]?.rate ?? 0;
  const imbalanceFactor = maxRate > 0 ? Math.min(1, thisRate / maxRate) : 0.5;

  ctx.save();
  ctx.globalAlpha = 0.15 + imbalanceFactor * 0.3;
  ctx.fillStyle = `rgb(${r},${g},${b})`;
  ctx.fillRect(x + 1, y + 1, w - 2, h - 2);
  ctx.restore();
}
