---
name: profiling-system-v2
description: Major profiling system overhaul implemented 2026-05-13 — layer-aware minimap, progressive headers, quality scores, new layers
metadata:
  type: project
---

Major profiling overhaul across all phases. Build: cargo clippy clean (0 warnings), 182 Rust tests pass, TypeScript build clean.

**Why:** User wants Tableverse to get thousands of GitHub stars as the #1 data profiling table viewer.

**How to apply:** All files below are live production code. No further migration needed.

## What was implemented

### Phase 3: Backend Stats Additions
- `crates/tv-core/src/types.rs`: Added `outlier_pct: Option<f64>`, `completeness_score: f64`, `class_imbalance_ratio: Option<f64>` to `ColumnStats`
- `crates/tv-engine/src/stats.rs`: Computes these in all 3 construction sites; outlier_pct uses histogram+quantile bucket counting
- `web/src/lib/types.ts`: TypeScript types updated to match

### Phase 5: Layer Presets
- New `LayerName` values: `"completeness"` and `"class_balance"` added to ui.ts
- `setLayerPreset(preset)` action in ui.ts: "quality", "distribution", "ml", "full", "none"
- `web/src/components/Toolbar/LayerToggle.tsx`: Redesigned with layer dot indicators + preset buttons
- CSS: new `.tv-layer-chips`, `.tv-layer-presets`, `.tv-layer-preset-btn`, `.tv-layer-dot` classes

### Phase 4: New Layers
- `web/src/lib/layers/completeness.ts`: Green→red gradient cell overlay by completeness; null cells = red
- `web/src/lib/layers/class-balance.ts`: Colors categorical cells by frequency rank using Okabe-Ito palette
- `web/src/lib/layers/index.ts`: Updated to render both new layers

### Phase 1: Layer-Aware Minimap (biggest visual change)
- `web/src/lib/minimap-render.ts`: Pure rendering functions — `renderMinimapLayer`, `renderMinimapNeutral`, `renderMinimapColumnSeparators`; each layer has its own color encoding and accent color
- `web/src/hooks/useMinimap.ts`: Now reads `activeLayers` from uiStore; switches to 2D col×rowgroup heatmap when any layer active
- `web/src/components/Minimap/MinimapCanvas.tsx`: Shows 18px layer header with layer name + accent bar; 14px legend gradient at bottom; bookmark pins adjusted for new offsets
- `activeMinimapLayer()` picks highest-priority active layer for the minimap

### Phase 2: Progressive Column Headers + Quality Scores
- `web/src/lib/quality-score.ts`: `computeQualityScore(stats)` → 0–100 composite metric; `qualityScoreColor(score)` → RGB
- `web/src/lib/viewport.ts`: Added `headerHeightForZoom(zoom)`: 18→36→56→80→100px at each zoom tier
- `web/src/components/TableViewer/ColumnHeader.tsx`: Completely rewritten with 5 zoom-tier rendering functions:
  - `renderSatelliteHeader` (<0.10): type color swatch only
  - `renderProfileHeader` (0.10–0.28): type badge + drift sparkline
  - `renderHeatmapHeader` (0.28–0.55): name + type badge + inline histogram + quality score bar
  - `renderScanHeader` (0.55–0.85): full name + type + histogram + quality badge + sparkline + correlation label
  - `renderFullHeader` (>0.85): everything + quartile strip + mean/skewness + sort/filter indicators
- New canvas draw functions: `drawQualityBadge`, `drawTypeBadge`, `drawInlineHistogram`, `drawQuartileStrip`, `roundRect`, `drawSparkline`

### Layout Wiring
- `TableViewer/index.tsx`: reads zoom, computes `headerH = headerHeightForZoom(zoom)`, passes to grid layout + CornerCell
- `CornerCell.tsx`: accepts `headerH` prop (replaces hardcoded HEADER_HEIGHT)
- `ScrollContainer.tsx`: zoom focal point uses `headerHeightForZoom(zoom)`
- `Minimap/index.tsx`: panel top offset uses `headerHeightForZoom(zoom)`
- `ColumnDistributionPopover/index.tsx`: popover top uses `headerHeightForZoom(zoom)`
