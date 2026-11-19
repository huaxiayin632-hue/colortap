import type { Easing } from '../shared/models';
const clamp = (v: number) => Math.max(0, Math.min(1, v));
const axis = (s: number, a: number, b: number) =>
  3 * (1 - s) ** 2 * s * a + 3 * (1 - s) * s * s * b + s ** 3;
function parameter(t: number, x1: number, x2: number): number {
  let lo = 0,
    hi = 1;
  for (let i = 0; i < 32; i++) {
    const mid = (lo + hi) / 2;
    if (axis(mid, clamp(x1), clamp(x2)) < t) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}
/** Inverts the Bezier's X axis rather than treating its parameter as elapsed time. */
export function easeProgress(value: number, easing: Easing): number {
  const t = clamp(value);
  if (easing === 'linear') return t;
  if (easing === 'ease-in') return t * t;
  if (easing === 'ease-out') return 1 - (1 - t) ** 2;
  if (easing === 'ease-in-out') return t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2;
  const [x1, y1, x2, y2] = easing.cubicBezier;
  return clamp(axis(parameter(t, x1, x2), y1, y2));
}
function yCritical(y1: number, y2: number): number[] {
  const a = 3 * (1 - 3 * y2 + 3 * y1),
    b = 2 * (3 * y2 - 6 * y1),
    c = 3 * y1;
  if (Math.abs(a) < 1e-12) return Math.abs(b) < 1e-12 ? [] : [-c / b].filter((s) => s > 0 && s < 1);
  const d = b * b - 4 * a * c;
  if (d < 0) return [];
  return [(-b - Math.sqrt(d)) / (2 * a), (-b + Math.sqrt(d)) / (2 * a)]
    .filter((s) => s > 0 && s < 1)
    .sort((a, b) => a - b);
}
/** A stroke can grow but must not retract, even for an imported overshooting easing curve. */
export function outlineDrawProgress(value: number, easing: Easing): number {
  const t = clamp(value);
  if (t === 0 || t === 1) return t;
  if (typeof easing === 'string') return easeProgress(t, easing);
  const [x1, y1, x2, y2] = easing.cubicBezier,
    s = parameter(t, x1, x2);
  return clamp(
    Math.max(
      0,
      axis(s, y1, y2),
      ...yCritical(y1, y2)
        .filter((k) => k < s)
        .map((k) => axis(k, y1, y2)),
    ),
  );
}
/** First input progress at which the actual eased stroke length reaches the requested threshold. */
export function outlineThresholdProgress(value: number, easing: Easing): number {
  const q = clamp(value);
  if (q === 0) return 0;
  if (easing === 'linear') return q;
  if (easing === 'ease-in') return Math.sqrt(q);
  if (easing === 'ease-out') return 1 - Math.sqrt(1 - q);
  if (easing === 'ease-in-out') return q < 0.5 ? Math.sqrt(q / 2) : 1 - Math.sqrt((1 - q) / 2);
  const [x1, y1, x2, y2] = easing.cubicBezier,
    points = [0, ...yCritical(y1, y2), 1];
  for (let i = 1; i < points.length; i++) {
    let lo = points[i - 1],
      hi = points[i];
    if (axis(lo, y1, y2) >= q) return axis(lo, clamp(x1), clamp(x2));
    if (axis(hi, y1, y2) < q) continue;
    for (let j = 0; j < 40; j++) {
      const mid = (lo + hi) / 2;
      if (axis(mid, y1, y2) < q) lo = mid;
      else hi = mid;
    }
    return axis((lo + hi) / 2, clamp(x1), clamp(x2));
  }
  return 1;
}
