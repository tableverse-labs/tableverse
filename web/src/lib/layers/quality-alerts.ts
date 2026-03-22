import type { ColumnInfo, ColumnStats, QuickColumnStats } from "../types";
import { classifyDataType } from "../semantic-render";

export type AlertKind =
  | "constant"
  | "high_null"
  | "skewed"
  | "infinite"
  | "zeros"
  | "high_cardinality"
  | "low_cardinality_numeric";

export type ColumnAlert = {
  kind: AlertKind;
  color: string;
  label: string;
};

const ALERT_DEFS: Record<AlertKind, { color: string; label: string }> = {
  constant:             { color: "#94a3b8", label: "=" },
  high_null:            { color: "#ef4444", label: "N" },
  skewed:               { color: "#f59e0b", label: "~" },
  infinite:             { color: "#a855f7", label: "∞" },
  zeros:                { color: "#eab308", label: "0" },
  high_cardinality:     { color: "#3b82f6", label: "ID" },
  low_cardinality_numeric: { color: "#14b8a6", label: "Q" },
};

export function classifyAlerts(
  colInfo: ColumnInfo,
  qStats: QuickColumnStats | undefined,
  fullStats: ColumnStats | undefined,
): ColumnAlert[] {
  const alerts: ColumnAlert[] = [];
  const dt = classifyDataType(colInfo.data_type);
  const nullRate = qStats?.null_rate ?? fullStats?.null_rate ?? 0;
  const cardinality = fullStats?.cardinality_category;

  if (cardinality === "constant" || fullStats?.distinct_count === 1) {
    alerts.push({ kind: "constant", ...ALERT_DEFS.constant });
  }

  if (nullRate > 0.5) {
    alerts.push({ kind: "high_null", ...ALERT_DEFS.high_null });
  }

  if (
    fullStats?.skewness !== null &&
    fullStats?.skewness !== undefined &&
    Math.abs(fullStats.skewness) > 2
  ) {
    alerts.push({ kind: "skewed", ...ALERT_DEFS.skewed });
  }

  if (fullStats?.infinite_count !== null && fullStats?.infinite_count !== undefined && fullStats.infinite_count > 0) {
    alerts.push({ kind: "infinite", ...ALERT_DEFS.infinite });
  }

  if (
    dt === "numeric" &&
    fullStats?.zero_count !== null &&
    fullStats?.zero_count !== undefined &&
    fullStats.count > 0 &&
    fullStats.zero_count / fullStats.count > 0.5
  ) {
    alerts.push({ kind: "zeros", ...ALERT_DEFS.zeros });
  }

  if (
    dt === "string" &&
    (cardinality === "high_cardinality" || cardinality === "unique")
  ) {
    alerts.push({ kind: "high_cardinality", ...ALERT_DEFS.high_cardinality });
  }

  if (
    dt === "numeric" &&
    (cardinality === "constant" || cardinality === "binary" || cardinality === "low_cardinality") &&
    (fullStats?.distinct_count ?? Infinity) <= 5
  ) {
    alerts.push({ kind: "low_cardinality_numeric", ...ALERT_DEFS.low_cardinality_numeric });
  }

  return alerts;
}

export function drawAlertBadges(
  ctx: CanvasRenderingContext2D,
  alerts: ColumnAlert[],
  x: number,
  cellW: number,
  headerHeight: number,
): void {
  if (alerts.length === 0) return;

  const dotR = 3;
  const spacing = 9;
  const startX = x + cellW - dotR - 3;
  const dotY = headerHeight - 10;

  ctx.save();
  for (let i = 0; i < Math.min(alerts.length, 5); i++) {
    const alert = alerts[i]!;
    const cx = startX - i * spacing;
    ctx.globalAlpha = 0.9;
    ctx.fillStyle = alert.color;
    ctx.beginPath();
    ctx.arc(cx, dotY, dotR, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
}
