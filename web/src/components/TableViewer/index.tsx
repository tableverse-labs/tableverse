import { useRef } from "react";
import { useTableStore } from "../../stores/table";
import { useViewport } from "../../hooks/useViewport";
import { useTiles } from "../../hooks/useTiles";
import { useKeyboard } from "../../hooks/useKeyboard";
import { useRowCount } from "../../hooks/useRowCount";
import { useVirtualSchema } from "../../hooks/useVirtualSchema";
import { useSemanticStats } from "../../hooks/useSemanticStats";
import { useRowGroupStats } from "../../hooks/useRowGroupStats";
import { useCorrelations } from "../../hooks/useCorrelations";
import { ColumnHeader } from "./ColumnHeader";
import { RowHeader } from "./RowHeader";
import { CornerCell } from "./CornerCell";
import { ScrollContainer } from "./ScrollContainer";
import { ColumnDistributionPopover } from "../ColumnDistributionPopover";
import { Minimap } from "../Minimap";
import { ROW_HEADER_W, headerHeightForZoom } from "../../lib/viewport";
import { useUiStore } from "../../stores/ui";

export function TableViewer() {
  const containerRef = useRef<HTMLDivElement>(null);
  const source = useTableStore((s) => s.source);
  const viewport = useTableStore((s) => s.viewport);
  const zoom = useUiStore((s) => s.zoom);
  const minimapVisible = useUiStore((s) => s.minimapVisible);
  const minimapWidth = useUiStore((s) => s.minimapWidth);

  useViewport(containerRef);
  useTiles();
  useKeyboard();
  useRowCount();
  useVirtualSchema();
  useSemanticStats();
  useRowGroupStats();
  useCorrelations();

  const headerH = headerHeightForZoom(zoom);
  const mapW = minimapVisible ? minimapWidth : 12;
  const gridW = Math.max(0, viewport.width - ROW_HEADER_W - mapW);
  const gridH = Math.max(0, viewport.height - headerH);

  return (
    <div
      ref={containerRef}
      style={{ flex: 1, display: "flex", overflow: "hidden" }}
    >
      {source ? (
        <div
          style={{
            flex: 1,
            display: "grid",
            gridTemplateColumns: `${ROW_HEADER_W}px 1fr`,
            gridTemplateRows: `${headerH}px 1fr`,
            overflow: "hidden",
            background: "var(--canvas-bg)",
            border: "1px solid var(--c-border)",
            position: "relative",
            minWidth: 0,
          }}
        >
          <CornerCell headerH={headerH} />
          <ColumnHeader width={gridW} leftOffset={ROW_HEADER_W} />
          <RowHeader height={gridH} />
          <ScrollContainer width={gridW} height={gridH} />
          <ColumnDistributionPopover />
        </div>
      ) : (
        <div
          style={{
            flex: 1,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            color: "var(--c-text-3)",
            fontSize: 14,
            background: "var(--c-bg)",
          }}
        >
          No source loaded. Add a data source to get started.
        </div>
      )}
      <Minimap />
    </div>
  );
}
