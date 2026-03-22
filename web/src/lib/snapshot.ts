import type { ViewOp } from "./viewExpr";

export interface ViewportSnapshot {
  sourceId: string;
  ops: ViewOp[];
  zoom: number;
  scrollX: number;
  scrollY: number;
}

export async function createSnapshot(snap: ViewportSnapshot): Promise<string> {
  const res = await fetch("/api/v1/snapshots", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      source_id: snap.sourceId,
      ops: snap.ops,
      zoom: snap.zoom,
      scroll_x: snap.scrollX,
      scroll_y: snap.scrollY,
    }),
  });
  if (!res.ok) throw new Error(`snapshot create failed: ${res.status}`);
  const data = (await res.json()) as { id: string; share_path: string };
  return data.share_path;
}

export async function fetchSnapshot(id: string): Promise<ViewportSnapshot> {
  const res = await fetch(`/api/v1/snapshots/${id}`);
  if (!res.ok) throw new Error(`snapshot not found: ${id}`);
  const data = (await res.json()) as {
    source_id: string;
    ops: ViewOp[];
    zoom: number;
    scroll_x: number;
    scroll_y: number;
  };
  return {
    sourceId: data.source_id,
    ops: data.ops,
    zoom: data.zoom,
    scrollX: data.scroll_x,
    scrollY: data.scroll_y,
  };
}
