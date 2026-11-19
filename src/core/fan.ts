import type { FanReveal, Rect, Vec2 } from '../shared/models';

const TAU = Math.PI * 2;
const clamp01 = (n: number) => Math.max(0, Math.min(1, n));

/** Keep the final sector fixed when changing the direction of its moving edge. */
export function fanSector(effect: FanReveal, progress: number) {
  const p = clamp01(progress),
    range = Math.max(0, Math.min(TAU, effect.sweepAngleRad)),
    visible = effect.mode === 'open' ? p : 1 - p,
    fromStart = (effect.mode === 'open') === (effect.direction === 'clockwise');
  return {
    center: effect.center,
    startAngleRad: effect.startAngleRad + (fromStart ? 0 : range * (1 - visible)),
    sweepAngleRad: range * visible,
  };
}

/** A bounded vector wedge; its outer edge always extends beyond the target pixels. */
export function fanPolygon(
  bounds: Rect,
  center: Vec2,
  startAngleRad: number,
  sweepAngleRad: number,
): Vec2[] {
  const sweep = Math.max(0, Math.min(TAU, sweepAngleRad));
  if (sweep <= 1e-10) return [];
  const corners = [
    { x: bounds.x, y: bounds.y },
    { x: bounds.x + bounds.width, y: bounds.y },
    { x: bounds.x + bounds.width, y: bounds.y + bounds.height },
    { x: bounds.x, y: bounds.y + bounds.height },
  ];
  if (sweep >= TAU - 1e-10) return corners;
  const origin = {
      x: bounds.x + bounds.width * center.x,
      y: bounds.y + bounds.height * center.y,
    },
    segments = Math.max(1, Math.ceil(sweep / (Math.PI / 32))),
    step = sweep / segments,
    // Circumscribe the sampled arc so tessellation cannot clip a distant corner.
    radius =
      Math.max(...corners.map((p) => Math.hypot(p.x - origin.x, p.y - origin.y))) /
        Math.cos(step / 2) +
      1,
    start = startAngleRad % TAU,
    polygon = [origin];
  for (let i = 0; i <= segments; i++) {
    const angle = start + step * i;
    polygon.push({
      x: origin.x + Math.cos(angle) * radius,
      y: origin.y + Math.sin(angle) * radius,
    });
  }
  return polygon;
}
