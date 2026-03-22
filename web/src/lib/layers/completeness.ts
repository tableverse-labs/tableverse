import type { ColumnInfo, ColumnStats, QuickColumnStats } from "../types";

export function renderCompletenessCell(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  isNull: boolean,
  colInfo: ColumnInfo,
  fullStats: ColumnStats | undefined,
  qStats: QuickColumnStats | undefined,
): void {
  const nullRate = qStats?.null_rate ?? fullStats?.null_rate ?? 0;
  if (nullRate <= 0.01 && !isNull) return;

  if (isNull) {
    ctx.save();
    ctx.globalAlpha = 0.35;
    ctx.fillStyle = "#dc2626";
    ctx.fillRect(x + 1, y + 1, w - 2, h - 2);
    ctx.restore();
    return;
  }

  if (nullRate > 0.05) {
    const completeness = 1 - nullRate;
    const hue = Math.round(completeness * 120);
    ctx.save();
    ctx.globalAlpha = nullRate * 0.25;
    ctx.fillStyle = `hsl(${hue},80%,45%)`;
    ctx.fillRect(x + 1, y + 1, w - 2, h - 2);
    ctx.restore();
  }
}
