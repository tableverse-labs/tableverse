import type { ColumnInfo, ColumnStats, QuickColumnStats } from "../types";
import { classifyDataType } from "../semantic-render";
import { ylgnbu, pubugn, normalizeByQuantiles } from "../color-scales";

export function renderDistributionCell(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  value: unknown,
  colInfo: ColumnInfo,
  fullStats: ColumnStats | undefined,
  qStats: QuickColumnStats | undefined,
): void {
  const dt = classifyDataType(colInfo.data_type);

  if (dt === "numeric") {
    const num = Number(value);
    if (!isFinite(num)) return;

    let t: number;
    if (fullStats?.quantiles) {
      t = normalizeByQuantiles(num, fullStats.quantiles);
    } else if (qStats?.min !== undefined && qStats?.max !== undefined) {
      const lo = Number(qStats.min);
      const hi = Number(qStats.max);
      const range = hi - lo;
      t = range > 0 ? Math.max(0, Math.min(1, (num - lo) / range)) : 0.5;
    } else {
      return;
    }

    const [r, g, b] = ylgnbu(t);
    ctx.save();
    ctx.globalAlpha = 0.5;
    ctx.fillStyle = `rgb(${r},${g},${b})`;
    ctx.fillRect(x + 1, y + 1, w - 2, h - 2);
    ctx.restore();
    return;
  }

  if (dt === "temporal") {
    const num = Number(value);
    if (!isFinite(num)) return;

    const lo = qStats?.min !== undefined ? Number(qStats.min) : null;
    const hi = qStats?.max !== undefined ? Number(qStats.max) : null;
    if (lo === null || hi === null) return;
    const range = hi - lo;
    const t = range > 0 ? Math.max(0, Math.min(1, (num - lo) / range)) : 0.5;
    const [r, g, b] = pubugn(t);
    ctx.save();
    ctx.globalAlpha = 0.45;
    ctx.fillStyle = `rgb(${r},${g},${b})`;
    ctx.fillRect(x + 1, y + 1, w - 2, h - 2);
    ctx.restore();
  }
}
