export type ViewportSize = { width: number; height: number };

/** Frame-rate independent, non-overshooting follow. Never a simulation clock. */
export function followScroll(
  current: number,
  target: number,
  deltaMs: number,
  mobile: boolean,
) {
  if (!Number.isFinite(current) || !Number.isFinite(target)) return 0;
  const dt = Math.max(0, Math.min(64, Number.isFinite(deltaMs) ? deltaMs : 0));
  const remaining = target - current;
  if (Math.abs(remaining) < 0.0002) return target;
  return current + remaining * (1 - Math.exp(-dt / (mobile ? 85 : 120)));
}

/** Browser chrome height pulses are not orientation/layout changes. */
export function shouldResizeDrawingBuffer(
  previous: ViewportSize,
  next: ViewportSize,
  mobile: boolean,
) {
  if (next.width < 1 || next.height < 1) return false;
  if (Math.abs(next.width - previous.width) > 1) return true;
  if (Math.abs(next.height - previous.height) <= 1) return false;
  if (!mobile) return true;
  return (
    Math.abs(next.height - previous.height) / Math.max(1, previous.height) >
    0.25
  );
}
