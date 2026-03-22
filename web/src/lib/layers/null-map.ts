export function renderNullMapCell(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  isNull: boolean,
  nullRate: number,
): void {
  if (isNull) {
    ctx.save();
    ctx.globalAlpha = 0.28;
    ctx.fillStyle = "#ef4444";
    ctx.fillRect(x + 1, y + 1, w - 2, h - 2);
    ctx.restore();
    return;
  }

  if (nullRate > 0.3) {
    ctx.save();
    ctx.globalAlpha = nullRate * 0.07;
    ctx.fillStyle = "#ef4444";
    ctx.fillRect(x + 1, y + 1, w - 2, h - 2);
    ctx.restore();
  }
}
