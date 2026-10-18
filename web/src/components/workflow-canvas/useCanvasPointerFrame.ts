import { useCallback, useEffect, useRef } from "react";

/** Coalesce native pointer bursts without delaying the authoritative release
 * position. Callers cancel before committing pointer-up/cancel/unmount. */
export function useCanvasPointerFrame(coalesce: boolean) {
  const frame = useRef<number>();
  const pending = useRef<() => void>();
  const cancel = useCallback(() => {
    if (frame.current !== undefined) cancelAnimationFrame(frame.current);
    frame.current = undefined;
    pending.current = undefined;
  }, []);
  useEffect(() => cancel, [cancel, coalesce]);
  const schedule = useCallback((update: () => void) => {
    if (!coalesce || typeof requestAnimationFrame === "undefined") { cancel(); update(); return; }
    pending.current = update;
    if (frame.current !== undefined) return;
    frame.current = requestAnimationFrame(() => {
      frame.current = undefined;
      const latest = pending.current;
      pending.current = undefined;
      latest?.();
    });
  }, [coalesce, cancel]);
  return { schedule, cancel };
}
