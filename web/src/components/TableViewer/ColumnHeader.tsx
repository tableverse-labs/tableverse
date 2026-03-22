import { useEffect, useRef, useState } from "react";
import { useTableStore } from "../../stores/table";
import { useUiStore } from "../../stores/ui";
import { useViewStore } from "../../stores/view";
import { useStatsStore, getStatsKey } from "../../stores/stats";
import { DEFAULT_CELL_W, headerHeightForZoom } from "../../lib/viewport";
import { activePredicates } from "../../lib/addPredicate";
import { categoricalColor, nullRateColor, rdbu } from "../../lib/color-scales";
import { speculativeSort } from "../../lib/api";
import { buildDriftSparklinePoints } from "../../lib/profile-render";
import { classifyAlerts, drawAlertBadges } from "../../lib/layers/quality-alerts";
import { computeQualityScore, qualityScoreColor } from "../../lib/quality-score";

type Props = {
  width: number;
  leftOffset: number;
};

const FONT_BOLD = "bold 12px ui-sans-serif, sans-serif";
const FONT_BOLD_SM = "bold 11px ui-sans-serif, sans-serif";
const FONT_TYPE = "10px ui-monospace, monospace";
const FONT_MONO_SM = "9px ui-monospace, monospace";
const FONT_SMALL = "bold 9px ui-sans-serif, sans-serif";
const NULL_BAR_H = 3;
const SPARKLINE_HEIGHT = 20;

function cssVar(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

function headerColors() {
  return {
    bg: cssVar("--canvas-header-bg") || "#f9fafb",
    border: cssVar("--canvas-grid") || "#e5e7eb",
    text: cssVar("--canvas-text") || "#111827",
    textType: cssVar("--canvas-text-2") || "#6b7280",
    sort: cssVar("--canvas-sort-color") || "#3b82f6",
    filterDot: cssVar("--canvas-filter-dot") || "#f59e0b",
    filterBar: "#fbbf24",
    sparkline: cssVar("--canvas-sparkline") || "#93c5fd",
    drift: "#94a3b8",
  };
}

function dataTypeInfo(dt: string): { code: string; swatchIdx: number } {
  const d = dt.toLowerCase();
  if (d.includes("int") || d.includes("float") || d.includes("double") || d.includes("decimal")) {
    return { code: "N", swatchIdx: 4 };
  }
  if (d === "boolean" || d === "bool") return { code: "B", swatchIdx: 2 };
  if (d.includes("timestamp") || d.includes("date")) return { code: "D", swatchIdx: 0 };
  if (d.includes("utf8") || d.includes("varchar") || d === "string") return { code: "S", swatchIdx: 1 };
  return { code: "?", swatchIdx: 5 };
}

function drawNullRateBar(
  ctx: CanvasRenderingContext2D,
  x: number,
  cellW: number,
  headerH: number,
  nullRate: number,
  hasFilter: boolean,
): void {
  if (nullRate <= 0.01 || hasFilter) return;
  const [r, g, b] = nullRateColor(nullRate);
  const fillW = Math.max(2, Math.round(cellW * nullRate));
  ctx.globalAlpha = 0.85;
  ctx.fillStyle = `rgb(${r},${g},${b})`;
  ctx.fillRect(x, headerH - NULL_BAR_H, fillW, NULL_BAR_H);
  ctx.globalAlpha = 0.2;
  ctx.fillRect(x + fillW, headerH - NULL_BAR_H, cellW - fillW, NULL_BAR_H);
  ctx.globalAlpha = 1;
}

function drawSparkline(
  ctx: CanvasRenderingContext2D,
  histogram: Array<{ lo: number; hi: number; count: number }>,
  nullCount: number,
  totalCount: number,
  x: number,
  y: number,
  cellW: number,
  h: number,
  colors: ReturnType<typeof headerColors>,
) {
  const maxCount = Math.max(...histogram.map((b) => b.count));
  if (maxCount === 0) return;

  const padding = 2;
  const barAreaW = cellW - padding * 2;
  const barAreaH = h - padding;
  const nBars = histogram.length;
  const barW = Math.max(1, Math.floor(barAreaW / nBars) - 1);

  ctx.globalAlpha = 0.85;

  for (let i = 0; i < nBars; i++) {
    const bucket = histogram[i]!;
    const ratio = bucket.count / maxCount;
    const barH = Math.max(1, Math.round(ratio * barAreaH));
    const bx = x + padding + i * Math.floor(barAreaW / nBars);
    const by = y + barAreaH - barH;

    ctx.fillStyle = colors.sparkline;
    ctx.fillRect(bx, by, barW, barH);
  }

  if (nullCount > 0 && totalCount > 0) {
    const nullRatio = nullCount / totalCount;
    const nullBarH = Math.max(1, Math.round(nullRatio * barAreaH));
    ctx.fillStyle = "#ef4444";
    ctx.globalAlpha = 0.5;
    ctx.fillRect(x + cellW - padding - 3, y + barAreaH - nullBarH, 3, nullBarH);
  }

  ctx.globalAlpha = 1;
}

function drawQualityBadge(
  ctx: CanvasRenderingContext2D,
  score: number,
  x: number,
  y: number,
  isDark: boolean,
) {
  const [r, g, b] = qualityScoreColor(score);
  const label = String(score);
  const badgeW = 22;
  const badgeH = 13;
  const rx = 3;

  ctx.save();
  ctx.globalAlpha = 0.15;
  ctx.fillStyle = `rgb(${r},${g},${b})`;
  roundRect(ctx, x, y, badgeW, badgeH, rx);
  ctx.fill();

  ctx.globalAlpha = 1;
  ctx.strokeStyle = `rgb(${r},${g},${b})`;
  ctx.lineWidth = 1;
  roundRect(ctx, x, y, badgeW, badgeH, rx);
  ctx.stroke();

  ctx.font = "bold 8px ui-monospace, monospace";
  ctx.fillStyle = `rgb(${r},${g},${b})`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(label, x + badgeW / 2, y + badgeH / 2);
  ctx.textAlign = "left";
  ctx.restore();
}

function drawTypeBadge(
  ctx: CanvasRenderingContext2D,
  code: string,
  swatchIdx: number,
  x: number,
  y: number,
) {
  const [r, g, b] = categoricalColor(swatchIdx);
  const badgeW = 16;
  const badgeH = 12;

  ctx.save();
  ctx.globalAlpha = 0.18;
  ctx.fillStyle = `rgb(${r},${g},${b})`;
  roundRect(ctx, x, y, badgeW, badgeH, 2);
  ctx.fill();
  ctx.globalAlpha = 1;

  ctx.font = "bold 8px ui-monospace, monospace";
  ctx.fillStyle = `rgb(${r},${g},${b})`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(code, x + badgeW / 2, y + badgeH / 2);
  ctx.textAlign = "left";
  ctx.restore();
}

function drawInlineHistogram(
  ctx: CanvasRenderingContext2D,
  histogram: Array<{ lo: number; hi: number; count: number }>,
  nullCount: number,
  totalCount: number,
  x: number,
  y: number,
  w: number,
  h: number,
  color: string,
) {
  if (histogram.length === 0) return;
  const maxCount = Math.max(...histogram.map((b) => b.count));
  if (maxCount === 0) return;

  const nBars = histogram.length;
  const barW = Math.max(1, Math.floor(w / nBars));

  ctx.save();
  ctx.globalAlpha = 0.7;

  for (let i = 0; i < nBars; i++) {
    const bucket = histogram[i]!;
    const ratio = bucket.count / maxCount;
    const barH = Math.max(1, Math.round(ratio * h));
    const bx = x + i * barW;
    const by = y + h - barH;
    ctx.fillStyle = color;
    ctx.fillRect(bx, by, barW - 1, barH);
  }

  if (nullCount > 0 && totalCount > 0) {
    const nullRatio = nullCount / totalCount;
    const nullBarH = Math.max(1, Math.round(nullRatio * h));
    ctx.fillStyle = "#ef4444";
    ctx.globalAlpha = 0.55;
    ctx.fillRect(x + w - 3, y + h - nullBarH, 3, nullBarH);
  }

  ctx.restore();
}

function drawQuartileStrip(
  ctx: CanvasRenderingContext2D,
  quantiles: { p1: number; p25: number; p50: number; p75: number; p99: number },
  min: number,
  max: number,
  x: number,
  y: number,
  w: number,
  h: number,
  isDark: boolean,
) {
  const range = max - min;
  if (range <= 0) return;

  const toX = (v: number) => x + Math.max(0, Math.min(w, ((v - min) / range) * w));
  const p1x = toX(quantiles.p1);
  const p25x = toX(quantiles.p25);
  const p50x = toX(quantiles.p50);
  const p75x = toX(quantiles.p75);
  const p99x = toX(quantiles.p99);

  ctx.save();
  ctx.globalAlpha = 0.25;
  ctx.fillStyle = isDark ? "#60a5fa" : "#93c5fd";
  ctx.fillRect(x, y, w, h);

  ctx.globalAlpha = 0.45;
  ctx.fillStyle = isDark ? "#3b82f6" : "#60a5fa";
  ctx.fillRect(p25x, y, p75x - p25x, h);

  ctx.globalAlpha = 0.6;
  ctx.fillStyle = isDark ? "#1d4ed8" : "#3b82f6";
  ctx.fillRect(p1x, y, p99x - p1x, 2);
  ctx.fillRect(p1x, y + h - 2, p99x - p1x, 2);

  ctx.globalAlpha = 1;
  ctx.fillStyle = isDark ? "#eff6ff" : "#1e40af";
  ctx.fillRect(p50x - 1, y, 2, h);
  ctx.restore();
}

function roundRect(
  ctx: CanvasRenderingContext2D,
  x: number, y: number, w: number, h: number, r: number,
) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + r);
  ctx.lineTo(x + w, y + h - r);
  ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  ctx.lineTo(x + r, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
}

export function ColumnHeader({ width, leftOffset }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const source = useTableStore((s) => s.source);
  const viewport = useTableStore((s) => s.viewport);
  const ops = useViewStore((s) => s.ops);
  const setSort = useViewStore((s) => s.setSort);
  const zoom = useUiStore((s) => s.zoom);
  const isDark = useUiStore((s) => s.isDark);
  const setContextMenu = useUiStore((s) => s.setContextMenu);
  const setHoveredColumnIndex = useUiStore((s) => s.setHoveredColumnIndex);
  const incrementSortAccess = useUiStore((s) => s.incrementSortAccess);
  const pinnedCorrelationCol = useUiStore((s) => s.pinnedCorrelationCol);
  const setPinnedCorrelationCol = useUiStore((s) => s.setPinnedCorrelationCol);
  const activeLayers = useUiStore((s) => s.activeLayers);
  const showAlerts = activeLayers.has("quality_alerts");
  const sourceId = useViewStore((s) => s.sourceId);
  const allStats = useStatsStore((s) => s.stats);
  const fetchStats = useStatsStore((s) => s.fetchStats);
  const rowGroupStats = useStatsStore((s) => s.rowGroupStats);
  const correlations = useStatsStore((s) => s.correlations);

  const cellW = DEFAULT_CELL_W * zoom;
  const headerH = headerHeightForZoom(zoom);

  const activeJobId = useUiStore((s) => s.activeJobId);
  const [spinnerAngle, setSpinnerAngle] = useState(0);
  const rafRef = useRef<number | null>(null);

  useEffect(() => {
    if (!activeJobId) {
      if (rafRef.current !== null) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
      return;
    }
    const step = () => {
      setSpinnerAngle((a) => (a + 0.12) % (Math.PI * 2));
      rafRef.current = requestAnimationFrame(step);
    };
    rafRef.current = requestAnimationFrame(step);
    return () => {
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
    };
  }, [activeJobId]);

  const sortOp = ops.find((op) => op.type === "sort");
  const sortKeys = sortOp?.type === "sort" ? sortOp.keys : [];
  const activePreds = activePredicates(ops);
  const filteredColumns = new Set(activePreds.flatMap((p) => {
    if (p.op === "and" || p.op === "or" || p.op === "not") return [];
    return [p.column];
  }));

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !source) return;

    const dpr = window.devicePixelRatio || 1;
    canvas.width = width * dpr;
    canvas.height = headerH * dpr;
    canvas.style.width = `${width}px`;
    canvas.style.height = `${headerH}px`;

    const ctx = canvas.getContext("2d")!;
    ctx.scale(dpr, dpr);

    const colors = headerColors();

    ctx.fillStyle = colors.bg;
    ctx.fillRect(0, 0, width, headerH);

    const colStart = Math.floor(viewport.scrollX / cellW);
    const colEnd = Math.min(source.n_cols, Math.ceil((viewport.scrollX + width) / cellW) + 1);

    ctx.textBaseline = "middle";

    const pinnedColName = pinnedCorrelationCol !== null ? (source.columns[pinnedCorrelationCol]?.name ?? null) : null;
    const corrMatrix = correlations?.sourceId === source.id ? correlations.matrix : null;
    const corrColNames = corrMatrix ? corrMatrix.columns : [];

    for (let col = colStart; col < colEnd; col++) {
      const info = source.columns[col];
      if (!info) continue;
      const x = col * cellW - viewport.scrollX;

      ctx.fillStyle = colors.bg;
      ctx.fillRect(x, 0, cellW, headerH);

      ctx.strokeStyle = colors.border;
      ctx.lineWidth = 1;
      ctx.strokeRect(x, 0, cellW, headerH);

      const sortKey = sortKeys.find((k) => k.column === info.name);
      const hasFilter = filteredColumns.has(info.name);

      if (hasFilter) {
        ctx.fillStyle = colors.filterBar;
        ctx.fillRect(x, 0, cellW, 3);
      }

      const quickStat = source.quick_stats?.[col];
      const statsKey = getStatsKey(source.id, col);
      const colStats = allStats.get(statsKey);
      const nullRate = quickStat?.null_rate ?? 0;

      if (pinnedColName && corrMatrix && info.name !== pinnedColName) {
        const pinnedIdx = corrColNames.indexOf(pinnedColName);
        const thisIdx = corrColNames.indexOf(info.name);
        if (pinnedIdx >= 0 && thisIdx >= 0) {
          const r = corrMatrix.matrix[pinnedIdx]?.[thisIdx] ?? null;
          if (r !== null) {
            const t = (r + 1) / 2;
            const [cr, cg, cb] = rdbu(1 - t);
            ctx.globalAlpha = 0.25;
            ctx.fillStyle = `rgb(${cr},${cg},${cb})`;
            ctx.fillRect(x, 0, cellW, headerH - NULL_BAR_H);
            ctx.globalAlpha = 1;
          }
        }
      }

      if (zoom >= 1.00) {
        renderFullHeader(ctx, x, cellW, headerH, info, quickStat, colStats, sortKey, hasFilter, colors, showAlerts, isDark, activeJobId, spinnerAngle, statsKey, allStats, fetchStats, source.id, col, corrMatrix, corrColNames, pinnedColName);
      } else if (zoom >= 0.55) {
        renderScanHeader(ctx, x, cellW, headerH, info, quickStat, colStats, sortKey, hasFilter, colors, showAlerts, isDark, activeJobId, spinnerAngle, statsKey, allStats, fetchStats, source.id, col, corrMatrix, corrColNames, pinnedColName);
      } else if (zoom >= 0.28) {
        renderHeatmapHeader(ctx, x, cellW, headerH, info, quickStat, colStats, sortKey, hasFilter, colors, isDark);
      } else if (zoom >= 0.10) {
        renderProfileHeader(ctx, x, cellW, headerH, info, quickStat, colors, rowGroupStats, source.id, col, hasFilter);
      } else {
        renderSatelliteHeader(ctx, x, cellW, headerH, info, quickStat, hasFilter, colors);
      }
    }

    drawNullRateBar(ctx, 0, width, headerH, 0, false);

    ctx.strokeStyle = colors.border;
    ctx.lineWidth = 1;
    ctx.strokeRect(0, headerH - 1, width, 1);
  }, [width, source, viewport.scrollX, ops, zoom, allStats, rowGroupStats, correlations, pinnedCorrelationCol, isDark, activeJobId, spinnerAngle, showAlerts, activeLayers, headerH]);

  const colAtX = (clientX: number): { col: number; x: number } => {
    const canvas = canvasRef.current!;
    const rect = canvas.getBoundingClientRect();
    const offsetX = clientX - rect.left + viewport.scrollX;
    const col = Math.floor(offsetX / cellW);
    const x = col * cellW - viewport.scrollX + leftOffset;
    return { col, x };
  };

  const handleClick = (e: React.MouseEvent<HTMLCanvasElement>) => {
    if (!source) return;
    const { col } = colAtX(e.clientX);
    const info = source.columns[col];
    if (!info) return;

    if (e.altKey) {
      if (pinnedCorrelationCol === col) {
        setPinnedCorrelationCol(null);
      } else {
        setPinnedCorrelationCol(col);
      }
      return;
    }

    if (e.shiftKey) {
      const currentSort = ops.find((op) => op.type === "sort");
      const existing = currentSort?.type === "sort" ? currentSort.keys : [];
      const alreadyIdx = existing.findIndex((k) => k.column === info.name);
      if (alreadyIdx >= 0) {
        const updated = existing.map((k, i) =>
          i === alreadyIdx ? { ...k, descending: !k.descending } : k
        );
        setSort(updated);
      } else {
        setSort([...existing, { column: info.name, descending: false, nulls_last: true }]);
      }
      return;
    }

    const currentSort = ops.find((op) => op.type === "sort");
    const singleKey = currentSort?.type === "sort" && currentSort.keys.length === 1
      ? currentSort.keys[0]
      : null;

    if (singleKey?.column === info.name) {
      if (!singleKey.descending) {
        setSort([{ column: info.name, descending: true, nulls_last: true }]);
      } else {
        setSort([]);
      }
    } else {
      setSort([{ column: info.name, descending: false, nulls_last: true }]);
    }
  };

  const handleContextMenu = (e: React.MouseEvent<HTMLCanvasElement>) => {
    e.preventDefault();
    if (!source) return;
    const { col } = colAtX(e.clientX);
    const info = source.columns[col];
    if (!info) return;
    setContextMenu({ kind: "column", x: e.clientX, y: e.clientY, colIndex: col, colName: info.name });
  };

  const handleMouseMove = (e: React.MouseEvent<HTMLCanvasElement>) => {
    if (!source) return;
    const { col } = colAtX(e.clientX);
    if (col >= 0 && col < source.n_cols) {
      setHoveredColumnIndex(col);
    }
  };

  const handleMouseLeave = () => {
    setTimeout(() => {
      const { pinnedDistributionColIdx } = useUiStore.getState();
      if (pinnedDistributionColIdx === null) setHoveredColumnIndex(null);
    }, 200);
  };

  const handleMouseEnter = (e: React.MouseEvent<HTMLCanvasElement>) => {
    if (!source || !sourceId) return;
    const { col } = colAtX(e.clientX);
    const info = source.columns[col];
    if (!info) return;
    const count = incrementSortAccess(info.name);
    if (count >= 2) {
      const viewExpr = { source_id: sourceId, ops };
      speculativeSort(sourceId, viewExpr, info.name).catch(() => {});
    }
  };

  return (
    <canvas
      ref={canvasRef}
      onClick={handleClick}
      onContextMenu={handleContextMenu}
      onMouseMove={handleMouseMove}
      onMouseLeave={handleMouseLeave}
      onMouseEnter={handleMouseEnter}
      style={{ display: "block", cursor: "pointer" }}
    />
  );
}

function renderFullHeader(
  ctx: CanvasRenderingContext2D,
  x: number, cellW: number, headerH: number,
  info: import("../../lib/types").ColumnInfo,
  quickStat: import("../../lib/types").QuickColumnStats | undefined,
  colStats: import("../../lib/types").ColumnStats | undefined,
  sortKey: { descending: boolean } | undefined,
  hasFilter: boolean,
  colors: ReturnType<typeof headerColors>,
  showAlerts: boolean,
  isDark: boolean,
  activeJobId: string | null,
  spinnerAngle: number,
  statsKey: string,
  allStats: Map<string, import("../../lib/types").ColumnStats>,
  fetchStats: (sourceId: string, colIdx: number) => void,
  sourceId: string,
  col: number,
  corrMatrix: { columns: string[]; matrix: Array<Array<number | null>> } | null,
  corrColNames: string[],
  pinnedColName: string | null,
) {
  const { code, swatchIdx } = dataTypeInfo(info.data_type);
  const nullRate = quickStat?.null_rate ?? 0;

  drawNullRateBar(ctx, x, cellW, headerH, nullRate, hasFilter);

  ctx.font = FONT_BOLD;
  ctx.fillStyle = colors.text;
  ctx.fillText(info.name, x + 6, 16, cellW - 60);

  drawTypeBadge(ctx, code, swatchIdx, x + 6, 26);

  ctx.font = FONT_TYPE;
  ctx.fillStyle = colors.textType;
  ctx.fillText(info.data_type, x + 26, 32, cellW - 80);

  if (colStats) {
    const score = computeQualityScore(colStats);
    drawQualityBadge(ctx, score, x + cellW - 28, 4, isDark);
  }

  if (sortKey) {
    if (activeJobId) {
      ctx.strokeStyle = colors.sort;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.arc(x + cellW - 10, 16, 5, spinnerAngle, spinnerAngle + Math.PI * 1.4);
      ctx.stroke();
      ctx.lineWidth = 1;
    } else {
      ctx.fillStyle = colors.sort;
      ctx.font = FONT_BOLD;
      ctx.fillText(sortKey.descending ? "▼" : "▲", x + cellW - 18, 16);
    }
  }

  if (hasFilter) {
    ctx.fillStyle = colors.filterDot;
    ctx.beginPath();
    ctx.arc(x + cellW - 10, 32, 3, 0, Math.PI * 2);
    ctx.fill();
  }

  if (colStats?.distinct_count !== null && colStats?.distinct_count !== undefined) {
    const dc = colStats.distinct_count;
    const badge = dc >= 1_000_000 ? `${(dc / 1_000_000).toFixed(1)}M`
      : dc >= 1_000 ? `${(dc / 1_000).toFixed(1)}K`
      : dc === 1 ? "const"
      : dc === 2 ? "bin"
      : String(dc);
    ctx.font = FONT_MONO_SM;
    ctx.fillStyle = colors.textType;
    ctx.textAlign = "right";
    ctx.fillText(`${badge} uniq`, x + cellW - 4, 32);
    ctx.textAlign = "left";
  }

  if (colStats?.mean !== null && colStats?.mean !== undefined) {
    const meanStr = `μ=${formatNum(colStats.mean)}`;
    ctx.font = FONT_MONO_SM;
    ctx.fillStyle = colors.textType;
    ctx.fillText(meanStr, x + 6, 47, cellW - 12);
  }

  if (colStats?.skewness !== null && colStats?.skewness !== undefined) {
    const sk = colStats.skewness;
    const label = `skew ${sk > 0 ? "+" : ""}${sk.toFixed(1)}`;
    ctx.font = FONT_MONO_SM;
    ctx.fillStyle = Math.abs(sk) > 2 ? "#f59e0b" : colors.textType;
    ctx.textAlign = "right";
    ctx.fillText(label, x + cellW - 4, 47);
    ctx.textAlign = "left";
  }

  if (colStats?.histogram && colStats.histogram.length > 0) {
    const sparkY = headerH - SPARKLINE_HEIGHT - NULL_BAR_H;
    drawSparkline(ctx, colStats.histogram, colStats.null_count, colStats.count, x, sparkY, cellW, SPARKLINE_HEIGHT, colors);

    if (colStats.quantiles && colStats.min !== undefined && colStats.max !== undefined) {
      const q = colStats.quantiles;
      const minV = Number(colStats.min);
      const maxV = Number(colStats.max);
      if (isFinite(minV) && isFinite(maxV)) {
        drawQuartileStrip(ctx, q, minV, maxV, x + 2, sparkY - 6, cellW - 4, 4, isDark);
      }
    }
  } else if (!allStats.has(statsKey)) {
    fetchStats(sourceId, col);
  }

  if (showAlerts) {
    const alerts = classifyAlerts(info, quickStat, colStats);
    drawAlertBadges(ctx, alerts, x, cellW, headerH);
  }

  if (pinnedColName && corrMatrix && info.name !== pinnedColName) {
    const pinnedIdx = corrColNames.indexOf(pinnedColName);
    const thisIdx = corrColNames.indexOf(info.name);
    if (pinnedIdx >= 0 && thisIdx >= 0) {
      const r = corrMatrix.matrix[pinnedIdx]?.[thisIdx] ?? null;
      if (r !== null) {
        const label = `r=${r > 0 ? "+" : ""}${r.toFixed(2)}`;
        ctx.font = FONT_MONO_SM;
        ctx.fillStyle = r > 0.3 ? "#2563eb" : r < -0.3 ? "#dc2626" : colors.textType;
        ctx.textAlign = "right";
        ctx.fillText(label, x + cellW - 4, 16);
        ctx.textAlign = "left";
      }
    }
  }
}

function renderScanHeader(
  ctx: CanvasRenderingContext2D,
  x: number, cellW: number, headerH: number,
  info: import("../../lib/types").ColumnInfo,
  quickStat: import("../../lib/types").QuickColumnStats | undefined,
  colStats: import("../../lib/types").ColumnStats | undefined,
  sortKey: { descending: boolean } | undefined,
  hasFilter: boolean,
  colors: ReturnType<typeof headerColors>,
  showAlerts: boolean,
  isDark: boolean,
  activeJobId: string | null,
  spinnerAngle: number,
  statsKey: string,
  allStats: Map<string, import("../../lib/types").ColumnStats>,
  fetchStats: (sourceId: string, colIdx: number) => void,
  sourceId: string,
  col: number,
  corrMatrix: { columns: string[]; matrix: Array<Array<number | null>> } | null,
  corrColNames: string[],
  pinnedColName: string | null,
) {
  const { code, swatchIdx } = dataTypeInfo(info.data_type);
  const nullRate = quickStat?.null_rate ?? 0;

  drawNullRateBar(ctx, x, cellW, headerH, nullRate, hasFilter);

  ctx.font = FONT_BOLD;
  ctx.fillStyle = colors.text;
  ctx.fillText(info.name, x + 6, 16, cellW - 40);

  drawTypeBadge(ctx, code, swatchIdx, x + 6, 26);

  ctx.font = FONT_TYPE;
  ctx.fillStyle = colors.textType;
  ctx.fillText(info.data_type, x + 26, 32, cellW - 60);

  if (colStats) {
    const score = computeQualityScore(colStats);
    drawQualityBadge(ctx, score, x + cellW - 28, 4, isDark);
  }

  if (sortKey) {
    if (activeJobId) {
      ctx.strokeStyle = colors.sort;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.arc(x + cellW - 10, 16, 5, spinnerAngle, spinnerAngle + Math.PI * 1.4);
      ctx.stroke();
      ctx.lineWidth = 1;
    } else {
      ctx.fillStyle = colors.sort;
      ctx.font = FONT_BOLD;
      ctx.fillText(sortKey.descending ? "▼" : "▲", x + cellW - 18, 16);
    }
  }

  if (hasFilter) {
    ctx.fillStyle = colors.filterDot;
    ctx.beginPath();
    ctx.arc(x + cellW - 10, 32, 3, 0, Math.PI * 2);
    ctx.fill();
  }

  if (colStats?.histogram && colStats.histogram.length > 0) {
    const sparkY = headerH - SPARKLINE_HEIGHT - NULL_BAR_H;
    drawSparkline(ctx, colStats.histogram, colStats.null_count, colStats.count, x, sparkY, cellW, SPARKLINE_HEIGHT, colors);
  } else if (!allStats.has(statsKey)) {
    fetchStats(sourceId, col);
  }

  if (showAlerts) {
    const alerts = classifyAlerts(info, quickStat, colStats);
    drawAlertBadges(ctx, alerts, x, cellW, headerH);
  }

  if (pinnedColName && corrMatrix && info.name !== pinnedColName) {
    const pinnedIdx = corrColNames.indexOf(pinnedColName);
    const thisIdx = corrColNames.indexOf(info.name);
    if (pinnedIdx >= 0 && thisIdx >= 0) {
      const r = corrMatrix.matrix[pinnedIdx]?.[thisIdx] ?? null;
      if (r !== null) {
        const label = `r=${r > 0 ? "+" : ""}${r.toFixed(2)}`;
        ctx.font = FONT_MONO_SM;
        ctx.fillStyle = r > 0.3 ? "#2563eb" : r < -0.3 ? "#dc2626" : colors.textType;
        ctx.textAlign = "right";
        ctx.fillText(label, x + cellW - 4, 16);
        ctx.textAlign = "left";
      }
    }
  }
}

function renderHeatmapHeader(
  ctx: CanvasRenderingContext2D,
  x: number, cellW: number, headerH: number,
  info: { name: string; data_type: string },
  quickStat: { null_rate?: number } | undefined,
  colStats: import("../../lib/types").ColumnStats | undefined,
  sortKey: { descending: boolean } | undefined,
  hasFilter: boolean,
  colors: ReturnType<typeof headerColors>,
  isDark: boolean,
) {
  const { code, swatchIdx } = dataTypeInfo(info.data_type);
  const nullRate = quickStat?.null_rate ?? 0;
  const mid = headerH / 2;

  drawNullRateBar(ctx, x, cellW, headerH, nullRate, hasFilter);

  drawTypeBadge(ctx, code, swatchIdx, x + 3, mid - 8);

  const abbrevName = info.name.length > 10 ? info.name.slice(0, 9) + "…" : info.name;
  ctx.font = FONT_BOLD_SM;
  ctx.fillStyle = colors.text;
  ctx.fillText(abbrevName, x + 22, mid - 2, cellW - 50);

  if (nullRate > 0.05) {
    const pct = `${Math.round(nullRate * 100)}%N`;
    ctx.font = FONT_MONO_SM;
    ctx.fillStyle = "#ef4444";
    ctx.textAlign = "right";
    ctx.fillText(pct, x + cellW - 4, mid - 2);
    ctx.textAlign = "left";
  }

  if (colStats?.histogram && colStats.histogram.length > 0) {
    const histH = Math.floor(headerH * 0.35);
    const histY = headerH - histH - NULL_BAR_H - 2;
    drawInlineHistogram(ctx, colStats.histogram, colStats.null_count, colStats.count, x + 2, histY, cellW - 4, histH, colors.sparkline);
  }

  if (colStats) {
    const score = computeQualityScore(colStats);
    const [r, g, b] = qualityScoreColor(score);
    ctx.save();
    ctx.globalAlpha = 0.8;
    ctx.fillStyle = `rgb(${r},${g},${b})`;
    ctx.fillRect(x + cellW - 4, 4, 3, headerH - 8);
    ctx.restore();
  }

  if (sortKey) {
    ctx.fillStyle = colors.sort;
    ctx.font = FONT_SMALL;
    ctx.fillText(sortKey.descending ? "▼" : "▲", x + cellW - 14, mid - 2);
  }
}

function renderProfileHeader(
  ctx: CanvasRenderingContext2D,
  x: number, cellW: number, headerH: number,
  info: { name: string; data_type: string },
  quickStat: { null_rate?: number } | undefined,
  colors: ReturnType<typeof headerColors>,
  rowGroupStats: Map<string, import("../../lib/types").RowGroupStat[]>,
  sourceId: string,
  col: number,
  hasFilter: boolean,
) {
  const nullRate = quickStat?.null_rate ?? 0;
  drawNullRateBar(ctx, x, cellW, headerH, nullRate, hasFilter);

  const { code, swatchIdx } = dataTypeInfo(info.data_type);
  const [r, g, b] = categoricalColor(swatchIdx);
  const swatchW = Math.min(8, cellW * 0.3);

  ctx.globalAlpha = 0.8;
  ctx.fillStyle = `rgb(${r},${g},${b})`;
  ctx.fillRect(x + 2, headerH / 2 - 5, swatchW, 10);
  ctx.globalAlpha = 1;

  if (cellW > 20) {
    ctx.font = FONT_SMALL;
    ctx.fillStyle = colors.text;
    ctx.fillText(code, x + swatchW + 5, headerH / 2);
  }

  const rgKey = `${sourceId}:${col}`;
  const rgStats = rowGroupStats.get(rgKey);
  if (rgStats && rgStats.length >= 2 && cellW >= 30) {
    const sparkY = headerH - 14 - NULL_BAR_H;
    const sparkH = 10;
    const sparkX = x + 2;
    const sparkW = cellW - 4;
    const points = buildDriftSparklinePoints(rgStats, sparkX, sparkY, sparkW, sparkH);
    if (points && points.length >= 2) {
      const firstMean = rgStats[0]?.mean ?? null;
      const lastMean = rgStats[rgStats.length - 1]?.mean ?? null;
      const hasDrift = firstMean !== null && lastMean !== null && Math.abs(lastMean - firstMean) > 0;

      ctx.strokeStyle = hasDrift ? "#f59e0b" : colors.drift;
      ctx.lineWidth = 1;
      ctx.globalAlpha = 0.8;
      ctx.beginPath();
      ctx.moveTo(points[0]!.px, points[0]!.py);
      for (let i = 1; i < points.length; i++) {
        ctx.lineTo(points[i]!.px, points[i]!.py);
      }
      ctx.stroke();
      ctx.globalAlpha = 1;
    }
  }
}

function renderSatelliteHeader(
  ctx: CanvasRenderingContext2D,
  x: number, cellW: number, headerH: number,
  info: { name: string; data_type: string },
  quickStat: { null_rate?: number } | undefined,
  hasFilter: boolean,
  colors: ReturnType<typeof headerColors>,
) {
  const { swatchIdx } = dataTypeInfo(info.data_type);
  const [r, g, b] = categoricalColor(swatchIdx);
  ctx.globalAlpha = 0.7;
  ctx.fillStyle = `rgb(${r},${g},${b})`;
  ctx.fillRect(x, 0, cellW, headerH);
  ctx.globalAlpha = 1;

  drawNullRateBar(ctx, x, cellW, headerH, quickStat?.null_rate ?? 0, hasFilter);
}

function formatNum(v: number): string {
  if (Math.abs(v) >= 1_000_000) return `${(v / 1_000_000).toFixed(1)}M`;
  if (Math.abs(v) >= 1_000) return `${(v / 1_000).toFixed(1)}K`;
  if (Math.abs(v) < 0.01 && v !== 0) return v.toExponential(1);
  return v.toFixed(2);
}
