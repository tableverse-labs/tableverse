---
name: lite-version
description: DuckDB-WASM lite version — browser-native, no backend, deployable to GitHub Pages
metadata:
  type: project
---

Browser-native Tableverse Lite built on DuckDB-WASM. Deploys to GitHub Pages. No Rust backend needed.

**Why:** Enables viral sharing — anyone can try Tableverse instantly without installing anything. Embeddable, zero-config.

**How to apply:** The adapter pattern means all hooks/stores work identically in both modes. Only the data loading layer differs.

## Architecture

```
web/src/api/
├── contract.ts          # DataAPI interface + shared types (QueryTileParams, TileMeta, etc.)
├── http.ts              # HttpAdapter — full backend, identical to original api.ts
├── index.ts             # Singleton registry + top-level re-exports (backward compat)
└── duckdb/
    ├── setup.ts         # getDuckDB() / getConnection() — lazy singleton via jsDelivr CDN bundles
    ├── sql-builder.ts   # ViewExpr → SQL (handles all ops: filter/sort/group_by/derive/etc.)
    ├── stats.ts         # Column stats, row group stats, correlations via SQL
    └── adapter.ts       # DuckDbAdapter implementing DataAPI
```

## Key Design Decisions

- `lib/api.ts` is now a thin `export * from "../api/index"` shim — zero import changes in existing hooks
- `setAdapter(impl)` / `getAdapter()` in `api/index.ts` allows swapping adapters at startup
- `main-lite.tsx` calls `setAdapter(new DuckDbAdapter())` before `createRoot`
- DuckDB-WASM bundles its own `apache-arrow`; `as unknown as Table` cast used for tile returns
- `DuckDbAdapter` uses `registry` (not `sources`) to avoid name clash with `DataAPI.getSource`
- Row group stats use `parquet_metadata()` DuckDB function; falls back to `[]` on error

## Build Targets

- `bun run build` → `dist/` (full app, requires Rust backend)
- `bun run build:lite` → `dist-lite/` (lite app, uses `vite.lite.config.ts` + `index-lite.html`)

## GitHub Pages Deployment

`.github/workflows/deploy-lite.yml` triggers on main branch push to `web/**`.
Builds lite and deploys `dist-lite/` to `github-pages` environment.

## Lite-specific UX

- `AppLite.tsx` — same as App.tsx but uses `SourceManagerLite` instead of `SourceManager`, no Share/Catalogs, shows "Lite" badge
- `SourceManagerLite.tsx` — drag+drop only (no URI/cloud/db), 300MB limit, shows upgrade CTA on overflow
- `speculativeSort` and `buildDownloadUrl` are no-ops in DuckDB adapter (no backend)
- `subscribeColumnStats` is async/immediate (no SSE); emits metadata→stats→done in sequence

## What's NOT supported in lite

- URI-based source registration (paths don't work; HTTP URIs do)
- Download URLs (returns empty string)
- Snapshot/share URLs (no backend)
- Job streaming / provisional tiles
- Cloud storage, databases, HuggingFace sources
