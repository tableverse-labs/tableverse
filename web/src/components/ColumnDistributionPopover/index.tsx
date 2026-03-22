import { useEffect, useRef, useState } from "react";
import { useUiStore } from "../../stores/ui";
import { useTableStore } from "../../stores/table";
import { useViewStore } from "../../stores/view";
import { useStatsStore, getStatsKey } from "../../stores/stats";
import { useProgressiveStats } from "../../hooks/useProgressiveStats";
import { DEFAULT_CELL_W, ROW_HEADER_W, headerHeightForZoom } from "../../lib/viewport";
import type { ColumnStats } from "../../lib/types";

const COMPACT_WIDTH = 240;
const EXPANDED_WIDTH = 400;
const COMPACT_BAR_HEIGHT = 72;
const EXPANDED_BAR_HEIGHT = 160;

type HistogramPanelProps = {
  stats: ColumnStats;
  isApproximate: boolean;
  barHeight: number;
  dragStart: number | null;
  dragEnd: number | null;
  onBucketClick: (bucket: { lo: number; hi: number }, idx: number) => void;
  onDragEnd: () => void;
  onDragStart: (idx: number) => void;
  onDragOver: (idx: number) => void;
};

function HistogramPanel({
  stats,
  isApproximate,
  barHeight,
  dragStart,
  dragEnd,
  onBucketClick,
  onDragEnd,
  onDragStart,
  onDragOver,
}: HistogramPanelProps) {
  if (!stats.histogram || stats.histogram.length === 0) return null;
  const maxCount = Math.max(...stats.histogram.map((b) => b.count), 1);
  return (
    <div
      style={{
        display: "flex",
        alignItems: "flex-end",
        height: barHeight,
        gap: 1,
        marginBottom: 4,
        opacity: isApproximate ? 0.55 : 1,
        transition: "opacity 0.2s, height 0.2s",
      }}
      onMouseUp={onDragEnd}
      title={isApproximate ? "Approximate — full stats loading…" : undefined}
    >
      {stats.histogram.map((bucket, i) => {
        const heightPct = (bucket.count / maxCount) * 100;
        const isSelected =
          dragStart !== null &&
          dragEnd !== null &&
          i >= Math.min(dragStart, dragEnd) &&
          i <= Math.max(dragStart, dragEnd);
        return (
          <div
            key={i}
            style={{
              flex: 1,
              height: `${Math.max(heightPct, 2)}%`,
              background: isSelected ? "var(--c-accent)" : "var(--canvas-sparkline)",
              borderRadius: "2px 2px 0 0",
              cursor: "pointer",
              transition: "background 0.1s",
            }}
            title={`${bucket.lo.toFixed(2)}–${bucket.hi.toFixed(2)}: ${bucket.count.toLocaleString()}`}
            onClick={() => onBucketClick(bucket, i)}
            onMouseDown={() => onDragStart(i)}
            onMouseEnter={() => onDragOver(i)}
          />
        );
      })}
    </div>
  );
}

export function ColumnDistributionPopover() {
  const hoveredColIdx = useUiStore((s) => s.hoveredColumnIndex);
  const pinnedColIdx = useUiStore((s) => s.pinnedDistributionColIdx);
  const setPinnedColIdx = useUiStore((s) => s.setPinnedDistributionColIdx);
  const source = useTableStore((s) => s.source);
  const viewport = useTableStore((s) => s.viewport);
  const zoom = useUiStore((s) => s.zoom);
  const addPredicate = useViewStore((s) => s.addPredicate);
  const allStats = useStatsStore((s) => s.stats);
  const pending = useStatsStore((s) => s.pending);
  const fetchStats = useStatsStore((s) => s.fetchStats);

  const [customInput, setCustomInput] = useState("");
  const [dragStart, setDragStart] = useState<number | null>(null);
  const [dragEnd, setDragEnd] = useState<number | null>(null);

  const hoverTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const prevColIdx = useRef<number | null>(null);
  const popoverRef = useRef<HTMLDivElement>(null);

  const isPinned = pinnedColIdx !== null;
  const activeColIdx = isPinned ? pinnedColIdx : hoveredColIdx;
  const width = isPinned ? EXPANDED_WIDTH : COMPACT_WIDTH;
  const barHeight = isPinned ? EXPANDED_BAR_HEIGHT : COMPACT_BAR_HEIGHT;
  const cellW = DEFAULT_CELL_W * zoom;

  const progressive = useProgressiveStats(source?.id ?? "", activeColIdx);

  useEffect(() => {
    if (activeColIdx === null || !source) return;
    if (activeColIdx === prevColIdx.current) return;
    prevColIdx.current = activeColIdx;
    setCustomInput("");
    setDragStart(null);
    setDragEnd(null);
    if (hoverTimerRef.current) clearTimeout(hoverTimerRef.current);
    hoverTimerRef.current = setTimeout(() => {
      fetchStats(source.id, activeColIdx);
    }, 120);
    return () => { if (hoverTimerRef.current) clearTimeout(hoverTimerRef.current); };
  }, [activeColIdx, source?.id]);

  useEffect(() => {
    if (!isPinned) return;
    const handleMouseDown = (e: MouseEvent) => {
      if (popoverRef.current && !popoverRef.current.contains(e.target as Node)) {
        setPinnedColIdx(null);
      }
    };
    document.addEventListener("mousedown", handleMouseDown);
    return () => document.removeEventListener("mousedown", handleMouseDown);
  }, [isPinned, setPinnedColIdx]);

  if (activeColIdx === null || !source) return null;

  const colInfo = source.columns[activeColIdx];
  if (!colInfo) return null;

  const statsKey = getStatsKey(source.id, activeColIdx);
  const storeStats = allStats.get(statsKey) ?? null;
  const loading = pending.has(statsKey);
  const stats = storeStats ?? progressive.full ?? progressive.coarse ?? null;
  const isApproximate = stats !== null && storeStats === null && progressive.full === null;

  const colPixelX = activeColIdx * cellW - viewport.scrollX + ROW_HEADER_W;
  const popoverLeft = Math.max(4, Math.min(colPixelX, window.innerWidth - width - 8));
  const popoverTop = headerHeightForZoom(zoom);

  const nullFraction = stats ? stats.null_rate : 0;
  const nonNullCount = stats ? stats.count - stats.null_count : 0;

  const handleHistogramClick = (bucket: { lo: number; hi: number }, _bucketIdx: number) => {
    if (dragStart !== null && dragEnd !== null) return;
    addPredicate({ op: "between", column: colInfo.name, lo: bucket.lo, hi: bucket.hi });
  };

  const handleHistogramDragEnd = () => {
    if (dragStart === null || dragEnd === null || !stats?.histogram) return;
    const lo = Math.min(dragStart, dragEnd);
    const hi = Math.max(dragStart, dragEnd);
    const buckets = stats.histogram;
    const selectedLo = buckets[lo]!.lo;
    const selectedHi = buckets[hi]!.hi;
    addPredicate({ op: "between", column: colInfo.name, lo: selectedLo, hi: selectedHi });
    setDragStart(null);
    setDragEnd(null);
  };

  const submitCustom = (raw: string) => {
    const trimmed = raw.trim();
    if (!trimmed) return;
    const match = trimmed.match(/^(>=|<=|>|<|!=|=|contains?)\s*(.+)$/i);
    if (!match) return;
    const [, opStr, val] = match;
    if (!opStr || val === undefined) return;
    const parsed: string | number = isNaN(Number(val)) ? val : Number(val);
    const col = colInfo.name;
    switch (opStr.toLowerCase()) {
      case ">":  addPredicate({ op: "gt", column: col, value: parsed }); break;
      case ">=": addPredicate({ op: "gte", column: col, value: parsed }); break;
      case "<":  addPredicate({ op: "lt", column: col, value: parsed }); break;
      case "<=": addPredicate({ op: "lte", column: col, value: parsed }); break;
      case "!=": addPredicate({ op: "ne", column: col, value: parsed }); break;
      case "=":  addPredicate({ op: "eq", column: col, value: parsed }); break;
      case "contains":
      case "contain": addPredicate({ op: "contains", column: col, value: String(val) }); break;
    }
    setCustomInput("");
  };

  return (
    <div
      ref={popoverRef}
      onMouseDown={(e) => e.stopPropagation()}
      style={{
        position: "absolute",
        left: popoverLeft,
        top: popoverTop,
        width,
        background: "var(--c-bg)",
        border: "1px solid var(--c-border)",
        borderRadius: 10,
        boxShadow: isPinned
          ? "0 12px 40px rgba(0,0,0,0.22), 0 2px 8px rgba(0,0,0,0.1)"
          : "0 8px 24px rgba(0,0,0,0.16)",
        zIndex: 500,
        padding: "12px 14px 12px",
        pointerEvents: "auto",
        transition: "width 0.18s cubic-bezier(0.4,0,0.2,1), box-shadow 0.18s",
      }}
    >
      <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", marginBottom: 6 }}>
        <div style={{ minWidth: 0, flex: 1 }}>
          <div style={{ fontSize: 12, fontWeight: 600, color: "var(--c-text)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {colInfo.name}
          </div>
          <div style={{ fontSize: 10, color: "var(--c-text-3)", fontFamily: "ui-monospace, monospace", marginTop: 1 }}>
            {colInfo.data_type}
          </div>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 2, marginLeft: 8, flexShrink: 0 }}>
          {!isPinned && (
            <button
              onClick={() => setPinnedColIdx(activeColIdx)}
              title="Expand"
              style={{
                width: 22,
                height: 22,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                background: "none",
                border: "none",
                borderRadius: 5,
                cursor: "pointer",
                color: "var(--c-text-3)",
                padding: 0,
                transition: "background 0.1s, color 0.1s",
              }}
              onMouseEnter={(e) => {
                (e.currentTarget as HTMLElement).style.background = "var(--c-surface-2)";
                (e.currentTarget as HTMLElement).style.color = "var(--c-text)";
              }}
              onMouseLeave={(e) => {
                (e.currentTarget as HTMLElement).style.background = "none";
                (e.currentTarget as HTMLElement).style.color = "var(--c-text-3)";
              }}
            >
              <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
                <path d="M7 1h4v4M11 1L6.5 5.5M5 11H1V7M1 11l4.5-4.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </button>
          )}
          {isPinned && (
            <button
              onClick={() => setPinnedColIdx(null)}
              title="Close"
              style={{
                width: 22,
                height: 22,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                background: "none",
                border: "none",
                borderRadius: 5,
                cursor: "pointer",
                color: "var(--c-text-3)",
                padding: 0,
                transition: "background 0.1s, color 0.1s",
              }}
              onMouseEnter={(e) => {
                (e.currentTarget as HTMLElement).style.background = "var(--c-surface-2)";
                (e.currentTarget as HTMLElement).style.color = "var(--c-text)";
              }}
              onMouseLeave={(e) => {
                (e.currentTarget as HTMLElement).style.background = "none";
                (e.currentTarget as HTMLElement).style.color = "var(--c-text-3)";
              }}
            >
              <svg width="10" height="10" viewBox="0 0 10 10" fill="none">
                <path d="M1 1l8 8M9 1L1 9" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
              </svg>
            </button>
          )}
        </div>
      </div>

      {stats && (
        <>
          <div
            style={{ height: 5, borderRadius: 3, background: "var(--c-surface-2)", marginBottom: 6, cursor: "pointer", overflow: "hidden" }}
            title={`${((1 - nullFraction) * 100).toFixed(1)}% non-null · ${(nullFraction * 100).toFixed(1)}% null`}
          >
            <div style={{ display: "flex", height: "100%" }}>
              <div
                style={{ width: `${(1 - nullFraction) * 100}%`, background: "var(--c-accent)", borderRadius: "3px 0 0 3px", cursor: "pointer" }}
                onClick={() => addPredicate({ op: "is_not_null", column: colInfo.name })}
                title="Filter: is not null"
              />
              {nullFraction > 0 && (
                <div
                  style={{ flex: 1, background: "#fca5a5", borderRadius: "0 3px 3px 0", cursor: "pointer" }}
                  onClick={() => addPredicate({ op: "is_null", column: colInfo.name })}
                  title="Filter: is null"
                />
              )}
            </div>
          </div>

          <div style={{ display: "flex", justifyContent: "space-between", fontSize: 10, color: "var(--c-text-3)", marginBottom: 8 }}>
            <span>{nonNullCount.toLocaleString()} non-null</span>
            {stats.null_count > 0 && <span>{stats.null_count.toLocaleString()} null</span>}
          </div>

          <HistogramPanel
            stats={stats}
            isApproximate={isApproximate}
            barHeight={barHeight}
            dragStart={dragStart}
            dragEnd={dragEnd}
            onBucketClick={handleHistogramClick}
            onDragEnd={handleHistogramDragEnd}
            onDragStart={setDragStart}
            onDragOver={(i) => { if (dragStart !== null) setDragEnd(i); }}
          />

          {stats.min !== null && stats.max !== null && (
            <div style={{ display: "flex", justifyContent: "space-between", fontSize: 10, color: "var(--c-text-3)", marginBottom: 8 }}>
              <span>{String(stats.min)}</span>
              {isPinned && stats.mean !== null && (
                <span style={{ color: "var(--c-text-2)" }}>avg {typeof stats.mean === "number" ? stats.mean.toPrecision(4) : stats.mean}</span>
              )}
              <span>{String(stats.max)}</span>
            </div>
          )}

          {isPinned && stats.distinct_count !== null && stats.distinct_count !== undefined && (
            <div style={{ fontSize: 10, color: "var(--c-text-3)", marginBottom: 8 }}>
              {stats.distinct_count.toLocaleString()} distinct values
            </div>
          )}
        </>
      )}

      {(loading || progressive.isLoading) && !stats && (
        <div style={{ fontSize: 11, color: "var(--c-text-3)", padding: "4px 0" }}>Loading…</div>
      )}

      {isApproximate && (
        <div style={{ fontSize: 10, color: "var(--c-text-3)", marginBottom: 6, fontStyle: "italic" }}>approximate</div>
      )}

      <input
        value={customInput}
        onChange={(e) => setCustomInput(e.target.value)}
        onKeyDown={(e) => { if (e.key === "Enter") submitCustom(customInput); }}
        placeholder="> 100 · contains foo · = active"
        style={{
          width: "100%",
          padding: "5px 8px",
          border: "1px solid var(--c-border)",
          borderRadius: 6,
          fontSize: 11,
          outline: "none",
          boxSizing: "border-box",
          marginTop: 2,
          color: "var(--c-text)",
          background: "var(--c-surface)",
          fontFamily: "ui-monospace, monospace",
        }}
      />
    </div>
  );
}
