import type { ColumnStats } from "./types";

export function computeQualityScore(stats: ColumnStats): number {
  const completeness = stats.completeness_score ?? (1 - (stats.null_rate ?? 0));
  const nonConstant = stats.cardinality_category === "constant" ? 0 : 1;
  const skewness = stats.skewness ?? 0;
  const skewPenalty = Math.min(1, Math.abs(skewness) / 6);
  const outlierPenalty = Math.min(1, (stats.outlier_pct ?? 0) * 5);
  const infinitePenalty = stats.infinite_count && stats.count > 0
    ? Math.min(1, stats.infinite_count / stats.count)
    : 0;

  const raw =
    completeness * 0.40 +
    nonConstant * 0.20 +
    (1 - skewPenalty) * 0.15 +
    (1 - outlierPenalty) * 0.15 +
    (1 - infinitePenalty) * 0.10;

  return Math.round(Math.max(0, Math.min(1, raw)) * 100);
}

export function qualityScoreColor(score: number): [number, number, number] {
  if (score >= 80) return [16, 185, 129];
  if (score >= 60) return [245, 158, 11];
  return [239, 68, 68];
}
