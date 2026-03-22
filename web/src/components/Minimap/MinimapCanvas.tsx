import { useRef, useEffect } from "react";
import { useTableStore } from "../../stores/table";
import { useUiStore } from "../../stores/ui";
import { useViewStore } from "../../stores/view";
import { useBookmarkStore } from "../../stores/bookmarkStore";
import { useMinimap } from "../../hooks/useMinimap";
import { DEFAULT_CELL_W, DEFAULT_CELL_H, scrollBounds } from "../../lib/viewport";
import { activeMinimapLayer, layerLabel, layerAccent } from "../../lib/minimap-render";

const LAYER_HEADER_H = 18;
const LEGEND_H = 14;

interface Props {
  panelW: number;
  panelH: number;
  onNavigate: (scrollX: number, scrollY: number) => void;
  onDrag: (scrollX: number, scrollY: number) => void;
  onBookmark: (scrollX: number, scrollY: number) => void;
}

export function MinimapCanvas({ panelW, panelH, onNavigate, onDrag, onBookmark }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const bitmapRef = useRef<ImageData | null>(null);
  const draggingRef = useRef(false);

  const source = useTableStore((s) => s.source);
  const viewport = useTableStore((s) => s.viewport);
  const zoom = useUiStore((s) => s.zoom);
  const isDark = useUiStore((s) => s.isDark);
  const activeLayers = useUiStore((s) => s.activeLayers);
  const virtualRowCount = useViewStore((s) => s.virtualRowCount);
  const bookmarks = useBookmarkStore((s) => s.bookmarks);

  const activeLayer = activeMinimapLayer(activeLayers);
  const heatmapH = panelH - (activeLayer ? LAYER_HEADER_H + LEGEND_H : 0);
  const heatmapOffsetY = activeLayer ? LAYER_HEADER_H : 0;

  const imageData = useMinimap(panelW, Math.max(1, heatmapH));

  useEffect(() => {
    bitmapRef.current = imageData;
    redraw();
  }, [imageData]);

  useEffect(() => {
    redraw();
  }, [viewport, zoom, bookmarks, isDark, activeLayers]);

  const getViewportBand = () => {
    if (!source) return { vpY: 0, vpH: heatmapH };
    const nRows = virtualRowCount ?? source.n_rows;
    const nCols = source.n_cols;
    const cellW = DEFAULT_CELL_W * zoom;
    const cellH = DEFAULT_CELL_H * zoom;
    const { maxY } = scrollBounds(nRows, nCols, cellW, cellH, viewport.width, viewport.height);
    const totalH = Math.max(1, nRows * cellH);
    const vpH = Math.max(8, Math.min(heatmapH, (viewport.height / totalH) * heatmapH));
    const vpY = maxY > 0 ? (viewport.scrollY / maxY) * (heatmapH - vpH) : 0;
    return { vpY, vpH };
  };

  const redraw = () => {
    const canvas = canvasRef.current;
    if (!canvas || !source) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    ctx.clearRect(0, 0, panelW, panelH);

    if (activeLayer) {
      const accent = layerAccent(activeLayer);
      const label = layerLabel(activeLayer);

      ctx.fillStyle = isDark ? "#111827" : "#f9fafb";
      ctx.fillRect(0, 0, panelW, LAYER_HEADER_H);
      ctx.fillStyle = accent;
      ctx.fillRect(0, 0, 3, LAYER_HEADER_H);

      ctx.font = "bold 8px ui-monospace, monospace";
      ctx.fillStyle = isDark ? "#d1d5db" : "#374151";
      ctx.textBaseline = "middle";
      ctx.fillText(label, 7, LAYER_HEADER_H / 2, panelW - 10);

      ctx.fillStyle = isDark ? "#1f2937" : "#e5e7eb";
      ctx.fillRect(0, LAYER_HEADER_H, panelW, 1);
    }

    if (bitmapRef.current) {
      ctx.putImageData(bitmapRef.current, 0, heatmapOffsetY);
    } else {
      ctx.fillStyle = isDark ? "#1a2438" : "#f1f5f9";
      ctx.fillRect(0, heatmapOffsetY, panelW, heatmapH);
    }

    const { vpY, vpH } = getViewportBand();
    const absVpY = vpY + heatmapOffsetY;

    ctx.fillStyle = isDark ? "rgba(10,18,36,0.72)" : "rgba(241,245,249,0.75)";
    if (absVpY > heatmapOffsetY) ctx.fillRect(0, heatmapOffsetY, panelW, vpY);
    if (absVpY + vpH < heatmapOffsetY + heatmapH) {
      ctx.fillRect(0, absVpY + vpH, panelW, heatmapH - vpY - vpH);
    }

    ctx.fillStyle = isDark ? "rgba(96,165,250,0.07)" : "rgba(59,130,246,0.05)";
    ctx.fillRect(0, absVpY, panelW, vpH);

    ctx.strokeStyle = isDark ? "rgba(96,165,250,0.9)" : "rgba(59,130,246,0.8)";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(0, absVpY + 1);
    ctx.lineTo(panelW, absVpY + 1);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(0, absVpY + vpH - 1);
    ctx.lineTo(panelW, absVpY + vpH - 1);
    ctx.stroke();

    if (vpH > 12) {
      const midY = Math.round(absVpY + vpH / 2);
      ctx.fillStyle = isDark ? "rgba(96,165,250,0.5)" : "rgba(59,130,246,0.45)";
      for (let d = -3; d <= 3; d += 3) {
        ctx.beginPath();
        ctx.arc(panelW / 2 + d * 3, midY, 1.5, 0, Math.PI * 2);
        ctx.fill();
      }
    }

    if (activeLayer) {
      const legendY = panelH - LEGEND_H;
      ctx.fillStyle = isDark ? "#111827" : "#f9fafb";
      ctx.fillRect(0, legendY, panelW, LEGEND_H);

      drawLayerLegend(ctx, activeLayer, 4, legendY + 2, panelW - 8, LEGEND_H - 4, isDark);
    }

    const nRows = virtualRowCount ?? source.n_rows;
    const nCols = source.n_cols;
    const cellW = DEFAULT_CELL_W * zoom;
    const cellH = DEFAULT_CELL_H * zoom;
    const { maxY } = scrollBounds(nRows, nCols, cellW, cellH, viewport.width, viewport.height);

    for (const bm of bookmarks) {
      const by = maxY > 0 ? heatmapOffsetY + (bm.scrollY / maxY) * (heatmapH - 8) : heatmapOffsetY;
      const s = 4;
      ctx.fillStyle = bm.color;
      ctx.globalAlpha = 0.9;
      ctx.beginPath();
      ctx.moveTo(6, by - s);
      ctx.lineTo(6 + s, by);
      ctx.lineTo(6, by + s);
      ctx.lineTo(6 - s, by);
      ctx.closePath();
      ctx.fill();
    }
    ctx.globalAlpha = 1;
  };

  const toScrollY = (offsetY: number): number => {
    if (!source) return viewport.scrollY;
    const nRows = virtualRowCount ?? source.n_rows;
    const nCols = source.n_cols;
    const cellW = DEFAULT_CELL_W * zoom;
    const cellH = DEFAULT_CELL_H * zoom;
    const { maxY } = scrollBounds(nRows, nCols, cellW, cellH, viewport.width, viewport.height);
    const { vpH } = getViewportBand();
    const relY = Math.max(0, offsetY - heatmapOffsetY);
    return Math.max(0, Math.min(maxY, (relY / Math.max(1, heatmapH - vpH)) * maxY));
  };

  const handlePointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    e.preventDefault();
    const { offsetY } = e.nativeEvent;
    if (offsetY < heatmapOffsetY) return;
    if (e.ctrlKey) {
      const scrollY = toScrollY(offsetY);
      onBookmark(viewport.scrollX, scrollY);
      return;
    }
    draggingRef.current = true;
    (e.currentTarget as HTMLCanvasElement).setPointerCapture(e.pointerId);
    onNavigate(viewport.scrollX, toScrollY(offsetY));
  };

  const handlePointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!draggingRef.current) return;
    onDrag(viewport.scrollX, toScrollY(e.nativeEvent.offsetY));
  };

  const handlePointerUp = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (draggingRef.current) {
      draggingRef.current = false;
      (e.currentTarget as HTMLCanvasElement).releasePointerCapture(e.pointerId);
    }
  };

  return (
    <canvas
      ref={canvasRef}
      width={panelW}
      height={panelH}
      style={{ display: "block", cursor: "ns-resize" }}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
    />
  );
}

function drawLayerLegend(
  ctx: CanvasRenderingContext2D,
  layer: string,
  x: number,
  y: number,
  w: number,
  h: number,
  isDark: boolean,
): void {
  const gradients: Record<string, [string, string]> = {
    null_map: ["#dcfce7", "#ef4444"],
    completeness: ["#ef4444", "#22c55e"],
    distribution: ["#440154", "#fde725"],
    outlier: ["#fef3c7", "#d97706"],
    quality_alerts: ["#dc2626", "#10b981"],
    class_balance: ["#ecfdf5", "#db2777"],
  };

  const [from, to] = gradients[layer] ?? ["#e5e7eb", "#374151"];
  const grad = ctx.createLinearGradient(x, y, x + w, y);
  grad.addColorStop(0, from);
  grad.addColorStop(1, to);

  ctx.save();
  ctx.fillStyle = grad;
  ctx.fillRect(x, y, w, h);
  ctx.strokeStyle = isDark ? "#374151" : "#d1d5db";
  ctx.lineWidth = 0.5;
  ctx.strokeRect(x, y, w, h);
  ctx.restore();
}
