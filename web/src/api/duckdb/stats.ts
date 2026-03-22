import type { AsyncDuckDBConnection } from "@duckdb/duckdb-wasm";
import type { CardinalityCategory, ColumnInfo, ColumnStats, RowGroupStat } from "../../lib/types";
import { buildReaderExpr, quoteIdent } from "./sql-builder";

type Row = Record<string, unknown>;
type DuckTable = { numRows: number; get(i: number): Row | null };

const q = quoteIdent;

async function run(conn: AsyncDuckDBConnection, sql: string): Promise<DuckTable> {
  return (await conn.query(sql)) as unknown as DuckTable;
}

function cardinalityCategory(distinctCount: number, totalCount: number): CardinalityCategory {
  if (totalCount === 0 || distinctCount === 0) return "unknown";
  if (distinctCount === 1) return "constant";
  if (distinctCount === 2) return "binary";
  const ratio = distinctCount / totalCount;
  if (ratio >= 0.95) return "unique";
  if (distinctCount <= 10) return "low_cardinality";
  if (distinctCount <= 100) return "categorical";
  if (ratio >= 0.5) return "high_cardinality";
  return "categorical";
}

function mapDataType(duckType: string): string {
  const t = duckType.toUpperCase();
  if (/INT|HUGEINT/.test(t)) return "integer";
  if (/FLOAT|DOUBLE|DECIMAL|NUMERIC/.test(t)) return "float";
  if (/BOOL/.test(t)) return "boolean";
  if (/DATE/.test(t)) return "date";
  if (/TIMESTAMP/.test(t)) return "timestamp";
  if (/VARCHAR|TEXT|CHAR/.test(t)) return "string";
  if (/BLOB|BINARY/.test(t)) return "binary";
  if (/LIST|ARRAY/.test(t)) return "list";
  if (/STRUCT|MAP/.test(t)) return "struct";
  return "string";
}

function isNumericType(dataType: string): boolean {
  return /int|float|double|decimal|numeric/i.test(dataType);
}

function isStringType(dataType: string): boolean {
  return /varchar|text|char/i.test(dataType);
}

export async function computeColumnStats(
  conn: AsyncDuckDBConnection,
  filename: string,
  colInfo: ColumnInfo,
  nRows: number,
  bins: number,
  format = "parquet"
): Promise<ColumnStats> {
  const col = q(colInfo.name);
  const reader = buildReaderExpr(filename, format);
  const isNumeric = isNumericType(colInfo.data_type);
  const isString = isStringType(colInfo.data_type);

  const numericCast = `TRY_CAST(${col} AS DOUBLE)`;
  const basicSql = `
    SELECT
      COUNT(*) AS total,
      COUNT(${col}) AS non_null,
      COUNT(*) - COUNT(${col}) AS null_count,
      ${isNumeric ? `MIN(${numericCast})` : `MIN(CAST(${col} AS VARCHAR))`} AS min_val,
      ${isNumeric ? `MAX(${numericCast})` : `MAX(CAST(${col} AS VARCHAR))`} AS max_val,
      ${isNumeric ? `AVG(${numericCast})` : "NULL"} AS mean_val,
      APPROX_COUNT_DISTINCT(${col}) AS dist_count
    FROM ${reader}
  `;

  const basicResult = await run(conn, basicSql);
  const row = basicResult.get(0);
  if (!row) return emptyStats(colInfo, nRows);

  const total = Number(row["total"] ?? 0);
  const nullCount = Number(row["null_count"] ?? 0);
  const nonNull = total - nullCount;
  const nullRate = total > 0 ? nullCount / total : 0;
  const minVal = row["min_val"] ?? null;
  const maxVal = row["max_val"] ?? null;
  const meanVal = row["mean_val"] != null ? Number(row["mean_val"]) : null;
  const distCount = Number(row["dist_count"] ?? 0);

  let histogram: Array<{ lo: number; hi: number; count: number }> | null = null;
  let quantiles = null;
  let skewness: number | null = null;
  let kurtosis: number | null = null;
  let zeroCount: number | null = null;
  let infiniteCount: number | null = null;
  let outlierPct: number | null = null;

  if (isNumeric && minVal !== null && maxVal !== null && Number(minVal) !== Number(maxVal)) {
    const mn = Number(minVal);
    const mx = Number(maxVal);
    const binWidth = (mx - mn) / bins;

    const histResult = await run(conn, `
      SELECT
        LEAST(FLOOR((${numericCast} - ${mn}) / ${binWidth}), ${bins - 1}) AS bin_idx,
        COUNT(*) AS cnt
      FROM ${reader}
      WHERE ${col} IS NOT NULL
        AND ${numericCast} >= ${mn}
        AND ${numericCast} <= ${mx}
      GROUP BY bin_idx
      ORDER BY bin_idx
    `);

    histogram = [];
    for (let i = 0; i < histResult.numRows; i++) {
      const hrow = histResult.get(i);
      if (!hrow) continue;
      const idx = Math.min(Number(hrow["bin_idx"] ?? 0), bins - 1);
      histogram.push({ lo: mn + idx * binWidth, hi: mn + (idx + 1) * binWidth, count: Number(hrow["cnt"] ?? 0) });
    }

    const qResult = await run(conn, `
      SELECT
        PERCENTILE_CONT(0.01) WITHIN GROUP (ORDER BY ${numericCast}) AS p1,
        PERCENTILE_CONT(0.05) WITHIN GROUP (ORDER BY ${numericCast}) AS p5,
        PERCENTILE_CONT(0.25) WITHIN GROUP (ORDER BY ${numericCast}) AS p25,
        PERCENTILE_CONT(0.50) WITHIN GROUP (ORDER BY ${numericCast}) AS p50,
        PERCENTILE_CONT(0.75) WITHIN GROUP (ORDER BY ${numericCast}) AS p75,
        PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY ${numericCast}) AS p95,
        PERCENTILE_CONT(0.99) WITHIN GROUP (ORDER BY ${numericCast}) AS p99
      FROM ${reader}
      WHERE ${col} IS NOT NULL
    `);

    const qrow = qResult.get(0);
    if (qrow) {
      quantiles = {
        p1: Number(qrow["p1"] ?? 0),
        p5: Number(qrow["p5"] ?? 0),
        p25: Number(qrow["p25"] ?? 0),
        p50: Number(qrow["p50"] ?? 0),
        p75: Number(qrow["p75"] ?? 0),
        p95: Number(qrow["p95"] ?? 0),
        p99: Number(qrow["p99"] ?? 0),
      };

      if (histogram && quantiles) {
        const outlierBuckets = histogram.filter((b) => b.hi < quantiles!.p1 || b.lo > quantiles!.p99);
        const outlierCount = outlierBuckets.reduce((s, b) => s + b.count, 0);
        outlierPct = nonNull > 0 ? outlierCount / nonNull : 0;
      }
    }

    const momentResult = await run(conn, `
      SELECT
        SKEWNESS(${numericCast}) AS skew,
        KURTOSIS(${numericCast}) AS kurt,
        COUNT(*) FILTER (WHERE ${numericCast} = 0) AS zeros,
        COUNT(*) FILTER (WHERE isinf(${numericCast})) AS infs
      FROM ${reader}
      WHERE ${col} IS NOT NULL
    `);

    const mrow = momentResult.get(0);
    if (mrow) {
      skewness = mrow["skew"] != null ? Number(mrow["skew"]) : null;
      kurtosis = mrow["kurt"] != null ? Number(mrow["kurt"]) : null;
      zeroCount = Number(mrow["zeros"] ?? 0);
      infiniteCount = Number(mrow["infs"] ?? 0);
    }
  }

  let topValues = null;
  if (isString || distCount <= 200) {
    const tvResult = await run(conn, `
      SELECT CAST(${col} AS VARCHAR) AS val, COUNT(*) AS cnt
      FROM ${reader}
      WHERE ${col} IS NOT NULL
      GROUP BY val
      ORDER BY cnt DESC
      LIMIT 20
    `);
    topValues = [];
    for (let i = 0; i < tvResult.numRows; i++) {
      const tvrow = tvResult.get(i);
      if (!tvrow) continue;
      topValues.push({
        value: tvrow["val"],
        count: Number(tvrow["cnt"] ?? 0),
        rate: total > 0 ? Number(tvrow["cnt"] ?? 0) / total : 0,
      });
    }
  }

  const completenessScore = 1 - nullRate;
  let classImbalanceRatio: number | null = null;
  if (topValues && topValues.length >= 2) {
    const maxCount = topValues[0]!.count;
    const minCount = topValues[topValues.length - 1]!.count;
    classImbalanceRatio = minCount > 0 ? maxCount / minCount : null;
  }

  return {
    column: colInfo.name,
    index: colInfo.index,
    data_type: mapDataType(colInfo.data_type),
    count: total,
    null_count: nullCount,
    null_rate: nullRate,
    distinct_count: distCount,
    min: minVal,
    max: maxVal,
    mean: meanVal,
    quantiles,
    histogram,
    top_values: topValues,
    cardinality_category: cardinalityCategory(distCount, total),
    skewness,
    kurtosis,
    zero_count: zeroCount,
    infinite_count: infiniteCount,
    outlier_pct: outlierPct,
    completeness_score: completenessScore,
    class_imbalance_ratio: classImbalanceRatio,
  };
}

function emptyStats(colInfo: ColumnInfo, nRows: number): ColumnStats {
  return {
    column: colInfo.name,
    index: colInfo.index,
    data_type: mapDataType(colInfo.data_type),
    count: nRows,
    null_count: 0,
    null_rate: 0,
    distinct_count: null,
    min: null,
    max: null,
    mean: null,
    quantiles: null,
    histogram: null,
    top_values: null,
    cardinality_category: "unknown",
    skewness: null,
    kurtosis: null,
    zero_count: null,
    infinite_count: null,
    outlier_pct: null,
    completeness_score: 1,
    class_imbalance_ratio: null,
  };
}

export async function computeRowGroupStats(
  conn: AsyncDuckDBConnection,
  filename: string,
  colInfo: ColumnInfo,
  format = "parquet"
): Promise<RowGroupStat[]> {
  if (format !== "parquet") return [];

  const isNumeric = isNumericType(colInfo.data_type);
  const escapedFile = filename.replace(/'/g, "''");
  const escapedCol = colInfo.name.replace(/'/g, "''");

  try {
    const metaResult = await run(conn, `
      SELECT
        row_group_id,
        row_group_num_rows,
        stats_null_count,
        stats_min_value,
        stats_max_value
      FROM parquet_metadata('${escapedFile}')
      WHERE path_in_schema = '${escapedCol}'
      ORDER BY row_group_id
    `);

    const stats: RowGroupStat[] = [];
    let rowOffset = 0;

    for (let i = 0; i < metaResult.numRows; i++) {
      const row = metaResult.get(i);
      if (!row) continue;
      const rowCount = Number(row["row_group_num_rows"] ?? 0);
      const nullCount = Number(row["stats_null_count"] ?? 0);
      const minRaw = row["stats_min_value"];
      const maxRaw = row["stats_max_value"];
      const minN = isNumeric && minRaw != null ? Number(minRaw) : null;
      const maxN = isNumeric && maxRaw != null ? Number(maxRaw) : null;
      const mean = minN !== null && maxN !== null ? (minN + maxN) / 2 : null;

      stats.push({
        rg_index: Number(row["row_group_id"] ?? i),
        row_offset: rowOffset,
        row_count: rowCount,
        null_count: nullCount,
        min: minN,
        max: maxN,
        mean,
      });

      rowOffset += rowCount;
    }

    return stats;
  } catch {
    return [];
  }
}

export async function computeCorrelations(
  conn: AsyncDuckDBConnection,
  filename: string,
  numericColumns: ColumnInfo[],
  format = "parquet"
): Promise<{ columns: string[]; matrix: Array<Array<number | null>> }> {
  if (numericColumns.length === 0) return { columns: [], matrix: [] };

  const reader = buildReaderExpr(filename, format);
  const cols = numericColumns.map((c) => c.name);
  const matrix: Array<Array<number | null>> = cols.map(() => cols.map(() => null));

  for (let i = 0; i < cols.length; i++) {
    matrix[i]![i] = 1;
    for (let j = i + 1; j < cols.length; j++) {
      try {
        const result = await run(conn, `
          SELECT CORR(TRY_CAST(${q(cols[i]!)} AS DOUBLE), TRY_CAST(${q(cols[j]!)} AS DOUBLE)) AS r
          FROM ${reader}
        `);
        const row = result.get(0);
        const r = row?.["r"] != null ? Number(row["r"]) : null;
        matrix[i]![j] = r;
        matrix[j]![i] = r;
      } catch {
        matrix[i]![j] = null;
        matrix[j]![i] = null;
      }
    }
  }

  return { columns: cols, matrix };
}
