import { useRef, useState } from "react";
import { useUiStore } from "../../stores/ui";
import { useTableStore } from "../../stores/table";
import { useViewStore } from "../../stores/view";
import { uploadSource, deleteSource } from "../../lib/api";
import type { SourceMeta } from "../../lib/types";
import { formatRowCount } from "../../lib/format";

const LITE_MAX_BYTES = 300 * 1024 * 1024;

export function SourceManagerLite() {
  const show = useUiStore((s) => s.showSourceManager);
  const toggleSourceManager = useUiStore((s) => s.toggleSourceManager);
  const setSource = useTableStore((s) => s.setSource);
  const activeSource = useTableStore((s) => s.source);
  const setSourceId = useViewStore((s) => s.setSourceId);

  const [sources, setSources] = useState<SourceMeta[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [dragOver, setDragOver] = useState(false);
  const dragDepth = useRef(0);

  if (!show) return null;

  const handleSelect = (source: SourceMeta) => {
    setSource(source);
    setSourceId(source.id);
    toggleSourceManager();
  };

  const handleDelete = async (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    await deleteSource(id).catch(console.error);
    setSources((prev) => prev.filter((s) => s.id !== id));
    if (activeSource?.id === id) {
      setSource(null);
      setSourceId(null);
    }
  };

  const handleFile = async (file: File) => {
    if (file.size > LITE_MAX_BYTES) {
      setError(`File too large for lite mode (max ${LITE_MAX_BYTES / 1024 / 1024} MB). Use the full Tableverse desktop app for larger files.`);
      return;
    }
    setLoading(true);
    setError("");
    try {
      const isParquet = file.name.endsWith(".parquet") || file.type === "application/x-parquet";
      const buf = await file.arrayBuffer();
      const source = await uploadSource(buf, file.name, isParquet);
      setSources((prev) => [...prev, source]);
      setSource(source);
      setSourceId(source.id);
      toggleSourceManager();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  };

  const handleDragEnter = (e: React.DragEvent) => {
    e.preventDefault();
    dragDepth.current += 1;
    setDragOver(true);
  };

  const handleDragLeave = (e: React.DragEvent) => {
    e.preventDefault();
    dragDepth.current -= 1;
    if (dragDepth.current === 0) setDragOver(false);
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    dragDepth.current = 0;
    setDragOver(false);
    const file = e.dataTransfer.files[0];
    if (file) handleFile(file);
  };

  return (
    <>
      <div
        style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.3)", zIndex: 800 }}
        onClick={toggleSourceManager}
      />
      <div
        style={{
          position: "fixed",
          top: 0,
          left: 0,
          bottom: 0,
          width: 340,
          background: "var(--c-bg)",
          borderRight: "1px solid var(--c-border)",
          boxShadow: "4px 0 16px rgba(0,0,0,0.2)",
          zIndex: 801,
          display: "flex",
          flexDirection: "column",
        }}
      >
        <div style={{ padding: "16px", borderBottom: "1px solid var(--c-border)" }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
            <h2 style={{ margin: 0, fontSize: 15, color: "var(--c-text)" }}>Open file</h2>
          </div>

          <div
            onDragEnter={handleDragEnter}
            onDragOver={(e) => e.preventDefault()}
            onDragLeave={handleDragLeave}
            onDrop={handleDrop}
            onClick={() => document.getElementById("tv-lite-file-input")?.click()}
            style={{
              border: `2px dashed ${dragOver ? "var(--c-accent)" : "var(--c-border)"}`,
              borderRadius: 8,
              padding: "28px 16px",
              textAlign: "center",
              background: dragOver ? "var(--c-surface)" : "transparent",
              transition: "border-color 0.15s, background 0.15s",
              cursor: loading ? "not-allowed" : "pointer",
              opacity: loading ? 0.6 : 1,
            }}
          >
            <input
              id="tv-lite-file-input"
              type="file"
              accept=".parquet,.arrow,.csv,.json,.jsonl"
              style={{ display: "none" }}
              onChange={(e) => { const f = e.target.files?.[0]; if (f) handleFile(f); e.target.value = ""; }}
              disabled={loading}
            />
            <div style={{ fontSize: 24, marginBottom: 8 }}>{loading ? "⏳" : "📂"}</div>
            <div style={{ fontSize: 13, fontWeight: 500, color: "var(--c-text)" }}>
              {loading ? "Loading…" : "Drop a file or click to browse"}
            </div>
            <div style={{ fontSize: 11, color: "var(--c-text-3)", marginTop: 4 }}>
              Parquet · Arrow · CSV · JSON/JSONL · up to 300 MB
            </div>
          </div>

          {error && (
            <div style={{ marginTop: 10, padding: "8px 12px", background: "var(--c-red-bg)", border: "1px solid", borderColor: "var(--c-red)", borderRadius: 6, fontSize: 12, color: "var(--c-red)" }}>
              {error}
              {error.includes("lite mode") && (
                <div style={{ marginTop: 6 }}>
                  <a
                    href="https://github.com/sjoerdvink99/tableverse"
                    target="_blank"
                    rel="noopener noreferrer"
                    style={{ color: "var(--c-accent)", textDecoration: "underline" }}
                  >
                    Get the full version →
                  </a>
                </div>
              )}
            </div>
          )}
        </div>

        {sources.length > 0 && (
          <div style={{ flex: 1, overflowY: "auto" }}>
            <div style={{ padding: "10px 16px 4px", fontSize: 11, fontWeight: 600, color: "var(--c-text-3)", letterSpacing: "0.05em", textTransform: "uppercase" }}>
              Open files
            </div>
            {sources.map((source) => (
              <div
                key={source.id}
                onClick={() => handleSelect(source)}
                style={{
                  padding: "10px 16px",
                  borderBottom: "1px solid var(--c-surface-2)",
                  cursor: "pointer",
                  background: activeSource?.id === source.id ? "var(--c-accent-bg)" : "var(--c-bg)",
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "flex-start",
                }}
              >
                <div>
                  <div style={{ fontSize: 13, fontWeight: 500, color: "var(--c-text)" }}>{source.name}</div>
                  <div style={{ fontSize: 11, color: "var(--c-text-2)", marginTop: 2 }}>
                    {formatRowCount(source.n_rows)} rows · {source.n_cols} cols · {source.format}
                  </div>
                </div>
                <button
                  onClick={(e) => handleDelete(source.id, e)}
                  style={{ fontSize: 11, color: "var(--c-text-3)", background: "none", border: "none", cursor: "pointer", padding: "2px 4px" }}
                >
                  ✕
                </button>
              </div>
            ))}
          </div>
        )}

        <div style={{ padding: "12px 16px", borderTop: "1px solid var(--c-border)", fontSize: 11, color: "var(--c-text-3)" }}>
          Lite mode — runs entirely in your browser via DuckDB-WASM.{" "}
          <a
            href="https://github.com/sjoerdvink99/tableverse"
            target="_blank"
            rel="noopener noreferrer"
            style={{ color: "var(--c-accent)" }}
          >
            Full version
          </a>{" "}
          for large files, cloud storage &amp; more.
        </div>
      </div>
    </>
  );
}
