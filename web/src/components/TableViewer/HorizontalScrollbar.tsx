import { useRef, useEffect, useCallback } from "react";

interface Props {
  totalCols: number;
  viewportCols: number;
  scrollCol: number;
  onScrollCol: (col: number) => void;
  width: number;
  isDark: boolean;
}

const HEIGHT = 14;
const ARROW_W = 16;

export function HorizontalScrollbar({ totalCols, viewportCols, scrollCol, onScrollCol, width, isDark }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  const pointerCaptured = useRef(false);
  const dragStartX = useRef(0);
  const dragStartCol = useRef(0);

  const trackW = width - ARROW_W * 2;

  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    ctx.clearRect(0, 0, width, HEIGHT);

    ctx.fillStyle = isDark ? "#1e293b" : "#f1f5f9";
    ctx.fillRect(0, 0, width, HEIGHT);

    const thumbW = Math.max(12, (viewportCols / Math.max(1, totalCols)) * trackW);
    const thumbX = ARROW_W + (scrollCol / Math.max(1, totalCols - viewportCols)) * (trackW - thumbW);

    ctx.fillStyle = isDark ? "#475569" : "#94a3b8";
    ctx.beginPath();
    ctx.roundRect(thumbX, 2, thumbW, HEIGHT - 4, 3);
    ctx.fill();

    ctx.fillStyle = isDark ? "#64748b" : "#94a3b8";
    ctx.font = "9px sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText("◀", ARROW_W / 2, HEIGHT / 2);
    ctx.fillText("▶", width - ARROW_W / 2, HEIGHT / 2);
  }, [width, trackW, totalCols, viewportCols, scrollCol, isDark]);

  useEffect(() => {
    draw();
  }, [draw]);

  const getThumbBounds = () => {
    const thumbW = Math.max(12, (viewportCols / Math.max(1, totalCols)) * trackW);
    const thumbX = ARROW_W + (scrollCol / Math.max(1, totalCols - viewportCols)) * (trackW - thumbW);
    return { thumbX, thumbW };
  };

  const handlePointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    e.preventDefault();
    const offsetX = e.nativeEvent.offsetX;

    if (offsetX < ARROW_W) {
      onScrollCol(Math.max(0, scrollCol - 3));
      return;
    }
    if (offsetX > width - ARROW_W) {
      onScrollCol(Math.min(totalCols - viewportCols, scrollCol + 3));
      return;
    }

    const { thumbX, thumbW } = getThumbBounds();
    if (offsetX >= thumbX && offsetX <= thumbX + thumbW) {
      pointerCaptured.current = true;
      dragStartX.current = offsetX;
      dragStartCol.current = scrollCol;
      (e.currentTarget as HTMLCanvasElement).setPointerCapture(e.pointerId);
    } else {
      const newCol = ((offsetX - ARROW_W) / trackW) * totalCols;
      onScrollCol(Math.max(0, Math.min(totalCols - viewportCols, Math.round(newCol))));
    }
  };

  const handlePointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!pointerCaptured.current) return;
    const deltaX = e.nativeEvent.offsetX - dragStartX.current;
    const newCol = dragStartCol.current + (deltaX / trackW) * totalCols;
    onScrollCol(Math.max(0, Math.min(totalCols - viewportCols, Math.round(newCol))));
  };

  const handlePointerUp = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (pointerCaptured.current) {
      pointerCaptured.current = false;
      (e.currentTarget as HTMLCanvasElement).releasePointerCapture(e.pointerId);
    }
  };

  return (
    <canvas
      ref={canvasRef}
      width={width}
      height={HEIGHT}
      style={{ display: "block", cursor: "default", flexShrink: 0 }}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
    />
  );
}
