import { describe, it, expect } from 'vitest';
import {
  createProject,
  type Project,
  type SoundCue,
  type CameraKey,
  type RevealClip,
} from '../src/shared/models';
import { SoundPlanner, nominalSoundTime, revealSoundTimes } from '../src/core/sound';
import { RevealTake } from '../src/core/reveal';
import { PlaySession } from '../src/core/judgement';
import { createSlider } from '../src/core/chart';
import { CameraEvaluator, cameraMatrix, neutralCamera, cameraViewBounds } from '../src/core/camera';
import { point, inverse, identityTransform } from '../src/core/layers';
import { EditHistory } from '../src/application/history';
import { serializeProject, validateProject } from '../src/shared/schema';

const id = () => crypto.randomUUID();
function fixture() {
  const p = createProject('演出'),
    assetId = id(),
    circle = id();
  p.assets[assetId] = {
    id: assetId,
    kind: 'audio',
    audioRole: 'sfx',
    originalName: 'click.wav',
    relativePath: `assets/audio/${assetId}.wav`,
    sha256: 'a'.repeat(64),
    byteLength: 100,
  };
  p.notes[circle] = {
    id: circle,
    kind: 'circle',
    at: { basis: 'time', timeUs: 1e6 },
    position: { x: 100, y: 100 },
    radius: 24,
  };
  const s = createSlider({ x: 100, y: 100 }, { x: 300, y: 100 }, { basis: 'time', timeUs: 2e6 });
  s.note.duration = { basis: 'time', durationUs: 2e6 };
  p.notes[s.note.id] = s.note;
  p.paths[s.path.id] = s.path;
  return { p, assetId, circle, slider: s.note };
}
function cue(p: Project, assetId: string, trigger: SoundCue['trigger'], delayUs = 0) {
  const c: SoundCue = { id: id(), assetId, trigger, delayUs, gain: 0.7, pan: -0.3 };
  p.sounds[c.id] = c;
  return c;
}
function outline(p: Project, noteId: string) {
  const layerId = id();
  p.layers[layerId] = {
    id: layerId,
    kind: 'group',
    name: '人物',
    transform: identityTransform(),
    opacity: 0.5,
    enabled: true,
    locked: false,
    initialReveal: 0,
    blendMode: 'normal',
    isolation: 'isolated',
    childrenBottomToTop: [],
  };
  p.rootLayersBottomToTop.push(layerId);
  const clip: RevealClip = {
    id: id(),
    layerId,
    trigger: { kind: 'note', noteId, event: 'slider-start' },
    effect: {
      kind: 'outline',
      path:
        p.notes[noteId].kind === 'slider'
          ? p.notes[noteId].path
          : { pathId: '', transform: identityTransform() },
      drawing: { mode: 'bidirectional', start: 0.3, forwardRatio: 0.6 },
      stroke: { color: '#ffffff', width: 10, glow: 1, tips: true, tipSize: 12 },
      layer: { kind: 'fade', threshold: 0.5, durationUs: 300000, fromScale: 0.2, overshoot: 0.1 },
      lineAfter: { kind: 'fade', durationUs: 200000 },
    },
    easing: 'ease-in',
    progress: { kind: 'slider-follow', noteId },
    after: 'hold',
    priority: 0,
  };
  p.reveals[clip.id] = clip;
  return clip;
}
describe('sound scheduling on the unified music timeline', () => {
  it('places Miss cues and their reveal phases at the expected deadline, including delays and saved rules', () => {
    const { p, assetId, circle, slider } = fixture(),
      clip = outline(p, slider.id);
    p.notes[circle].at = { basis: 'beat', tick: 1920 };
    clip.trigger = { kind: 'note', noteId: circle, event: 'miss' };
    clip.delayUs = 100000;
    clip.effect = { kind: 'fade' };
    clip.progress = { kind: 'elapsed', duration: { basis: 'time', durationUs: 400000 } };
    const miss = cue(p, assetId, clip.trigger, 50000),
      start = cue(p, assetId, { kind: 'reveal-start', revealId: clip.id }, 50000),
      layer = cue(p, assetId, { kind: 'layer-reveal', revealId: clip.id }, 50000);
    expect(nominalSoundTime(p, miss)).toBe(1150000);
    expect(nominalSoundTime(p, start)).toBe(1250000);
    expect(nominalSoundTime(p, layer)).toBe(1650000);
    const history = new EditHistory(p);
    history.execute({
      type: 'set-rules',
      rules: { ...p.rules, hitWindowsUs: { ...p.rules.hitWindowsUs, good: 150000 } },
    });
    const restored = validateProject(JSON.parse(serializeProject(history.current)));
    expect(nominalSoundTime(restored, restored.sounds[miss.id])).toBe(1200000);
    expect(nominalSoundTime(restored, restored.sounds[start.id])).toBe(1300000);
    expect(nominalSoundTime(restored, restored.sounds[layer.id])).toBe(1700000);
    history.undo();
    expect(nominalSoundTime(history.current, miss)).toBe(1150000);
  });
  it('uses the real Miss event for playback rather than predicting a failure from the marker', () => {
    const { p, assetId, circle } = fixture(),
      miss = cue(p, assetId, { kind: 'note', noteId: circle, event: 'miss' }, 120000),
      take = new RevealTake(),
      session = new PlaySession(p, 0, (event) => take.accept(event)),
      plan = new SoundPlanner(p);
    expect(nominalSoundTime(p, miss)).toBe(1220000);
    expect(plan.collect(1050000, 'playtest', take, 2e6)).toEqual([]);
    session.advance(1200000);
    expect(plan.collect(1210000, 'playtest', take)).toEqual([]);
    expect(plan.collect(1250000, 'playtest', take).map((e) => e.timeUs)).toEqual([1220000]);
    expect(new SoundPlanner(p).collect(2e6, 'preview', take)).toEqual([]);
  });
  it('schedules time zero once, supports lookahead and independent stacked cues', () => {
    const { p, assetId } = fixture();
    const a = cue(p, assetId, { kind: 'timeline', at: { basis: 'time', timeUs: 0 } }),
      b = cue(p, assetId, { kind: 'timeline', at: { basis: 'time', timeUs: 0 } });
    const plan = new SoundPlanner(p);
    plan.reset(0);
    expect(plan.collect(0, 'preview', new RevealTake(), 100000).map((x) => x.cueId)).toEqual(
      [a.id, b.id].sort(),
    );
    expect(plan.collect(10000, 'preview', new RevealTake(), 100000)).toEqual([]);
  });
  it('cancels lookahead on pause, re-arms future cues and never repeats consumed ones', () => {
    const { p, assetId } = fixture();
    cue(p, assetId, { kind: 'timeline', at: { basis: 'time', timeUs: 100000 } });
    const plan = new SoundPlanner(p);
    plan.reset(0);
    expect(plan.collect(50000, 'preview', new RevealTake(), 150000)).toHaveLength(1);
    plan.pause(60000);
    expect(plan.collect(70000, 'preview', new RevealTake(), 160000)).toHaveLength(1);
    plan.pause(120000);
    expect(plan.collect(130000, 'preview', new RevealTake(), 230000)).toHaveLength(0);
  });
  it('seek suppresses past sounds and replay starts a fresh epoch', () => {
    const { p, assetId } = fixture();
    cue(p, assetId, { kind: 'timeline', at: { basis: 'time', timeUs: 1e6 } });
    const plan = new SoundPlanner(p);
    plan.reset(2e6);
    expect(plan.collect(3e6, 'preview', new RevealTake())).toEqual([]);
    plan.reset(0);
    expect(plan.collect(1e6, 'preview', new RevealTake())).toHaveLength(1);
  });
  it('real Circle Miss does not play a hit cue; preview simulates successful hits', () => {
    const { p, assetId, circle } = fixture();
    cue(p, assetId, { kind: 'note', noteId: circle, event: 'hit' });
    const take = new RevealTake(),
      session = new PlaySession(p, 0, (e) => take.accept(e)),
      plan = new SoundPlanner(p);
    session.advance(1200000);
    expect(plan.collect(1200000, 'playtest', take)).toEqual([]);
    expect(new SoundPlanner(p).collect(1200000, 'preview', new RevealTake())).toHaveLength(1);
  });
  it('real Circle hit uses its input timestamp and configured delay', () => {
    const { p, assetId, circle } = fixture();
    cue(p, assetId, { kind: 'note', noteId: circle, event: 'hit' }, 120000);
    const take = new RevealTake(),
      session = new PlaySession(p, 0, (e) => take.accept(e)),
      plan = new SoundPlanner(p);
    session.input(1010000, { x: 100, y: 100 }, true, true);
    expect(plan.collect(1100000, 'playtest', take)).toEqual([]);
    expect(plan.collect(1140000, 'playtest', take)[0].timeUs).toBe(1130000);
  });
  it('Slider tick cues only fire for actual valid tracking intervals', () => {
    const { p, assetId, slider } = fixture();
    cue(p, assetId, { kind: 'slider-tick', noteId: slider.id, intervalTicks: 960 });
    const take = new RevealTake();
    take.tracks.set(slider.id, [
      { startUs: 2e6, endUs: 2600000, valid: true },
      { startUs: 2600000, endUs: 4e6, valid: false, reason: 'released' },
    ]);
    const plan = new SoundPlanner(p);
    expect(plan.collect(4e6, 'playtest', take).map((x) => x.timeUs)).toEqual([2500000]);
  });
  it('advances Slider tick scheduling without losing delayed cues, and re-arms after pause/seek', () => {
    const { p, assetId, slider } = fixture();
    cue(p, assetId, { kind: 'slider-tick', noteId: slider.id, intervalTicks: 960 }, 400000);
    const take = new RevealTake();
    take.tracks.set(slider.id, [
      { startUs: 2e6, endUs: 2700000, valid: true },
      { startUs: 2700000, endUs: 3200000, valid: false, reason: 'released' },
      { startUs: 3200000, endUs: 4e6, valid: true },
    ]);
    const plan = new SoundPlanner(p);
    plan.reset(0);
    expect(plan.collect(2500000, 'playtest', take, 2600000)).toEqual([]);
    expect(plan.collect(2800000, 'playtest', take, 2900000).map((e) => e.timeUs)).toEqual([
      2900000,
    ]);
    expect(plan.collect(2800000, 'playtest', take, 2900000)).toEqual([]);
    plan.pause(2850000);
    expect(plan.collect(2860000, 'playtest', take, 2960000).map((e) => e.timeUs)).toEqual([
      2900000,
    ]);
    expect(plan.collect(3800000, 'playtest', take, 3900000).map((e) => e.timeUs)).toEqual([
      3900000,
    ]);
    plan.reset(3000000);
    expect(plan.collect(4e6, 'playtest', take).map((e) => e.timeUs)).toEqual([3900000]);
    plan.reset(0);
    expect(plan.collect(4e6, 'preview', take).map((e) => e.timeUs)).toEqual([
      2900000, 3400000, 3900000,
    ]);
  });
  it('Follow interruption prevents outline completion and delays layer milestone until earned', () => {
    const { p, slider } = fixture(),
      clip = outline(p, slider.id),
      take = new RevealTake(),
      session = new PlaySession(p, 0, (e) => take.accept(e));
    session.input(2e6, { x: 100, y: 100 }, true, true);
    take.tracks.set(slider.id, [
      { startUs: 2e6, endUs: 2500000, valid: true },
      { startUs: 2500000, endUs: 4e6, valid: false, reason: 'released' },
    ]);
    const times = revealSoundTimes(p, clip, 'playtest', take)!;
    expect(times.complete).toBeNull();
    expect(times.layer).toBeNull();
    take.tracks.set(slider.id, [{ startUs: 2e6, endUs: 4e6, valid: true }]);
    expect(revealSoundTimes(p, clip, 'playtest', take)!.layer).toBeCloseTo(
      2e6 + Math.sqrt(0.5) * 2e6 + 300000,
    );
  });
  it('layer reveal and outline completion are separate events and disabled cues stay silent', () => {
    const { p, assetId, slider } = fixture(),
      clip = outline(p, slider.id);
    const a = cue(p, assetId, { kind: 'outline-complete', revealId: clip.id }),
      b = cue(p, assetId, { kind: 'layer-reveal', revealId: clip.id });
    a.enabled = false;
    const plan = new SoundPlanner(p);
    const got = plan.collect(5e6, 'preview', new RevealTake());
    expect(got).toHaveLength(1);
    expect(got[0].cueId).toBe(b.id);
    expect(nominalSoundTime(p, a)).toBe(4e6);
    expect(nominalSoundTime(p, b)).toBeCloseTo(got[0].timeUs, 0);
  });
});
describe('random access camera evaluation', () => {
  function key(
    p: Project,
    at: number,
    x: number,
    zoom: number,
    easing: CameraKey['easingToNext'] = 'linear',
  ) {
    const k: CameraKey = {
      id: id(),
      at: { basis: 'time', timeUs: at },
      position: { x, y: 3000 },
      zoom,
      rotationRad: 0,
      easingToNext: easing,
    };
    p.camera.keys[k.id] = k;
    p.camera.enabled = true;
    return k;
  }
  it('preserves the old artwork composition when no camera has been authored', () => {
    const p = createProject();
    p.stage.artworkSize = { width: 6111, height: 3700 };
    delete p.camera.enabled;
    expect(cameraMatrix(p, new CameraEvaluator(p).at(0))).toEqual({
      a: 1,
      b: -0,
      c: 0,
      d: 1,
      tx: 0,
      ty: 0,
    });
  });
  it('interpolates position/zoom/rotation with the outgoing key easing', () => {
    const p = createProject();
    const a = key(p, 0, 3000, 1, 'ease-in');
    const b = key(p, 2e6, 1000, 3);
    b.rotationRad = 1;
    const v = new CameraEvaluator(p).at(1e6);
    expect(v.position.x).toBe(2500);
    expect(v.zoom).toBe(1.5);
    expect(v.rotationRad).toBe(0.25);
    expect(a.position.x).toBe(3000);
  });
  it('editable cubic easing inverts X rather than using Bezier parameter as time', () => {
    const p = createProject();
    key(p, 0, 3000, 1, { cubicBezier: [0.42, 0, 0.58, 1] });
    key(p, 2e6, 1000, 3);
    expect(new CameraEvaluator(p).at(1e6).zoom).toBeCloseTo(2);
  });
  it('gives the same frame after arbitrary seeks and clamps before/after keys', () => {
    const p = createProject();
    key(p, 0, 3000, 1);
    key(p, 2e6, 1000, 3);
    const e = new CameraEvaluator(p);
    const expected = e.at(1e6);
    e.at(8e6);
    e.at(0);
    expect(e.at(1e6)).toEqual(expected);
    expect(e.at(8e6).zoom).toBe(3);
    expect(e.at(-100).zoom).toBe(1);
  });
  it('shake is deterministic, layered over keys, and vanishes outside its duration', () => {
    const p = createProject();
    p.camera.enabled = true;
    const s = {
      id: id(),
      at: { basis: 'time' as const, timeUs: 1e6 },
      duration: { basis: 'time' as const, durationUs: 500000 },
      amplitude: { x: 100, y: 80 },
      rotationRad: 0.02,
      frequencyHz: 12,
      seed: 3,
    };
    p.camera.shakes = { [s.id]: s };
    const e = new CameraEvaluator(p);
    expect(e.at(1200000)).toEqual(e.at(1200000));
    expect(e.at(1200000).position).not.toEqual(e.at(1200000, false).position);
    expect(e.at(1600000)).toEqual(e.at(1600000, false));
  });
  it('supports a zoom pivot and inverse source viewport without touching note coordinates', () => {
    const p = createProject(),
      before = structuredClone(p.notes),
      pose = neutralCamera(p);
    pose.pivot = { x: 1500, y: 1000 };
    pose.zoom = 2;
    const m = cameraMatrix(p, pose);
    expect(point(m, pose.pivot)).toEqual(pose.pivot);
    expect(point(inverse(m), point(m, { x: 200, y: 300 }))).toEqual({ x: 200, y: 300 });
    expect(cameraViewBounds(m, { x: 0, y: 0, width: 6000, height: 6000 }).width).toBe(3000);
    expect(p.notes).toEqual(before);
  });
});
describe('production persistence and undo', () => {
  it('migrates old optional fields without changing any IDs or bindings', () => {
    const { p, assetId, circle } = fixture();
    cue(p, assetId, { kind: 'note', noteId: circle, event: 'hit' });
    delete p.mixer;
    delete p.tracks;
    delete p.camera.enabled;
    delete p.camera.shakes;
    const loaded = validateProject(JSON.parse(JSON.stringify(p)));
    expect(loaded.notes).toEqual(p.notes);
    expect(loaded.sounds).toEqual(p.sounds);
    expect(loaded.camera.enabled).toBe(false);
    expect(loaded.mixer?.hit.gain).toBe(1);
    expect(loaded.tracks?.order).toHaveLength(6);
  });
  it('round trips SFX, mixer, camera keys, shake and independent track layout', () => {
    const { p, assetId, circle } = fixture();
    cue(p, assetId, { kind: 'note', noteId: circle, event: 'hit' });
    const h = new EditHistory(p),
      k: CameraKey = {
        ...neutralCamera(p),
        id: id(),
        at: { basis: 'time', timeUs: 2e6 },
        zoom: 2,
        easingToNext: { cubicBezier: [0.3, 0, 0.6, 1] },
      };
    h.execute({ type: 'put-camera-key', key: k });
    h.execute({
      type: 'set-tracks',
      tracks: {
        order: ['camera', 'sounds', 'music', 'notes', 'layers', 'outlines'],
        hidden: ['sounds'],
        collapsed: ['camera'],
      },
    });
    const loaded = validateProject(JSON.parse(serializeProject(h.current)));
    expect(loaded.camera.keys[k.id]).toEqual(k);
    expect(loaded.tracks?.order[0]).toBe('camera');
    expect(loaded.rootLayersBottomToTop).toEqual(p.rootLayersBottomToTop);
    h.undo();
    expect(h.current.tracks?.hidden).toEqual([]);
    h.undo();
    expect(h.current.camera.keys[k.id]).toBeUndefined();
    h.redo();
    expect(h.current.camera.keys[k.id]).toEqual(k);
  });
  it('replacement preserves cue IDs and deletion of a reference is undoable', () => {
    const { p, assetId, circle } = fixture();
    const c = cue(p, assetId, { kind: 'note', noteId: circle, event: 'hit' }),
      h = new EditHistory(p),
      replacement = { ...p.assets[assetId], id: id() };
    h.execute({ type: 'put-sfx-asset', asset: replacement, replaceId: assetId });
    expect(h.current.sounds[c.id].assetId).toBe(replacement.id);
    h.execute({ type: 'delete-audio', assetId: replacement.id });
    expect(h.current.sounds[c.id]).toBeUndefined();
    h.undo();
    expect(h.current.sounds[c.id].assetId).toBe(replacement.id);
    h.undo();
    expect(h.current.sounds[c.id].assetId).toBe(assetId);
  });
  it('converts a legacy hold to Circle without losing its identity or event references', () => {
    const { p, assetId, circle } = fixture();
    p.notes[circle] = {
      ...(p.notes[circle] as Extract<Project['notes'][string], { kind: 'circle' }>),
      kind: 'hold',
      duration: { basis: 'time', durationUs: 1e6 },
    };
    const c = cue(p, assetId, { kind: 'note', noteId: circle, event: 'hold-complete' }),
      h = new EditHistory(p);
    h.execute({ type: 'convert-hold', id: circle });
    expect(h.current.notes[circle].kind).toBe('circle');
    expect(h.current.sounds[c.id].trigger).toEqual({ kind: 'note', noteId: circle, event: 'hit' });
    h.undo();
    expect(h.current.notes[circle].kind).toBe('hold');
  });
  it('deletes SFX references without deleting the same asset used for music', () => {
    const { p, assetId, circle } = fixture();
    p.music = { assetId, gain: 0.8 };
    const c = cue(p, assetId, { kind: 'note', noteId: circle, event: 'hit' });
    const h = new EditHistory(p);
    h.execute({ type: 'delete-sfx-reference', id: assetId });
    expect(h.current.music?.assetId).toBe(assetId);
    expect(h.current.assets[assetId]).toEqual(p.assets[assetId]);
    expect(h.current.sounds[c.id]).toBeUndefined();
    h.undo();
    expect(h.current.sounds[c.id]).toEqual(c);
  });
});
