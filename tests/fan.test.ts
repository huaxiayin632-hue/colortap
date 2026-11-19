import { describe, expect, it } from 'vitest';
import {
  createProject,
  type FanReveal,
  type Layer,
  type RevealClip,
  type Vec2,
} from '../src/shared/models';
import { serializeProject, validateProject } from '../src/shared/schema';
import { identityTransform } from '../src/core/layers';
import { fanPolygon, fanSector } from '../src/core/fan';
import { RevealEvaluator, RevealTake } from '../src/core/reveal';
import { createSlider } from '../src/core/chart';
import { PlaySession } from '../src/core/judgement';

const effect = (patch: Partial<FanReveal> = {}): FanReveal => ({
  kind: 'fan',
  center: { x: 0.5, y: 1 },
  startAngleRad: -Math.PI,
  sweepAngleRad: Math.PI,
  direction: 'clockwise',
  mode: 'open',
  ...patch,
});
const bounds = { x: 10, y: 20, width: 200, height: 100 };
function inside(poly: Vec2[], q: Vec2) {
  let result = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i],
      b = poly[j];
    if (a.y > q.y !== b.y > q.y && q.x < ((b.x - a.x) * (q.y - a.y)) / (b.y - a.y) + a.x)
      result = !result;
  }
  return result;
}
function polygon(e: FanReveal, p: number) {
  const s = fanSector(e, p);
  return fanPolygon(bounds, s.center, s.startAngleRad, s.sweepAngleRad);
}
function fixture(e = effect()) {
  const p = createProject(),
    id = crypto.randomUUID();
  const layer: Layer = {
    id,
    name: '扇形组',
    kind: 'group',
    childrenBottomToTop: [],
    isolation: 'pass-through',
    transform: identityTransform(),
    opacity: 1,
    enabled: true,
    locked: false,
    initialReveal: 0,
    blendMode: 'normal',
  };
  p.layers[id] = layer;
  p.rootLayersBottomToTop = [id];
  const clip: RevealClip = {
    id: crypto.randomUUID(),
    layerId: id,
    trigger: { kind: 'timeline', at: { basis: 'time', timeUs: 1000000 } },
    effect: e,
    easing: 'linear',
    progress: { kind: 'elapsed', duration: { basis: 'time', durationUs: 1000000 } },
    after: 'hold',
    priority: 0,
  };
  p.reveals[clip.id] = clip;
  return { p, layer, clip };
}

describe('fan mask geometry', () => {
  it('opens from the bottom hinge and reaches all four image corners without clipping them', () => {
    expect(polygon(effect(), 0)).toEqual([]);
    const half = polygon(effect(), 0.5),
      full = polygon(effect(), 1);
    expect(inside(half, { x: 60, y: 70 })).toBe(true);
    expect(inside(half, { x: 160, y: 70 })).toBe(false);
    for (const q of [
      { x: 10.01, y: 20.01 },
      { x: 209.99, y: 20.01 },
      { x: 10.01, y: 119.99 },
      { x: 209.99, y: 119.99 },
    ])
      expect(inside(full, q)).toBe(true);
  });
  it('reverses sweep order without moving the final sector, and closes from the chosen edge', () => {
    const left = { x: 60, y: 70 },
      right = { x: 160, y: 70 };
    const reverse = polygon(effect({ direction: 'counterclockwise' }), 0.5);
    expect(inside(reverse, left)).toBe(false);
    expect(inside(reverse, right)).toBe(true);
    const closing = polygon(effect({ mode: 'close' }), 0.5);
    expect(inside(closing, left)).toBe(false);
    expect(inside(closing, right)).toBe(true);
    const closingReverse = polygon(effect({ mode: 'close', direction: 'counterclockwise' }), 0.5);
    expect(inside(closingReverse, left)).toBe(true);
    expect(inside(closingReverse, right)).toBe(false);
    expect(polygon(effect({ mode: 'close' }), 1)).toEqual([]);
    expect(polygon(effect({ direction: 'counterclockwise' }), 1)).toEqual(polygon(effect(), 1));
  });
  it('handles concave sectors above 180 degrees and an exact full turn', () => {
    const rect = { x: 0, y: 0, width: 100, height: 100 },
      center = { x: 0.5, y: 0.5 };
    const q = fanPolygon(rect, center, 0, Math.PI * 1.5);
    for (const point of [
      { x: 75, y: 75 },
      { x: 25, y: 75 },
      { x: 25, y: 25 },
    ])
      expect(inside(q, point)).toBe(true);
    expect(inside(q, { x: 75, y: 25 })).toBe(false);
    expect(fanPolygon(rect, center, 0, Math.PI * 2)).toHaveLength(4);
    expect(q.length).toBeLessThan(70);
  });
  it('keeps geometry finite and bounded for arbitrary start angles, edge pivots and thin wedges', () => {
    for (const center of [
      { x: 0, y: 0 },
      { x: 1, y: 1 },
      { x: 0.1, y: 0.8 },
    ])
      for (const start of [-Math.PI * 10, Math.PI * 8, 1e12])
        for (const sweep of [0.00001, Math.PI, Math.PI * 2 - 0.001]) {
          const q = fanPolygon(bounds, center, start, sweep);
          expect(q.length).toBeLessThan(70);
          expect(q.every((p) => Number.isFinite(p.x) && Number.isFinite(p.y))).toBe(true);
        }
  });
});

describe('fan animation state and persistence', () => {
  it('seeks in either direction, retains partial sectors, and hides completely after closing', () => {
    const { p, layer, clip } = fixture(effect({ sweepAngleRad: Math.PI / 2 }));
    const originalTransform = structuredClone(layer.transform);
    let r = new RevealEvaluator(p);
    expect(r.evaluate(0, { mode: 'preview' })[layer.id].alpha).toBe(0);
    const halfway = r.evaluate(1500000, { mode: 'preview' })[layer.id];
    const end = r.evaluate(2000000, { mode: 'preview' })[layer.id];
    expect(end.mask?.kind).toBe('fan');
    expect(r.evaluate(1500000, { mode: 'preview' })[layer.id]).toEqual(halfway);
    clip.effect = effect({ mode: 'close', sweepAngleRad: Math.PI * 2 });
    layer.initialReveal = 1;
    r = new RevealEvaluator(p);
    expect(r.evaluate(0, { mode: 'preview' })[layer.id].alpha).toBe(1);
    expect(r.evaluate(1000000, { mode: 'preview' })[layer.id].mask).toBeNull();
    expect(r.evaluate(2000000, { mode: 'preview' })[layer.id].alpha).toBe(0);
    expect(r.evaluate(9000000, { mode: 'preview' })[layer.id].alpha).toBe(0);
    clip.after = 'restore';
    expect(new RevealEvaluator(p).evaluate(2000000, { mode: 'preview' })[layer.id].alpha).toBe(1);
    expect(layer.transform).toEqual(originalTransform);
  });
  it('uses eased music progress and freezes Follow when the player releases the Slider', () => {
    const { p, layer, clip } = fixture();
    clip.easing = 'ease-in';
    let state = new RevealEvaluator(p).evaluate(1500000, { mode: 'preview' })[layer.id];
    expect(state.mask?.kind === 'fan' && state.mask.sweepAngleRad).toBeCloseTo(Math.PI * 0.25);
    const { note, path } = createSlider(
      { x: 0, y: 0 },
      { x: 100, y: 0 },
      { basis: 'time', timeUs: 1000000 },
    );
    note.duration = { basis: 'time', durationUs: 1000000 };
    note.followRadius = 1000;
    p.notes[note.id] = note;
    p.paths[path.id] = path;
    clip.trigger = { kind: 'note', noteId: note.id, event: 'slider-start' };
    clip.progress = { kind: 'slider-follow', noteId: note.id };
    clip.easing = 'linear';
    const take = new RevealTake(),
      session = new PlaySession(p, 0, (e) => take.accept(e), undefined, take.recordTrack);
    session.input(1000000, { x: 0, y: 0 }, true, true);
    session.input(1400000, { x: 40, y: 0 }, false);
    session.advance(2000000);
    const r = new RevealEvaluator(p);
    state = r.evaluate(9000000, { mode: 'playtest', take })[layer.id];
    expect(state.mask?.kind === 'fan' && state.mask.sweepAngleRad).toBeCloseTo(Math.PI * 0.4);
    expect(r.evaluate(9000000, { mode: 'playtest', take: new RevealTake() })[layer.id].alpha).toBe(
      0,
    );
  });
  it('round-trips parameters and rejects malformed centers and angular ranges', () => {
    const { p, clip } = fixture(
      effect({ center: { x: 0.25, y: 0.75 }, mode: 'close', direction: 'counterclockwise' }),
    );
    expect(validateProject(JSON.parse(serializeProject(p))).reveals[clip.id].effect).toEqual(
      clip.effect,
    );
    for (const patch of [
      { center: { x: -0.1, y: 1 } },
      { center: { x: 0, y: 1.1 } },
      { sweepAngleRad: -1 },
      { sweepAngleRad: Math.PI * 3 },
      { startAngleRad: Infinity },
    ]) {
      const invalid = structuredClone(p);
      invalid.reveals[clip.id].effect = { ...clip.effect, ...patch };
      expect(() => validateProject(invalid)).toThrow();
    }
  });
});
