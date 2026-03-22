import type { AggExpr, Predicate, ScalarExpr, SortKey, ViewExpr, ViewOp } from "../../lib/viewExpr";
import type { Literal } from "../../lib/viewExpr";

function q(ident: string): string {
  return `"${ident.replace(/"/g, '""')}"`;
}

function litSql(value: Literal): string {
  if (value === null) return "NULL";
  if (typeof value === "boolean") return value ? "TRUE" : "FALSE";
  if (typeof value === "number") return String(value);
  return `'${value.replace(/'/g, "''")}'`;
}

function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, "\\$&");
}

function predSql(pred: Predicate): string {
  switch (pred.op) {
    case "eq": return `${q(pred.column)} = ${litSql(pred.value)}`;
    case "ne": return `${q(pred.column)} != ${litSql(pred.value)}`;
    case "gt": return `${q(pred.column)} > ${litSql(pred.value)}`;
    case "gte": return `${q(pred.column)} >= ${litSql(pred.value)}`;
    case "lt": return `${q(pred.column)} < ${litSql(pred.value)}`;
    case "lte": return `${q(pred.column)} <= ${litSql(pred.value)}`;
    case "between": return `${q(pred.column)} BETWEEN ${litSql(pred.lo)} AND ${litSql(pred.hi)}`;
    case "in": return `${q(pred.column)} IN (${pred.values.map(litSql).join(", ")})`;
    case "not_in": return `${q(pred.column)} NOT IN (${pred.values.map(litSql).join(", ")})`;
    case "contains": return `${q(pred.column)} LIKE '%${escapeLike(pred.value)}%' ESCAPE '\\'`;
    case "starts_with": return `${q(pred.column)} LIKE '${escapeLike(pred.value)}%' ESCAPE '\\'`;
    case "ends_with": return `${q(pred.column)} LIKE '%${escapeLike(pred.value)}' ESCAPE '\\'`;
    case "regex": return `regexp_like(${q(pred.column)}, '${pred.pattern.replace(/'/g, "''")}')`;
    case "is_null": return `${q(pred.column)} IS NULL`;
    case "is_not_null": return `${q(pred.column)} IS NOT NULL`;
    case "and": return `(${pred.exprs.map(predSql).join(" AND ")})`;
    case "or": return `(${pred.exprs.map(predSql).join(" OR ")})`;
    case "not": return `NOT (${predSql(pred.expr)})`;
  }
}

const BIN_OPS: Record<string, string> = {
  add: "+", sub: "-", mul: "*", div: "/", mod: "%",
};

const DATA_TYPES: Record<string, string> = {
  int32: "INTEGER", int64: "BIGINT",
  float32: "FLOAT", float64: "DOUBLE",
  text: "VARCHAR", boolean: "BOOLEAN",
  date: "DATE", timestamp: "TIMESTAMP",
};

function scalarSql(expr: ScalarExpr): string {
  switch (expr.kind) {
    case "column": return q(expr.name);
    case "literal": return litSql(expr.value);
    case "bin_op": return `(${scalarSql(expr.left)} ${BIN_OPS[expr.op] ?? "+"} ${scalarSql(expr.right)})`;
    case "abs": return `ABS(${scalarSql(expr[0])})`;
    case "round": return `ROUND(${scalarSql(expr.expr)}, ${expr.decimals})`;
    case "floor": return `FLOOR(${scalarSql(expr[0])})`;
    case "ceil": return `CEIL(${scalarSql(expr[0])})`;
    case "upper": return `UPPER(${scalarSql(expr[0])})`;
    case "lower": return `LOWER(${scalarSql(expr[0])})`;
    case "trim": return `TRIM(${scalarSql(expr[0])})`;
    case "length": return `LENGTH(${scalarSql(expr[0])})`;
    case "substr":
      return expr.len !== null
        ? `SUBSTRING(${scalarSql(expr.expr)}, ${expr.start + 1}, ${expr.len})`
        : `SUBSTRING(${scalarSql(expr.expr)}, ${expr.start + 1})`;
    case "concat": return `CONCAT(${expr.parts.map(scalarSql).join(", ")})`;
    case "year": return `YEAR(${scalarSql(expr[0])})`;
    case "month": return `MONTH(${scalarSql(expr[0])})`;
    case "day": return `DAY(${scalarSql(expr[0])})`;
    case "coalesce": return `COALESCE(${expr.exprs.map(scalarSql).join(", ")})`;
    case "cast": return `CAST(${scalarSql(expr.expr)} AS ${DATA_TYPES[expr.to_type] ?? "VARCHAR"})`;
    case "case": {
      const whens = expr.whens
        .map(([p, e]) => `WHEN ${predSql(p)} THEN ${scalarSql(e)}`)
        .join(" ");
      const elseClause = expr.else_expr !== null ? ` ELSE ${scalarSql(expr.else_expr)}` : "";
      return `CASE ${whens}${elseClause} END`;
    }
    case "rank":
      return `ROW_NUMBER() OVER (ORDER BY ${sortKeysSql(expr.order)})`;
    case "n_tile":
      return `NTILE(${expr.n}) OVER ()`;
  }
}

function sortKeysSql(keys: SortKey[]): string {
  return keys
    .map((k) => `${q(k.column)} ${k.descending ? "DESC" : "ASC"} NULLS ${k.nulls_last ? "LAST" : "FIRST"}`)
    .join(", ");
}

function aggExprSql(agg: AggExpr): string {
  switch (agg.fn) {
    case "count": return `COUNT(*) AS ${q(agg.alias)}`;
    case "count_distinct": return `COUNT(DISTINCT ${q(agg.column)}) AS ${q(agg.alias)}`;
    case "sum": return `SUM(${q(agg.column)}) AS ${q(agg.alias)}`;
    case "min": return `MIN(${q(agg.column)}) AS ${q(agg.alias)}`;
    case "max": return `MAX(${q(agg.column)}) AS ${q(agg.alias)}`;
    case "mean": return `AVG(${q(agg.column)}) AS ${q(agg.alias)}`;
    case "median": return `MEDIAN(${q(agg.column)}) AS ${q(agg.alias)}`;
    case "std_dev": return `STDDEV_SAMP(${q(agg.column)}) AS ${q(agg.alias)}`;
    case "percentile":
      return `PERCENTILE_CONT(${agg.p}) WITHIN GROUP (ORDER BY ${q(agg.column)}) AS ${q(agg.alias)}`;
  }
}

function applyOp(inner: string, op: ViewOp): string {
  switch (op.type) {
    case "filter":
      return `SELECT * FROM (${inner}) WHERE ${predSql(op.predicate)}`;
    case "select":
      return `SELECT ${op.columns.map(q).join(", ")} FROM (${inner})`;
    case "drop":
      return `SELECT * EXCLUDE (${op.columns.map(q).join(", ")}) FROM (${inner})`;
    case "sort":
      return `SELECT * FROM (${inner}) ORDER BY ${sortKeysSql(op.keys)}`;
    case "derive":
      return `SELECT *, ${scalarSql(op.expr)} AS ${q(op.name)} FROM (${inner})`;
    case "deduplicate":
      return op.columns
        ? `SELECT * FROM (SELECT *, ROW_NUMBER() OVER (PARTITION BY ${op.columns.map(q).join(", ")}) AS __tv_rn__ FROM (${inner})) WHERE __tv_rn__ = 1`
        : `SELECT DISTINCT * FROM (${inner})`;
    case "sample": {
      const method = op.strategy === "bernoulli" ? "bernoulli" : "system";
      const seed = op.seed !== null ? ` REPEATABLE (${op.seed})` : "";
      return `SELECT * FROM (${inner}) USING SAMPLE ${method}(${op.n} ROWS)${seed}`;
    }
    case "group_by":
      return `SELECT ${[...op.keys.map(q), ...op.aggs.map(aggExprSql)].join(", ")} FROM (${inner}) GROUP BY ${op.keys.map(q).join(", ")}`;
    case "rename":
      return `SELECT * RENAME (${op.mappings.map(([from, to]) => `${q(from)} AS ${q(to)}`).join(", ")}) FROM (${inner})`;
    case "limit":
      return `SELECT * FROM (${inner}) LIMIT ${op.n}`;
    default: {
      const _exhaustive: never = op;
      void _exhaustive;
      return inner;
    }
  }
}

export function buildReaderExpr(filename: string, format: string): string {
  const f = filename.replace(/'/g, "''");
  if (format === "csv") return `read_csv_auto('${f}')`;
  if (format === "json") return `read_json_auto('${f}')`;
  if (format === "arrow") return `read_arrow('${f}')`;
  return `read_parquet('${f}')`;
}

export function buildViewSql(filename: string, ops: ViewOp[], format = "parquet"): string {
  let sql = `SELECT * FROM ${buildReaderExpr(filename, format)}`;
  for (const op of ops) {
    sql = applyOp(sql, op);
  }
  return sql;
}

export function buildTileSql(filename: string, expr: ViewExpr, row: number, rows: number, format = "parquet"): string {
  const reader = buildReaderExpr(filename, format);
  if (expr.ops.length === 0) {
    return `SELECT * FROM ${reader} LIMIT ${rows} OFFSET ${row}`;
  }
  const view = buildViewSql(filename, expr.ops, format);
  return `SELECT * FROM (${view}) LIMIT ${rows} OFFSET ${row}`;
}

export function buildCountSql(filename: string, ops: ViewOp[], format = "parquet"): string {
  if (ops.length === 0) {
    return `SELECT COUNT(*) AS n FROM ${buildReaderExpr(filename, format)}`;
  }
  const view = buildViewSql(filename, ops, format);
  return `SELECT COUNT(*) AS n FROM (${view})`;
}

export function buildSchemaSql(filename: string, format = "parquet"): string {
  return `DESCRIBE SELECT * FROM ${buildReaderExpr(filename, format)}`;
}

export function buildExportCode(filename: string, ops: ViewOp[], format: string): string {
  const sql = buildViewSql(filename, ops);

  switch (format) {
    case "sql":
    case "ansi_sql":
      return sql + ";";
    case "python_duckdb":
      return `import duckdb\ndf = duckdb.sql("""\n${sql}\n""").df()`;
    case "python_polars":
      return `import polars as pl\ndf = pl.read_database(\n    "${sql.replace(/"/g, '\\"')}",\n    connection=duckdb.connect(),\n)`;
    case "python_pandas":
      return `import duckdb\ndf = duckdb.sql("""\n${sql}\n""").df()`;
    case "shell":
    case "shell_csv":
      return `duckdb -c "${sql.replace(/"/g, '\\"')}"`;
    default:
      return sql + ";";
  }
}

export { q as quoteIdent, predSql };
