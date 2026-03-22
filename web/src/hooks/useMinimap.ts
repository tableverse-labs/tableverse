import { useState, useEffect, useRef } from "react";
import { useTableStore } from "../stores/table";
import { useViewStore } from "../stores/view";
import { useStatsStore } from "../stores/stats";
import { useUiStore } from "../stores/ui";
import {
  activeMinimapLayer,
  renderMinimapLayer,
  renderMinimapNeutral,
  renderMinimapColumnSeparators,
} from "../lib/minimap-render";

export function useMinimap(panelW: number, panelH: number): ImageData | null {
  const [imageData, setImageData] = useState<ImageData | null>(null);
  const idleRef = useRef<number | null>(null);

  const source = useTableStore((s) => s.source);
  const viewHash = useViewStore((s) => s.viewHash);
  const rowGroupStats = useStatsStore((s) => s.rowGroupStats);
  const allStats = useStatsStore((s) => s.stats);
  const isDark = useUiStore((s) => s.isDark);
  const activeLayers = useUiStore((s) => s.activeLayers);

  useEffect(() => {
    if (!source || panelW <= 0 || panelH <= 0) {
      setImageData(null);
      return;
    }

    const compute = () => {
      const { n_rows: nRows, n_cols: nCols, id: sourceId, quick_stats: quickStats = [] } = source;
      const data = new Uint8ClampedArray(panelW * panelH * 4);

      const layer = activeMinimapLayer(activeLayers);

      if (layer) {
        renderMinimapLayer(
          data, panelW, panelH, nCols, nRows,
          layer, rowGroupStats, allStats,
          quickStats, sourceId, isDark,
        );
        if (nCols <= panelW / 2) {
          renderMinimapColumnSeparators(data, panelW, panelH, nCols, isDark);
        }
      } else {
        const globalNullRate = quickStats.length > 0
          ? quickStats.reduce((s, q) => s + (q?.null_rate ?? 0), 0) / quickStats.length
          : 0;
        renderMinimapNeutral(
          data, panelW, panelH, nCols, nRows,
          globalNullRate, rowGroupStats, sourceId, isDark,
        );
      }

      setImageData(new ImageData(data, panelW, panelH));
    };

    if (idleRef.current !== null) cancelIdleCallback(idleRef.current);

    if (source.n_rows > 5_000_000) {
      idleRef.current = requestIdleCallback(compute);
    } else {
      compute();
    }

    return () => {
      if (idleRef.current !== null) {
        cancelIdleCallback(idleRef.current);
        idleRef.current = null;
      }
    };
  }, [source?.id, viewHash, panelW, panelH, rowGroupStats, allStats, isDark, activeLayers]);

  return imageData;
}
