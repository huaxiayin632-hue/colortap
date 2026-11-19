import { describe, expect, it } from 'vitest';
import {
  createProject,
  type Layer,
  type Note,
  type Project,
  type RevealClip,
  type RevealEffect,
} from '../src/shared/models';
import { serializeProject, validateProject } from '../src/shared/schema';
import { EditHistory } from '../src/application/history';
import { createSlider } from '../src/core/chart';
import { identityTransform, matrix, point } from '../src/core/layers';
import { PlaySession } from '../src/core/judgement';
import { ArcPath } from '../src/core/path';
import {
  directionalPolygon,
  easeProgress,
  layerBounds,
  nominalClipRange,
  resolveRevealPath,
  RevealEvaluator,
  revealMatrix,
  RevealTake,
  sliderRevealPath,
} from '../src/core/reveal';

function fixture() {
  const p = createProject('显现测试', { width: 1024, height: 768 }),
    assetId = crypto.randomUUID(),
    sourceId = crypto.randomUUID(),
    id = crypto.randomUUID();
  p.assets[assetId] = {
    id: assetId,
    kind: 'png',
    relativePath: `assets/${assetId}.png`,
    originalName: '原图.png',
    sha256: 'a'.repeat(64),
    byteLength: 100,
    pixelSize: { width: 1024, height: 768 },
  };
  p.pixelSources[sourceId] = {
    id: sourceId,
    sourceAssetId: assetId,
    originalBounds: { x: 100, y: 50, width: 300, height: 200 },
    cropRect: { x: 10, y: 20, width: 200, height: 100 },
    levels: [],
  };
  const layer: Layer = {
    id,
    kind: 'raster',
    name: '图层',
    pixelSourceId: sourceId,
    transform: identityTransform(),
    opacity: 0.6,
    enabled: true,
    locked: false,
    initialReveal: 0,
    blendMode: 'normal',
  };
  layer.transform.position = { x: 100, y: 50 };
  p.layers[id] = layer;
  p.rootLayersBottomToTop = [id];
  const circle: Note = {
    id: crypto.randomUUID(),
    kind: 'circle',
    at: { basis: 'time', timeUs: 1000000 },
    position: { x: 40, y: 50 },
    radius: 24,
  };
  const { note: slider, path } = createSlider(
    { x: 0, y: 0 },
    { x: 100, y: 0 },
    { basis: 'time', timeUs: 2000000 },
  );
  slider.duration = { basis: 'time', durationUs: 1000000 };
  slider.followRadius = 1000;
  p.notes[circle.id] = circle;
  p.notes[slider.id] = slider;
  p.paths[path.id] = path;
  const clip: RevealClip = {
    id: crypto.randomUUID(),
    layerId: id,
    trigger: { kind: 'note', noteId: circle.id, event: 'hit' },
    effect: { kind: 'fade' },
    easing: 'linear',
    progress: { kind: 'elapsed', duration: { basis: 'time', durationUs: 1000000 } },
    after: 'hold',
    priority: 0,
  };
  p.reveals[clip.id] = clip;
  return { p, layer, circle, slider, path, clip };
}
const state = (p: Project, time: number, take?: RevealTake) =>
  new RevealEvaluator(p).evaluate(time, { mode: take ? 'playtest' : 'preview', take });

describe('deterministic layer reveal evaluation', () => {
  it('round-trips every effect, bindings, delays, initial state, path links and reuse without runtime data', () => {
    const { p, clip, slider } = fixture();
    const linked = sliderRevealPath(p, slider.id, true);
    const effects: RevealEffect[] = [
      { kind: 'instant' },
      { kind: 'fade' },
      { kind: 'slide-in', offset: { x: -200, y: 60 } },
      { kind: 'pop', fromScale: 0.2, overshoot: 0.18 },
      {
        kind: 'directional',
        direction: { x: 1, y: 1 },
        region: { x: 1, y: 2, width: 300, height: 40 },
      },
      {
        kind: 'path',
        path: linked.instance,
        linkedSliderId: slider.id,
        maskWidth: 55,
        completion: 'keep-mask',
      },
    ];
    for (const effect of effects) {
      const c = { ...clip, id: crypto.randomUUID(), effect, delayUs: 1000 };
      p.reveals[c.id] = c;
    }
    const restored = validateProject(JSON.parse(serializeProject(p)));
    expect(serializeProject(restored)).toBe(serializeProject(p));
    expect(serializeProject(restored)).not.toContain('trackedUs');
    const old = structuredClone(p);
    for (const c of Object.values(old.reveals)) delete c.delayUs;
    expect(validateProject(old).reveals[clip.id].delayUs).toBeUndefined();
  });
  it('computes elapsed time from the trigger on any seek, in any evaluation order', () => {
    const { p, layer } = fixture(),
      e = new RevealEvaluator(p),
      original = serializeProject(p);
    for (const [time, alpha] of [
      [2500000, 1],
      [500000, 0],
      [1500000, 0.5],
      [1000000, 0],
      [1750000, 0.75],
      [500000, 0],
    ]) {
      expect(e.evaluate(time, { mode: 'preview' })[layer.id].alpha).toBeCloseTo(alpha);
    }
    expect(serializeProject(p)).toBe(original);
  });
  it('uses exact interval evidence for Follow and never fabricates a Circle hit', () => {
    const { p, layer, circle, clip } = fixture(),
      take = new RevealTake(),
      session = new PlaySession(p, 0, (e) => take.accept(e), undefined, take.recordTrack);
    session.advance(1050000);
    expect(state(p, 1500000, take)[layer.id].alpha).toBe(0);
    session.input(1050000, circle.position, true, true);
    expect(state(p, 1550000, take)[layer.id].alpha).toBe(0.5);
    expect(state(p, 1049999, take)[layer.id].started).toBe(false);
    clip.delayUs = 100000;
    expect(state(p, 1550000, take)[layer.id].alpha).toBe(0.4);
  });
  it('does not simulate misses or failed Sliders in a successful Preview', () => {
    const { p, layer, clip, slider } = fixture();
    clip.trigger = { kind: 'note', noteId: slider.id, event: 'slider-fail' };
    expect(state(p, 5000000)[layer.id].started).toBe(false);
    clip.trigger = { kind: 'note', noteId: slider.id, event: 'miss' };
    expect(state(p, 5000000)[layer.id].started).toBe(false);
  });
  it('can trigger a separate layer after a real Slider completion', () => {
    const { p, clip, slider, layer } = fixture();
    clip.trigger = { kind: 'note', noteId: slider.id, event: 'slider-complete' };
    clip.effect = { kind: 'instant' };
    const take = new RevealTake(),
      s = new PlaySession(p, 0, (e) => take.accept(e), undefined, take.recordTrack);
    s.input(2000000, { x: 0, y: 0 }, true, true);
    s.advance(3000000);
    expect(state(p, 2999999, take)[layer.id].alpha).toBe(0);
    expect(state(p, 3000000, take)[layer.id].alpha).toBe(1);
  });
  it('Timeline and Follow differ during release, pause and a late re-press', () => {
    const { p, clip, slider, layer } = fixture();
    clip.trigger = { kind: 'note', noteId: slider.id, event: 'slider-start' };
    clip.progress = { kind: 'slider-follow', noteId: slider.id };
    const take = new RevealTake(),
      s = new PlaySession(p, 0, (e) => take.accept(e), undefined, take.recordTrack);
    s.input(2000000, { x: 0, y: 0 }, true, true);
    s.input(2400000, { x: 40, y: 0 }, false);
    s.advance(2700000);
    expect(state(p, 2700000, take)[layer.id].rawProgress).toBeCloseTo(0.4);
    expect(state(p, 2500000, take)[layer.id].rawProgress).toBeCloseTo(0.4);
    expect(state(p, 2200000, take)[layer.id].rawProgress).toBeCloseTo(0.2);
    const paused = state(p, 2700000, take);
    expect(state(p, 2700000, take)).toEqual(paused);
    s.input(2700000, { x: 70, y: 0 }, true);
    s.advance(3000000);
    expect(state(p, 3500000, take)[layer.id].rawProgress).toBeCloseTo(0.7);
    clip.progress = { kind: 'slider-timeline', noteId: slider.id };
    expect(state(p, 2700000, take)[layer.id].rawProgress).toBeCloseTo(0.7);
    expect(state(p, 3500000, take)[layer.id].rawProgress).toBe(1);
  });
  it('preserves a partial path even if the game awards Slider completion', () => {
    const { p, clip, slider, layer } = fixture();
    p.rules.sliderCompleteRatio = 0.5;
    clip.trigger = { kind: 'note', noteId: slider.id, event: 'slider-start' };
    clip.progress = { kind: 'slider-follow', noteId: slider.id };
    clip.effect = {
      kind: 'path',
      path: sliderRevealPath(p, slider.id, true).instance,
      linkedSliderId: slider.id,
      maskWidth: 40,
      completion: 'show-full-layer',
    };
    const take = new RevealTake(),
      s = new PlaySession(p, 0, (e) => take.accept(e), undefined, take.recordTrack);
    s.input(2000000, { x: 0, y: 0 }, true, true);
    s.input(2600000, { x: 50, y: 0 }, false);
    s.advance(3000000);
    expect(s.snapshot().results[slider.id].status).toBe('complete');
    const a = state(p, 9000000, take)[layer.id];
    expect(a.rawProgress).toBeCloseTo(0.6);
    expect(a.mask?.kind).toBe('path');
    expect(state(p, 3000000)[layer.id].mask).toBeNull();
    clip.effect.completion = 'keep-mask';
    expect(state(p, 3000000)[layer.id].mask?.progress).toBe(1);
  });
  it('a missed head reveals nothing even when Slider timeline has ended', () => {
    const { p, clip, slider, layer } = fixture();
    clip.trigger = { kind: 'note', noteId: slider.id, event: 'slider-start' };
    clip.progress = { kind: 'slider-timeline', noteId: slider.id };
    const take = new RevealTake(),
      s = new PlaySession(p, 0, (e) => take.accept(e), undefined, take.recordTrack);
    s.advance(4000000);
    expect(state(p, 4000000, take)[layer.id].alpha).toBe(0);
  });
  it('truncates future evidence at a seek and ignores obsolete run events', () => {
    const { p, circle } = fixture(),
      take = new RevealTake(),
      s = new PlaySession(p, 0, (e) => take.accept(e), undefined, take.recordTrack);
    s.input(1000000, circle.position, true, true);
    take.accept({ kind: 'session-reset', runId: 'new', timeUs: 500000, reason: 'seek' });
    expect(take.events).toHaveLength(0);
    take.accept({ kind: 'circle-hit', noteId: circle.id, runId: s.runId, timeUs: 1000000 });
    expect(take.events).toHaveLength(0);
    take.accept({ kind: 'circle-hit', noteId: circle.id, runId: 'new', timeUs: 1000000 });
    expect(take.events).toHaveLength(1);
    take.accept({ kind: 'session-reset', runId: 'third', timeUs: 0, reason: 'restart' });
    expect(take.events).toHaveLength(0);
  });
  it('clips a recorded interval exactly at the seek time', () => {
    const take = new RevealTake();
    take.tracks.set('n', [
      { startUs: 100, endUs: 500, valid: true },
      { startUs: 500, endUs: 700, valid: false },
      { startUs: 700, endUs: 1000, valid: true },
    ]);
    take.seek(800);
    expect(take.follow('n', 1000, 100, 1000)).toBe(0.5);
    expect(take.tracks.get('n')?.at(-1)?.endUs).toBe(800);
  });
  it('evaluates seconds and beats across variable BPM with the same time base', () => {
    const { p, clip, layer } = fixture();
    p.timing.points.push({ id: crypto.randomUUID(), tick: 1920, bpm: 60, meter: [4, 4] });
    clip.trigger = { kind: 'timeline', at: { basis: 'time', timeUs: 500000 } };
    clip.progress = { kind: 'elapsed', duration: { basis: 'beat', ticks: 1920 } };
    expect(nominalClipRange(p, clip).duration).toBe(1500000);
    expect(state(p, 1250000)[layer.id].rawProgress).toBe(0.5);
  });
  it('all six effects compute correct random-access state without changing layer transforms', () => {
    const { p, clip, layer } = fixture(),
      before = structuredClone(layer.transform);
    clip.effect = { kind: 'instant' };
    expect(state(p, 1000000)[layer.id].alpha).toBe(1);
    clip.effect = { kind: 'slide-in', offset: { x: -200, y: 40 } };
    expect(state(p, 1500000)[layer.id].offset).toEqual({ x: -100, y: 20 });
    clip.effect = { kind: 'pop', fromScale: 0.2, overshoot: 0 };
    const popped = state(p, 1500000)[layer.id];
    expect(popped.scale).toBeCloseTo(0.6);
    const r = layerBounds(p, layer.id),
      center = { x: r.x + r.width / 2, y: r.y + r.height / 2 };
    expect(point(revealMatrix(matrix(layer.transform), r, popped), center)).toEqual(
      point(matrix(layer.transform), center),
    );
    clip.effect = { kind: 'directional', direction: { x: 1, y: 0 } };
    expect(state(p, 1500000)[layer.id].mask?.kind).toBe('directional');
    expect(state(p, 2000000)[layer.id].mask).toBeNull();
    expect(layer.transform).toEqual(before);
  });
  it('uses easing endpoints and inverts a custom Bezier timing curve', () => {
    for (const e of ['linear', 'ease-in', 'ease-out', 'ease-in-out'] as const) {
      expect(easeProgress(0, e)).toBe(0);
      expect(easeProgress(1, e)).toBe(1);
    }
    expect(easeProgress(0.5, 'ease-out')).toBe(0.75);
    expect(easeProgress(0.5, { cubicBezier: [0, 0, 1, 1] })).toBeCloseTo(0.5, 8);
  });
  it('clips arbitrary directional reveal angles including negative directions', () => {
    const r = { x: 10, y: 20, width: 100, height: 80 };
    expect(Math.max(...directionalPolygon(r, { x: 1, y: 0 }, 0.5).map((p) => p.x))).toBe(60);
    expect(Math.min(...directionalPolygon(r, { x: -1, y: 0 }, 0.5).map((p) => p.x))).toBe(60);
    expect(directionalPolygon(r, { x: 1, y: 1 }, 1)).toHaveLength(4);
  });
  it('resolves simultaneous clips deterministically, restores initial state and handles unbound hidden layers', () => {
    const { p, clip, layer } = fixture();
    clip.after = 'restore';
    expect(state(p, 2000000)[layer.id].alpha).toBe(0);
    const other = {
      ...clip,
      id: crypto.randomUUID(),
      priority: 1,
      after: 'hold' as const,
      effect: { kind: 'instant' as const },
    };
    p.reveals[other.id] = other;
    expect(state(p, 1500000)[layer.id].clipId).toBe(other.id);
    p.reveals = Object.fromEntries(Object.entries(p.reveals).reverse());
    expect(state(p, 1500000)[layer.id].clipId).toBe(other.id);
    p.reveals = {};
    expect(state(p, 1500000)[layer.id].alpha).toBe(0);
  });
  it('copies freeze geometry while links follow node, position and direction changes', () => {
    const { p, slider, clip } = fixture(),
      copied = sliderRevealPath(p, slider.id, false),
      linked = sliderRevealPath(p, slider.id, true);
    p.paths[copied.path.id] = copied.path;
    const e: Extract<RevealEffect, { kind: 'path' }> = {
      kind: 'path',
      path: linked.instance,
      linkedSliderId: slider.id,
      maskWidth: 30,
      completion: 'keep-mask',
    };
    const a = new ArcPath(
      p.paths[resolveRevealPath(p, e).pathId],
      resolveRevealPath(p, e).transform,
    ).at(0);
    slider.path.transform.position.x += 20;
    slider.path.reversed = true;
    p.paths[slider.path.pathId].nodes[0].point.y += 30;
    const use = resolveRevealPath(p, e),
      b = new ArcPath(p.paths[use.pathId], use.transform).at(0);
    expect(b.x - a.x).toBeCloseTo(40);
    expect(b.y - a.y).toBeCloseTo(60);
    expect(use.reversed).toBe(true);
    expect(copied.path.id).not.toBe(linked.path.id);
    expect(copied.path.nodes[0].point.y).toBe(0);
    expect(new ArcPath(copied.path, copied.instance.transform).at(0)).toEqual(a);
    clip.effect = e;
    expect(validateProject(JSON.parse(serializeProject(p))).reveals[clip.id].effect).toEqual(e);
  });
  it('shares cached arc geometry at every evaluated time rather than rebuilding it per frame', () => {
    const { p, clip, slider, layer } = fixture();
    clip.effect = {
      kind: 'path',
      path: sliderRevealPath(p, slider.id, true).instance,
      maskWidth: 30,
      completion: 'keep-mask',
    };
    const e = new RevealEvaluator(p),
      a = e.evaluate(1250000, { mode: 'preview' })[layer.id].mask,
      b = e.evaluate(1750000, { mode: 'preview' })[layer.id].mask;
    expect(a?.kind === 'path' && b?.kind === 'path' && a.arc === b.arc).toBe(true);
  });
  it('bindings, deletion and undo remain atomic, including a path linked from another trigger', () => {
    const { p, clip, slider, layer } = fixture(),
      h = new EditHistory(p);
    h.execute({ type: 'delete-reveal', id: clip.id });
    expect(h.current.reveals).toEqual({});
    h.undo();
    expect(h.current.reveals[clip.id]).toEqual(clip);
    h.execute({ type: 'delete-layer', id: layer.id });
    expect(h.current.reveals).toEqual({});
    h.undo();
    const use = sliderRevealPath(p, slider.id, true);
    clip.effect = {
      kind: 'path',
      path: use.instance,
      linkedSliderId: slider.id,
      maskWidth: 30,
      completion: 'keep-mask',
    };
    const h2 = new EditHistory(p);
    h2.execute({ type: 'delete-notes', ids: [slider.id] });
    expect(h2.current.reveals).toEqual({});
    h2.undo();
    expect(h2.current.reveals[clip.id].effect).toEqual(clip.effect);
  });
  it('supports 100 simultaneous clips on a 6000-pixel artwork without a dimensions or layer cap', () => {
    const { p, layer, clip } = fixture();
    p.stage.artworkSize = { width: 6000, height: 6000 };
    p.reveals = {};
    for (let i = 0; i < 100; i++) {
      const l = { ...structuredClone(layer), id: crypto.randomUUID() };
      p.layers[l.id] = l;
      p.rootLayersBottomToTop.push(l.id);
      const c = { ...structuredClone(clip), id: crypto.randomUUID(), layerId: l.id };
      p.reveals[c.id] = c;
    }
    const restored = validateProject(JSON.parse(serializeProject(p))),
      s = new RevealEvaluator(restored).evaluate(1500000, { mode: 'preview' });
    expect(Object.values(s).filter((v) => v.started)).toHaveLength(100);
    expect(
      Object.values(s)
        .filter((v) => v.started)
        .every((v) => v.progress === 0.5),
    ).toBe(true);
  });
  it('rejects dangling live links and invalid source types before an edit is published', () => {
    const { p, clip, slider, circle } = fixture();
    clip.effect = {
      kind: 'path',
      path: slider.path,
      linkedSliderId: circle.id,
      maskWidth: 30,
      completion: 'keep-mask',
    };
    expect(() => validateProject(p)).toThrow(/关联路径/);
    clip.effect.linkedSliderId = crypto.randomUUID();
    expect(() => validateProject(p)).toThrow(/关联 Slider/);
  });
});
