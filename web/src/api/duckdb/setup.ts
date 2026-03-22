import * as duckdb from "@duckdb/duckdb-wasm";

let dbInstance: duckdb.AsyncDuckDB | null = null;
let dbPromise: Promise<duckdb.AsyncDuckDB> | null = null;
let connInstance: duckdb.AsyncDuckDBConnection | null = null;
let connPromise: Promise<duckdb.AsyncDuckDBConnection> | null = null;

async function initializeDb(): Promise<duckdb.AsyncDuckDB> {
  const { mvp, eh } = duckdb.getJsDelivrBundles();
  const bundle = await duckdb.selectBundle({ mvp, eh });
  const workerUrl = URL.createObjectURL(
    new Blob([`importScripts("${bundle.mainWorker!}");`], { type: "text/javascript" })
  );
  let worker: Worker | null = null;
  try {
    worker = new Worker(workerUrl);
    const db = new duckdb.AsyncDuckDB(new duckdb.ConsoleLogger(duckdb.LogLevel.WARNING), worker);
    await db.instantiate(bundle.mainModule, bundle.pthreadWorker);
    dbInstance = db;
    return db;
  } catch (err) {
    worker?.terminate();
    throw err;
  } finally {
    URL.revokeObjectURL(workerUrl);
  }
}

export async function getDuckDB(): Promise<duckdb.AsyncDuckDB> {
  if (dbInstance) return dbInstance;
  if (dbPromise) return dbPromise;
  dbPromise = initializeDb().catch((err) => {
    dbPromise = null;
    throw err;
  });
  return dbPromise;
}

export async function getConnection(): Promise<duckdb.AsyncDuckDBConnection> {
  if (connInstance) return connInstance;
  if (connPromise) return connPromise;
  connPromise = (async () => {
    const db = await getDuckDB();
    const conn = await db.connect();
    try {
      await conn.query("SET max_expression_depth TO 1000");
    } catch { }
    connInstance = conn;
    return conn;
  })().catch((err) => {
    connPromise = null;
    throw err;
  });
  return connPromise;
}

export function resetDuckDB(): void {
  connInstance = null;
  connPromise = null;
  dbInstance = null;
  dbPromise = null;
}
