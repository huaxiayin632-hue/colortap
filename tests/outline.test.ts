import { describe, expect, it } from 'vitest';
import {
  createProject,
  type Layer,
  type RevealClip,
  type OutlineReveal,
} from '../src/shared/models';
import { createSlider } from '../src/core/chart';
import { identityTransform } from '../src/core/layers';
import { ArcPath, createNode } from '../src/core/path';
import { outlineRanges, orientedSamples, sliceSamples } from '../src/core/outline';
import {
  RevealEvaluator,
  RevealTake,
  outlineStages,
  resolveRevealPath,
  sliderRevealPath,
} from '../src/core/reveal';
import { PlaySession } from '../src/core/judgement';
import { EditHistory } from '../src/application/history';
import { serializeProject, validateProject } from '../src/shared/schema';
import { outlineDrawProgress, outlineThresholdProgress } from '../src/core/easing';

function fixture() {
  const p = createProject('描线', { width: 6000, height: 6000 });
  const l: Layer = {
    id: crypto.randomUUID(),
    kind: 'group',
    name: '完整图层',
    childrenBottomToTop: [],
    isolation: 'isolated',
    transform: identityTransform(),
    opacity: 0.37,
    enabled: true,
    locked: false,
    initialReveal: 0,
    blendMode: 'normal',
  };
  p.layers[l.id] = l;
  p.rootLayersBottomToTop = [l.id];
  const { note: n, path } = createSlider(
    { x: 0, y: 0 },
    { x: 100, y: 0 },
    { basis: 'time', timeUs: 1000000 },
  );
  n.duration = { basis: 'time', durationUs: 1000000 };
  n.followRadius = 1000;
  p.notes[n.id] = n;
  p.paths[path.id] = path;
  const e: OutlineReveal = {
    kind: 'outline',
    path: { pathId: path.id, transform: identityTransform() },
    drawing: { mode: 'single', start: 0, forwardRatio: 0.5 },
    stroke: { color: '#ffffff', width: 4, glow: 1, tips: true, tipSize: 5 },
    layer: { kind: 'fade', threshold: 1, durationUs: 400000, fromScale: 0.2, overshoot: 0.1 },
    lineAfter: { kind: 'fade', durationUs: 300000 },
  };
  const c: RevealClip = {
    id: crypto.randomUUID(),
    layerId: l.id,
    trigger: { kind: 'note', noteId: n.id, event: 'slider-start' },
    effect: e,
    easing: 'linear',
    progress: { kind: 'slider-timeline', noteId: n.id },
    after: 'hold',
    priority: 0,
  };
  p.reveals[c.id] = c;
  return { p, l, n, path, e, c };
}
const total = (v: ReturnType<typeof outlineRanges>) =>
  v.ranges.reduce((n, r) => n + r.to - r.from, 0);
describe('opposing arc-length drawing branches', () => {
  it('draws an open Single forward and physically reverses its endpoints', () => {
    const f = fixture(),
      arc = new ArcPath(f.path),
      d = { mode: 'single' as const, start: 0.6, forwardRatio: 0.5 };
    const a = outlineRanges(0.25, false, false, d),
      b = outlineRanges(0.25, false, true, d);
    expect(a.ranges).toEqual([{ from: 0, to: 0.25 }]);
    expect(arc.at(a.tips[0]).x).toBeCloseTo(25);
    expect(arc.at(b.tips[0], true).x).toBeCloseTo(75);
  });
  it('wraps a closed Single from an arbitrary origin without doubling its length', () => {
    const r = outlineRanges(0.5, true, false, { mode: 'single', start: 0.75, forwardRatio: 0.5 });
    expect(r.ranges).toEqual([
      { from: 0, to: 0.25 },
      { from: 0.75, to: 1 },
    ]);
    expect(r.tips[0]).toBeCloseTo(0.25);
    expect(total(r)).toBe(0.5);
  });
  it('draws two genuinely opposing closed branches and meets at the ratio-determined point', () => {
    const d = { mode: 'bidirectional' as const, start: 0, forwardRatio: 0.5 },
      r = outlineRanges(0.5, true, false, d);
    expect(r.ranges).toEqual([
      { from: 0, to: 0.25 },
      { from: 0.75, to: 1 },
    ]);
    expect(r.tips).toEqual([0.25, 0.75]);
    const unequal = { ...d, start: 0.2, forwardRatio: 0.25 },
      half = outlineRanges(0.8, true, false, unequal),
      full = outlineRanges(1, true, false, unequal);
    expect(total(half)).toBeCloseTo(0.8);
    expect(half.tips[0]).toBeCloseTo(0.4);
    expect(half.tips[1]).toBeCloseTo(0.6);
    expect(full.ranges).toEqual([{ from: 0, to: 1 }]);
    expect(full.tips).toHaveLength(1);
    expect(full.tips[0]).toBeCloseTo(0.45);
  });
  it('keeps the selected starting point fixed when reversing a closed path', () => {
    const d = { mode: 'bidirectional' as const, start: 0.2, forwardRatio: 0.25 };
    const a = outlineRanges(0, true, false, d),
      b = outlineRanges(0, true, true, d);
    expect(a.tips[0]).toBeCloseTo(0.2);
    expect(1 - b.tips[0]).toBeCloseTo(0.2);
    const full = outlineRanges(1, true, true, d);
    expect(full.tips).toHaveLength(1);
    expect(1 - full.tips[0]).toBeCloseTo(0.95);
  });
  it('redistributes speed at open endpoints and covers every open path exactly once', () => {
    for (const reversed of [false, true])
      for (const start of [0, 0.2, 0.5, 1])
        for (const forwardRatio of [0, 0.1, 0.5, 0.9, 1])
          for (const p of [0, 0.2, 0.65, 1]) {
            const r = outlineRanges(p, false, reversed, {
              mode: 'bidirectional',
              start,
              forwardRatio,
            });
            expect(total(r)).toBeCloseTo(p, 9);
            expect(r.tips.every((n) => n >= -1e-10 && n <= 1 + 1e-10)).toBe(true);
          }
    expect(
      outlineRanges(0.5, false, false, { mode: 'bidirectional', start: 0.2, forwardRatio: 0.1 })
        .ranges[0].to,
    ).toBeCloseTo(0.5);
  });
  it('slices boundary chunks by distance, including reversed and zero-length samples', () => {
    const f = fixture(),
      arc = new ArcPath(f.path),
      forward = sliceSamples(orientedSamples(arc, false), 10, 20),
      back = sliceSamples(orientedSamples(arc, true), 10, 20);
    expect(forward[0].x).toBeCloseTo(10);
    expect(forward.at(-1)!.x).toBeCloseTo(20);
    expect(back[0].x).toBeCloseTo(90);
    expect(back.at(-1)!.x).toBeCloseTo(80);
    expect(
      sliceSamples(
        [
          { point: { x: 0, y: 0 }, distance: 0 },
          { point: { x: 0, y: 0 }, distance: 0 },
        ],
        0,
        1,
      ),
    ).toEqual([]);
  });
});

describe('independent white-line and intact PSD phases', () => {
  it('triggers on eased stroke length, so ease-in at a 25% threshold starts after 50% input progress', () => {
    const { p, c, e, l } = fixture();
    c.easing = 'ease-in';
    e.layer.threshold = 0.25;
    const evaluator = new RevealEvaluator(p);
    expect(evaluator.evaluate(1490000, { mode: 'preview' })[l.id].alpha).toBe(0);
    expect(
      evaluator.evaluate(1500000, { mode: 'preview' })[l.id].outline?.transitionUs,
    ).toBeCloseTo(1500000);
    expect(outlineStages(p, c)?.layerStart).toBeCloseTo(1500000);
  });
  it('inverts eased Follow length before integrating the exact valid tracking threshold', () => {
    const { p, c, e, n, l } = fixture();
    c.easing = 'ease-out';
    e.layer.threshold = 0.75;
    c.progress = { kind: 'slider-follow', noteId: n.id };
    const take = new RevealTake(),
      session = new PlaySession(p, 0, (event) => take.accept(event), undefined, take.recordTrack);
    session.input(1000000, { x: 0, y: 0 }, true, true);
    session.advance(1600000);
    const state = new RevealEvaluator(p).evaluate(1600000, { mode: 'playtest', take })[l.id];
    expect(state.outline?.transitionUs).toBeCloseTo(1500000);
    expect(state.progress).toBeCloseTo(0.84);
  });
  it('prevents imported overshooting easing curves from retracting already drawn line sections', () => {
    const easing = { cubicBezier: [0.2, 2, 0.8, -1] as [number, number, number, number] };
    let previous = 0;
    for (let i = 0; i <= 100; i++) {
      const p = outlineDrawProgress(i / 100, easing);
      expect(p + 1e-10).toBeGreaterThanOrEqual(previous);
      previous = p;
    }
    const at = outlineThresholdProgress(0.7, easing);
    expect(outlineDrawProgress(at, easing)).toBeCloseTo(0.7, 6);
    expect(outlineDrawProgress(Math.max(0, at - 0.01), easing)).toBeLessThan(0.7);
  });
  it('keeps PSD pixels fully hidden while drawing and fades the intact layer after the threshold', () => {
    const { p, l } = fixture(),
      e = new RevealEvaluator(p);
    const half = e.evaluate(1500000, { mode: 'preview' })[l.id];
    expect(half.alpha).toBe(0);
    expect(half.mask).toBeNull();
    expect(half.outline?.phase).toBe('drawing');
    expect(total(half.outline!)).toBeCloseTo(0.5);
    const revealing = e.evaluate(2200000, { mode: 'preview' })[l.id];
    expect(revealing.alpha).toBeCloseTo(0.5);
    expect(revealing.outline?.opacity).toBeCloseTo(1 / 3);
    expect(revealing.mask).toBeNull();
    const full = e.evaluate(2500000, { mode: 'preview' })[l.id];
    expect(full.alpha).toBe(1);
    expect(full.outline?.opacity).toBe(0);
    expect(p.layers[l.id].opacity).toBe(0.37);
  });
  it('supports Instant, Fade and Pop and preserves original colors/transform/opacity data', () => {
    const { p, l, e } = fixture(),
      before = serializeProject(p);
    for (const kind of ['instant', 'fade', 'pop'] as const) {
      e.layer.kind = kind;
      const state = new RevealEvaluator(p).evaluate(2200000, { mode: 'preview' })[l.id];
      expect(state.alpha).toBe(kind === 'instant' ? 1 : 0.5);
      expect(state.mask).toBeNull();
      if (kind === 'pop') expect(state.scale).toBeGreaterThan(0.2);
    }
    e.layer.kind = 'fade';
    expect(serializeProject(p)).toBe(before);
  });
  it('allows retaining, fading or removing the independent line at transition', () => {
    const { p, l, e } = fixture();
    for (const [kind, opacity] of [
      ['keep', 1],
      ['hide', 0],
      ['fade', 0.5],
    ] as const) {
      e.lineAfter.kind = kind;
      expect(
        new RevealEvaluator(p).evaluate(2150000, { mode: 'preview' })[l.id].outline?.opacity,
      ).toBeCloseTo(opacity);
    }
  });
  it('restores arbitrary times in any order, including both phases and after replay', () => {
    const { p, l } = fixture(),
      e = new RevealEvaluator(p),
      before = serializeProject(p);
    const times = [2400000, 1250000, 2200000, 0, 1900000, 2600000, 1250000];
    for (const time of times) {
      const a = e.evaluate(time, { mode: 'preview' })[l.id],
        b = new RevealEvaluator(p).evaluate(time, { mode: 'edit' })[l.id];
      expect(a.alpha).toBe(b.alpha);
      expect(a.outline?.opacity).toBe(b.outline?.opacity);
      expect(a.outline?.ranges).toEqual(b.outline?.ranges);
    }
    expect(serializeProject(p)).toBe(before);
  });
  it('Follow release freezes drawing and cannot start the layer before real accumulated progress crosses the threshold', () => {
    const { p, l, n, e, c } = fixture();
    c.progress = { kind: 'slider-follow', noteId: n.id };
    e.layer.threshold = 0.6;
    const take = new RevealTake(),
      s = new PlaySession(p, 0, (event) => take.accept(event), undefined, take.recordTrack);
    s.input(1000000, { x: 0, y: 0 }, true, true);
    s.input(1400000, { x: 40, y: 0 }, false);
    s.advance(1800000);
    const evalr = new RevealEvaluator(p),
      a = evalr.evaluate(1800000, { mode: 'playtest', take })[l.id];
    expect(a.rawProgress).toBeCloseTo(0.4);
    expect(a.alpha).toBe(0);
    expect(a.outline?.transitionUs).toBeNull();
    s.input(1800000, { x: 80, y: 0 }, true);
    s.advance(2000000);
    expect(
      evalr.evaluate(2000000, { mode: 'playtest', take })[l.id].outline?.transitionUs,
    ).toBeCloseTo(2000000);
    expect(evalr.evaluate(2200000, { mode: 'playtest', take })[l.id].alpha).toBeCloseTo(0.5);
    expect(evalr.evaluate(1800000, { mode: 'playtest', take })[l.id].rawProgress).toBeCloseTo(0.4);
  });
  it('does not turn a game completion into full drawing or fake an unplayed head', () => {
    const { p, l, n, c } = fixture();
    c.progress = { kind: 'slider-follow', noteId: n.id };
    p.rules.sliderCompleteRatio = 0.5;
    const take = new RevealTake(),
      s = new PlaySession(p, 0, (event) => take.accept(event), undefined, take.recordTrack);
    s.input(1000000, { x: 0, y: 0 }, true, true);
    s.input(1600000, { x: 60, y: 0 }, false);
    s.advance(2200000);
    expect(s.snapshot().results[n.id].status).toBe('complete');
    expect(new RevealEvaluator(p).evaluate(5000000, { mode: 'playtest', take })[l.id].alpha).toBe(
      0,
    );
    s.advance(5000000);
    const noTake = new RevealTake();
    expect(
      new RevealEvaluator(p).evaluate(5000000, { mode: 'playtest', take: noTake })[l.id].outline,
    ).toBeUndefined();
  });
  it('computes the exact threshold-crossing timestamp independently of snapshot/update frequency', () => {
    const { p, n, c, e, l } = fixture();
    c.progress = { kind: 'slider-follow', noteId: n.id };
    e.layer.threshold = 0.5;
    for (const updates of [[2000000], [1250000, 1300000, 1400000, 1700000, 2000000]]) {
      const take = new RevealTake(),
        s = new PlaySession(p, 0, (event) => take.accept(event), undefined, take.recordTrack);
      s.input(1000000, { x: 0, y: 0 }, true, true);
      for (const at of updates) s.advance(at);
      expect(
        new RevealEvaluator(p).evaluate(1600000, { mode: 'playtest', take })[l.id].outline
          ?.transitionUs,
      ).toBeCloseTo(1500000);
    }
  });
  it('manual audition spans the drawing and layer phases, including the finished full layer', () => {
    const { p, l, c } = fixture(),
      e = new RevealEvaluator(p);
    const a = e.evaluate(0, { mode: 'edit', override: { clipId: c.id, progress: 0.25 } })[l.id];
    expect(a.alpha).toBe(0);
    expect(a.outline?.phase).toBe('drawing');
    const b = e.evaluate(0, { mode: 'edit', override: { clipId: c.id, progress: 1 } })[l.id];
    expect(b.alpha).toBe(1);
    expect(b.outline?.phase).toBe('complete');
  });
  it('restores initial state after both phases rather than hiding the layer at draw completion', () => {
    const { p, l, c } = fixture();
    c.after = 'restore';
    const e = new RevealEvaluator(p);
    expect(e.evaluate(2100000, { mode: 'preview' })[l.id].alpha).toBeGreaterThan(0);
    expect(e.evaluate(2500000, { mode: 'preview' })[l.id].alpha).toBe(0);
  });
  it('serializes every outline setting and link, and deletes/undoes by stable IDs', () => {
    const { p, e, c, n, l } = fixture();
    e.drawing = { mode: 'bidirectional', start: 0.38, forwardRatio: 0.72 };
    e.stroke = { color: '#12aaff', width: 7, glow: 2, tips: false, tipSize: 4 };
    e.linkedSliderId = n.id;
    const restored = validateProject(JSON.parse(serializeProject(p)));
    expect(serializeProject(restored)).toBe(serializeProject(p));
    const h = new EditHistory(p);
    h.execute({ type: 'delete-reveal', id: c.id, restoreVisibility: true });
    expect(h.current.layers[l.id].initialReveal).toBe(1);
    h.undo();
    expect(h.current.reveals[c.id]).toEqual(c);
    h.execute({ type: 'delete-notes', ids: [n.id] });
    expect(h.current.reveals).toEqual({});
    h.undo();
    expect(h.current.reveals[c.id].effect).toEqual(e);
  });
  it('continues to resolve independent copies and live Slider-linked paths for the new type', () => {
    const { p, e, n } = fixture(),
      copy = sliderRevealPath(p, n.id, false);
    p.paths[copy.path.id] = copy.path;
    e.path = copy.instance;
    const independent = resolveRevealPath(p, e);
    e.linkedSliderId = n.id;
    n.path.transform.position.x = 50;
    expect(resolveRevealPath(p, e).transform.position.x).not.toBe(independent.transform.position.x);
    expect(copy.path.id).not.toBe(n.path.pathId);
  });
  it('shows two separately timed phases, using nominal success for Follow track positions', () => {
    const { p, c, e } = fixture();
    e.layer.threshold = 0.75;
    expect(outlineStages(p, c)).toMatchObject({
      drawStart: 1000000,
      drawEnd: 2000000,
      layerStart: 1750000,
      layerEnd: 2150000,
      totalEnd: 2150000,
    });
    c.progress = { kind: 'elapsed', duration: { basis: 'time', durationUs: 0 } };
    e.layer.kind = 'instant';
    expect(outlineStages(p, c)?.layerStart).toBe(1000000);
  });
});
