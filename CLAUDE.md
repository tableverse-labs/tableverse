# Tableverse — CLAUDE.md

Tableverse is a high-performance table viewer for data engineers and ML engineers who need to inspect massive datasets instantly. It uses a tile-based rendering architecture: data is divided into spatial tiles and only the visible region is fetched and rendered, enabling seamless pan and scroll through arbitrarily large tables.

## Architecture

```
Browser (React + Canvas)
        │  Arrow IPC (binary)
Axum REST API
        │  in-memory LRU
tv-engine (direct Parquet / Arrow / CSV / JSON reads)
        │  object_store (local, S3, GCS, Azure)
File system / object storage
```

**Crates:**
- `tv-core` — shared types, tile coordinate math, error types, ViewExpr DSL, 5-pass optimizer
- `tv-engine` — direct Parquet/Arrow reader, Arrow compute executor, stats, indexes, materializer
- `tv-server` — Axum REST API: tile serving, caching, route handlers, AppState
- `tv-cli` — Clap-based CLI; standalone `tableverse serve <file>` entrypoint
- `tv-bench` — Criterion benchmarks
- `tv-integrations` — Delta Lake, Apache Iceberg, HuggingFace Hub, AWS Glue catalog
- `tv-adbc` — ADBC driver (ClickHouse and generic ADBC sources)
- `tv-flight` — Apache Arrow Flight client and service

**Frontend (`web/`):**
- Canvas-based grid rendering (no DOM table elements)
- Zustand stores for table and UI state
- Client-side byte-budgeted LRU tile cache and prefetching
- Apache Arrow (arrow-js) for binary IPC deserialization

## Project Structure

```
Tableverse/
├── crates/
│   ├── tv-core/src/         # Tile math, types, error, ViewExpr DSL, optimizer
│   ├── tv-engine/src/       # Reader, executor, stats, indexes, materializer
│   ├── tv-server/src/       # Axum server, routes/, cache, state, snapshot
│   ├── tv-cli/src/          # main.rs (Clap entrypoint)
│   ├── tv-bench/            # Criterion benchmarks
│   ├── tv-integrations/     # Delta Lake, Iceberg, HuggingFace, Glue
│   ├── tv-adbc/             # ADBC driver
│   └── tv-flight/           # Arrow Flight client/service
├── web/src/
│   ├── components/
│   │   ├── TableViewer/     # GridCanvas, ScrollContainer, headers
│   │   ├── Toolbar/         # NavigationBar, ZoomControls
│   │   ├── Overlays/        # Tooltip, ContextMenu, JumpToRow, panels
│   │   └── SourceManager/   # AddSource
│   ├── hooks/               # useKeyboard, useViewport, useTiles, useZoom, useNavigation
│   ├── stores/              # table.ts, ui.ts, view.ts, stats.ts, bookmarkStore.ts
│   └── lib/                 # api.ts, tile-manager, tile-cache, semantic-render, viewport
├── py/                      # Python wrapper package (show, inspect, Jupyter magic)
├── sdk/python/              # Python SDK with integration adapters (Dagster, MLflow, etc.)
├── extensions/              # VS Code and JupyterLab extensions
├── deployment/              # Docker Compose for full-stack deployment
├── examples/                # Sample Parquet files
├── Cargo.toml               # Rust workspace
├── Makefile
└── .env.example
```

## Tech Stack

| Layer | Technology |
|---|---|
| Backend language | Rust 1.75+ |
| Web framework | Axum 0.8 |
| Query engine | Direct Parquet + Arrow reads (parquet v55, arrow v55) |
| Data transfer | Apache Arrow IPC |
| Caching | In-memory LRU (DashMap, byte-budgeted) |
| Frontend framework | React 19 |
| Build tool | Vite 8 |
| Frontend state | Zustand 5 |
| Arrow client | arrow-js 21 |
| JS runtime | Bun 1.0+ |
| Async runtime | Tokio |
| CLI parsing | Clap 4 |
| Logging | Tracing / Tracing-Subscriber |

Supported data formats: **Parquet** (primary), CSV, Arrow IPC, NDJSON.

## Key Commands

```bash
# Backend
make serve FILE=path/to/file.parquet   # run server (hot reload)
cargo test --all                        # run all tests
cargo clippy --all -- -D warnings       # lint (must pass with zero warnings)
cargo fmt --all                         # format

# Frontend
cd web && bun install
bun run dev                             # Vite dev server (hot reload, proxies /api to :8080)
bun run build                           # production build

# Docker
make docker-up                          # full-stack Docker Compose
make docker-down                        # stop
```

## Core Patterns

### Tile System
- Each tile is addressed by `(row_offset, col_offset, rows, cols)`. Default size scales with zoom level.
- Cache key is a hash of `(source_id, tile_coords, view_hash)` where `view_hash` is FNV-1a over the canonical JSON of `ops`.
- Server uses cache-aside: check in-memory LRU, execute on miss.
- Client prefetches adjacent tiles before they enter the viewport.

### Data Flow (scroll event → rendered cell)
1. Viewport math determines which tiles are visible.
2. `useTiles` requests missing tiles from the server.
3. Server checks in-memory cache by view hash.
4. On miss: `tv-engine` reads the Parquet file with row group pruning and column projection.
5. The executor applies Arrow compute ops (filter, sort, group_by, derive) to the record batches.
6. Result is serialized as Arrow IPC binary and cached.
7. Client deserializes Arrow binary and hands the `Table` to `GridCanvas`.
8. `GridCanvas` draws cells on a `<canvas>` via 2D context.

### Execution Model
- Sources are registered in `tv-engine/catalog.rs` and read directly via the `parquet` crate.
- `ViewExpr` ops are executed by `tv-engine/executor.rs` using Arrow compute kernels. No SQL is generated.
- Stateful ops (sort, group_by, deduplicate, sample, top_k) materialize once into the 2 GB LRU cache. Large results spill to disk via `spill_pipeline.rs`.
- Arrow IPC is the wire format — no JSON for data payloads.

### Statistics
- Computed on demand per column: min, max, mean, null count, distinct count, histogram.
- Fast path: Parquet footer metadata (O(1), no rows scanned).
- Full path: streaming single-pass computation with HyperLogLog for distinct count.
- Triggered by `GET /api/v1/sources/{id}/columns/{idx}/stats`.

## ViewExpr DSL

`ViewExpr` is the serializable intermediate representation of a data pipeline. It is executed by Arrow compute kernels at query time.

```typescript
type ViewExpr = { source_id: string; ops: ViewOp[]; };
```

### ViewOp variants

| type | fields | description |
|---|---|---|
| `filter` | `predicate: Predicate` | Keep rows matching the predicate tree |
| `select` | `columns: string[]` | Keep only these columns |
| `drop` | `columns: string[]` | Remove these columns |
| `sort` | `keys: SortKey[]` | Sort rows |
| `derive` | `name: string, expr: ScalarExpr` | Add a computed column |
| `deduplicate` | `columns: string[] \| null` | Remove duplicate rows |
| `sample` | `n: number, strategy: "bernoulli"\|"system", seed?` | Random sample |
| `group_by` | `keys: string[], aggs: AggExpr[]` | Aggregate by key columns |
| `top_k` | `k: number, key: SortKey` | Top-K rows by key |

### Predicate

Leaf predicates: `eq`, `ne`, `gt`, `gte`, `lt`, `lte`, `between`, `in`, `not_in`, `contains`, `starts_with`, `ends_with`, `regex`, `is_null`, `is_not_null`

Combinators: `and { exprs }`, `or { exprs }`, `not { expr }`

Literals: `null | boolean | number | string`

### ScalarExpr (for derive ops)

`column`, `literal`, `bin_op` (add/sub/mul/div/mod), `abs`, `round`, `floor`, `ceil`, `upper`, `lower`, `trim`, `length`, `substr`, `concat`, `year`, `month`, `day`, `case`, `coalesce`, `rank`, `ntile`, `cast`

### AggExpr (for group_by ops)

`count`, `count_distinct`, `sum`, `min`, `max`, `mean`, `median`, `std_dev`, `percentile` — each requires an `alias` field.

### Execution Pipeline

- Each `ViewOp` is applied in sequence by `tv-engine/executor.rs`.
- The optimizer (5 passes in `tv-core/optimizer.rs`) runs before execution: predicate pushdown, column pruning, sort normalization, filter merging, top-k rewrite.
- Stateful ops trigger materialization via `spill_pipeline.rs`.
- Tile queries: offset and limit slicing on the materialized or streamed result.
- Count queries: metadata fast-path (Parquet footer) or full executor pass.
- Download queries: full pipeline written to Parquet or CSV via Arrow writer.

### View Hash

16-char hex FNV-1a over canonical JSON of `ops`. Used as tile cache key dimension — ops change → new hash → old tiles automatically ignored.

### Interaction to DSL Flow

All operations are created through direct table interaction, never via form builders:

- **Column header click** → sort asc → desc → clear
- **Column header shift+click** → multi-sort
- **Column header right-click** → ColumnContextMenu (sort, hide, group by, derive)
- **Column header hover** → distribution popover (histogram click/drag → between filter; null band → is_null)
- **Cell right-click** → CellContextMenu (eq / ne / gt / lt / not_in / is_null / copy)
- **PipelineBar** → read-only op chips with × remove

### Export

- `POST /api/v1/sources/{id}/query/export` — returns code string (SQL, DuckDB Python, Polars, Pandas)
- `GET /api/v1/sources/{id}/query/download?format=parquet|csv&view_expr=<base64>` — file download

## API Endpoints

```
GET    /healthz
GET    /api/v1/sources
POST   /api/v1/sources
GET    /api/v1/sources/:id
DELETE /api/v1/sources/:id
GET    /api/v1/sources/:id/tiles
POST   /api/v1/sources/:id/query/tiles            { view_expr, row, col, rows?, cols? } → Arrow IPC
POST   /api/v1/sources/:id/query/tiles/batch      framed binary (4B count + per-tile IPC blocks)
POST   /api/v1/sources/:id/query/count            { view_expr } → { count }
POST   /api/v1/sources/:id/query/schema           { view_expr } → { columns }
POST   /api/v1/sources/:id/query/export           { view_expr, format } → { code }
GET    /api/v1/sources/:id/query/download         ?format=parquet|csv&view_expr=<base64>
GET    /api/v1/sources/:id/columns/:idx/stats
GET    /api/v1/sources/:id/columns/:idx/stats/stream    SSE (metadata → stats → done)
GET    /api/v1/sources/:id/columns/:idx/row-group-stats
GET    /api/v1/sources/:id/row-group-stats/batch
GET    /api/v1/sources/:id/profile
GET    /api/v1/sources/:id/correlations
POST   /api/v1/sources/:id/search
POST   /api/v1/sources/:id/optimize
PUT    /api/v1/upload
POST   /api/v1/catalog/browse
GET    /api/v1/profiles
GET    /api/v1/jobs/:id/events                    SSE
GET    /api/v1/jobs/:id
GET    /api/v1/metrics
POST   /api/v1/snapshots
GET    /api/v1/snapshots/:id
```

## Coding Conventions

- **No comments** in code — self-documenting names only
- **Rust**: follow `cargo fmt` defaults; all warnings treated as errors in CI; use `thiserror` for error types
- **TypeScript**: strict mode, no `any`, no implicit returns
- **No Redux** — Zustand only
- **No DOM table elements** — Canvas rendering only for the grid
- Errors propagate via typed error enums (`tv-core/error.rs`, crate-local `error.rs` files)
- AppState is shared via Axum `State` — no globals

## Environment Variables

See `.env.example`. Key vars:

```
SERVER_PORT=8080
TILE_CACHE_MAX_BYTES=2147483648   # 2 GB in-memory tile cache
TILE_CACHE_TTL_SECS=3600
VIEW_CACHE_MAX_BYTES=2147483648   # 2 GB materializer cache
ALLOWED_ORIGINS=*
TV_API_KEY=                        # optional; enables bearer token auth when set
```

Cloud storage credentials follow the standard AWS/GCS/Azure env var conventions (`AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_DEFAULT_REGION`, etc.).

## Testing

- Unit tests live alongside source files (`#[cfg(test)]` modules in Rust)
- Integration tests in `tests/` directories per crate
- `cargo test --all` runs everything
- Frontend: `bun run test` (Vitest)

## Product Vision

Tableverse targets data engineers and ML engineers. The north-star metric is **time to insight**: a user drops a 1B-row Parquet file and starts inspecting real cells in under 3 seconds. Every architectural decision — tile caching, Arrow IPC, canvas rendering, direct Parquet reads — exists to serve this goal.
