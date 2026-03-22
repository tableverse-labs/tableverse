import { useEffect, useRef, useState } from "react";
import { useUiStore } from "../../stores/ui";
import type { LayerName } from "../../stores/ui";

type LayerDef = {
  id: LayerName;
  label: string;
  title: string;
  color: string;
};

const LAYER_DEFS: LayerDef[] = [
  { id: "null_map",       label: "Null Map",      title: "Highlight missing values",           color: "#ef4444" },
  { id: "distribution",   label: "Distribution",  title: "Color cells by value magnitude",      color: "#8b5cf6" },
  { id: "outlier",        label: "Outliers",      title: "Flag values outside P1–P99",          color: "#f59e0b" },
  { id: "quality_alerts", label: "Quality Alerts",title: "Flag problematic columns",            color: "#10b981" },
  { id: "completeness",   label: "Completeness",  title: "Color cells by completeness score",   color: "#3b82f6" },
  { id: "class_balance",  label: "Class Balance", title: "Color categorical values by frequency",color: "#ec4899" },
];

export function LayerToggle() {
  const activeLayers = useUiStore((s) => s.activeLayers);
  const toggleLayer = useUiStore((s) => s.toggleLayer);
  const setLayerPreset = useUiStore((s) => s.setLayerPreset);

  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  const count = activeLayers.size;

  return (
    <div className="tv-layer-dropdown" ref={ref}>
      <button
        className={`tv-layer-trigger${count > 0 ? " has-active" : ""}`}
        onClick={() => setOpen((o) => !o)}
        title="Profiling layers"
      >
        <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true">
          <rect x="1" y="2" width="10" height="1.5" rx="0.75" fill="currentColor" opacity="0.9"/>
          <rect x="1" y="5.25" width="10" height="1.5" rx="0.75" fill="currentColor" opacity="0.7"/>
          <rect x="1" y="8.5" width="10" height="1.5" rx="0.75" fill="currentColor" opacity="0.45"/>
        </svg>
        Layers
        {count > 0 && <span className="tv-layer-badge">{count}</span>}
        <svg className="tv-layer-caret" width="8" height="8" viewBox="0 0 8 8" fill="none" aria-hidden="true">
          <path d="M1.5 3L4 5.5L6.5 3" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" strokeLinejoin="round"/>
        </svg>
      </button>

      {open && (
        <div className="tv-layer-menu">
          {LAYER_DEFS.map((def) => {
            const active = activeLayers.has(def.id);
            return (
              <label key={def.id} className="tv-layer-item" title={def.title}>
                <input
                  type="checkbox"
                  checked={active}
                  onChange={() => toggleLayer(def.id)}
                  className="tv-layer-checkbox"
                />
                <span
                  className="tv-layer-swatch"
                  style={{ background: def.color }}
                />
                {def.label}
              </label>
            );
          })}
          {count > 0 && (
            <div className="tv-layer-menu-footer">
              <button
                className="tv-layer-clear-btn"
                onClick={() => { setLayerPreset("none"); setOpen(false); }}
              >
                Clear all
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
