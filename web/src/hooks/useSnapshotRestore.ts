import { useEffect } from "react";
import { useTableStore } from "../stores/table";
import { useViewStore } from "../stores/view";
import { useUiStore } from "../stores/ui";
import { fetchSnapshot } from "../lib/snapshot";
import { getSource } from "../lib/api";

export function useSnapshotRestore() {
  useEffect(() => {
    const match = window.location.pathname.match(/^\/share\/([a-zA-Z0-9]+)/);
    const snapshotId = match?.[1];
    if (!snapshotId) return;

    fetchSnapshot(snapshotId)
      .then(async (snap) => {
        const source = await getSource(snap.sourceId);
        useTableStore.getState().setSource(source);
        useViewStore.getState().setSourceId(source.id);
        useViewStore.getState().setOps(snap.ops);
        useUiStore.getState().setZoom(snap.zoom);
        requestAnimationFrame(() => {
          useTableStore.getState().setViewport({
            scrollX: snap.scrollX,
            scrollY: snap.scrollY,
          });
        });
        window.history.replaceState(null, "", "/");
      })
      .catch(() => {
        window.history.replaceState(null, "", "/");
      });
  }, []);
}
