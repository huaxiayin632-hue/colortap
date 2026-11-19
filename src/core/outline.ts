import type { OutlineReveal, Vec2 } from '../shared/models';
import { ArcPath, lerp } from './path';

export type PathRange = { from: number; to: number };
export type DrawRanges = { ranges: PathRange[]; tips: number[] };
const clamp = (n: number) => Math.max(0, Math.min(1, n));
const mod = (n: number) => ((n % 1) + 1) % 1;

/** Arc lengths in oriented path space. Closed paths wrap; the two branches consume disjoint arcs. */
export function outlineRanges(
  progress: number,
  closed: boolean,
  reversed: boolean,
  drawing: OutlineReveal['drawing'],
): DrawRanges {
  const p = clamp(progress),
    start = closed ? mod(drawing.start) : clamp(drawing.start),
    origin = reversed ? 1 - start : start;
  const ranges: PathRange[] = [],
    tips: number[] = [];
  const interval = (a: number, b: number) => {
    if (b - a <= 1e-12) return;
    if (!closed) {
      ranges.push({ from: clamp(a), to: clamp(b) });
      return;
    }
    if (b - a >= 1 - 1e-10) {
      ranges.push({ from: 0, to: 1 });
      return;
    }
    const from = mod(a),
      to = from + (b - a);
    if (to <= 1) ranges.push({ from, to });
    else ranges.push({ from, to: 1 }, { from: 0, to: to - 1 });
  };
  if (drawing.mode === 'single') {
    const from = closed ? mod(origin) : 0;
    interval(from, from + p);
    tips.push(closed ? mod(from + p) : p);
  } else {
    const o = closed ? mod(origin) : origin;
    // When one branch of an open path reaches its endpoint, its unused speed is
    // reassigned to the other branch, so every ratio finishes at progress 1.
    const forward = closed
      ? p * clamp(drawing.forwardRatio)
      : Math.min(1 - o, Math.max(p - o, p * clamp(drawing.forwardRatio)));
    const backward = p - forward;
    interval(o, o + forward);
    interval(o - backward, o);
    tips.push(closed ? mod(o + forward) : o + forward, closed ? mod(o - backward) : o - backward);
  }
  ranges.sort((a, b) => a.from - b.from);
  const merged: PathRange[] = [];
  for (const range of ranges) {
    const previous = merged.at(-1);
    if (previous && range.from <= previous.to + 1e-10)
      previous.to = Math.max(previous.to, range.to);
    else merged.push({ ...range });
  }
  return {
    ranges: merged,
    tips: tips.filter(
      (t, i) =>
        !tips
          .slice(0, i)
          .some(
            (other) =>
              Math.min(Math.abs(t - other), closed ? 1 - Math.abs(t - other) : Infinity) < 1e-8,
          ),
    ),
  };
}

export interface StrokeSample {
  point: Vec2;
  distance: number;
}
export function orientedSamples(arc: ArcPath, reversed: boolean): StrokeSample[] {
  return reversed
    ? [...arc.samples].reverse().map((s) => ({ point: s.point, distance: arc.length - s.distance }))
    : arc.samples;
}
/** Only the boundary chunk is sliced while drawing; static complete chunks are reused. */
export function sliceSamples(samples: readonly StrokeSample[], from: number, to: number): Vec2[] {
  if (to <= from || !samples.length) return [];
  const output: Vec2[] = [];
  for (let i = 1; i < samples.length; i++) {
    const a = samples[i - 1],
      b = samples[i],
      lo = Math.max(from, a.distance),
      hi = Math.min(to, b.distance);
    if (hi <= lo) continue;
    const length = b.distance - a.distance;
    const p = lerp(a.point, b.point, (lo - a.distance) / length),
      q = lerp(a.point, b.point, (hi - a.distance) / length);
    if (!output.length) output.push(p);
    output.push(q);
  }
  return output;
}
