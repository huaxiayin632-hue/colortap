import { describe, expect, it } from 'vitest';
import {
  circleAppearance,
  hitParticles,
  HIT_PARTICLE_US,
  sliderAppearance,
  sliderParticles,
  SLIDER_SPARK_US,
} from '../src/core/note-visual';
import { createProject, type Note } from '../src/shared/models';
import { PlaybackTake } from '../src/core/playback';
import { PlaySession, circleGrade } from '../src/core/judgement';
import { ArcPath } from '../src/core/path';
import { createSlider } from '../src/core/chart';
import { LuminousNote } from '../src/renderer/chart/note-visual';
import { Graphics, Texture } from 'pixi.js';

const windows = createProject().rules.hitWindowsUs;

function play() {
  const p = createProject(),
    note: Note = {
      id: crypto.randomUUID(),
      kind: 'circle',
      at: { basis: 'time', timeUs: 2e6 },
      position: { x: 100, y: 100 },
      radius: 24,
    };
  p.notes[note.id] = note;
  const take = new PlaybackTake(),
    session = new PlaySession(p, 0, (e) => take.accept(e));
  return { p, note, take, session };
}
describe('music-time luminous notes', () => {
  it('lights the center on exactly the configured inclusive Perfect window, until hit or skipped', () => {
    for (const perfect of [0, 27_000, 50_000, 100_000]) {
      const rules = { ...windows, perfect };
      for (const offset of [-perfect - 1, -perfect, 0, perfect, perfect + 1]) {
        const state = circleAppearance(2e6 + offset, 2e6, null, 2e6 + rules.good, rules);
        expect(state.perfect).toBe(circleGrade(offset, rules) === 'perfect');
      }
      expect(circleAppearance(2e6, 2e6, 2e6, 2.1e6, rules).perfect).toBe(false);
      expect(circleAppearance(2e6, 2e6, null, 2.1e6, rules, true).perfect).toBe(false);
    }
    const { note } = play(),
      visual = new LuminousNote(note, note.position);
    visual.circle(circleAppearance(1.96e6, 2e6, null, 2.1e6, windows), 1, 0);
    expect(visual.perfectLit).toBe(true);
    visual.circle(circleAppearance(2.06e6, 2e6, null, 2.1e6, windows), 1, 0);
    expect(visual.perfectLit).toBe(false);
    visual.dispose();
  });
  it('reconstructs bounded Slider fireworks from valid intervals, without emissions during release or missed heads', () => {
    const p = createProject(),
      s = createSlider({ x: 100, y: 100 }, { x: 300, y: 100 }, { basis: 'time', timeUs: 2e6 });
    s.note.duration = { basis: 'time', durationUs: 2e6 };
    p.notes[s.note.id] = s.note;
    p.paths[s.path.id] = s.path;
    const take = new PlaybackTake(),
      run = new PlaySession(p, 0, (event) => take.accept(event), undefined, take.recordTrack),
      state = (time: number, preview = false) =>
        sliderAppearance(
          time,
          2e6,
          4e6,
          !preview,
          run.snapshot().results[s.note.id],
          null,
          null,
          take.tracks.get(s.note.id),
        );
    expect(sliderParticles(s.note.id, 10, state(2.2e6))).toEqual([]);
    run.input(2e6, { x: 100, y: 100 }, true, true);
    run.advance(2.3e6);
    const before = sliderParticles(s.note.id, 10, state(2.3e6));
    expect(before.length).toBeGreaterThan(0);
    expect(before.length).toBeLessThanOrEqual(9);
    expect(sliderParticles(s.note.id, 10, state(2.3e6))).toEqual(before);
    run.input(2.3e6, { x: 130, y: 100 }, false);
    run.advance(2.3e6 + SLIDER_SPARK_US + 1);
    expect(sliderParticles(s.note.id, 10, state(run.timeUs))).toEqual([]);
    run.input(2.7e6, { x: 170, y: 100 }, true);
    run.advance(2.8e6);
    expect(sliderParticles(s.note.id, 10, state(2.8e6)).some((p) => p.alpha > 0)).toBe(true);
    const arc = new ArcPath(s.path),
      visual = new LuminousNote(s.note, arc.at(0), arc);
    visual.slider(state(2.8e6), 1, 2);
    expect(visual.particleCount).toBe(2);
    visual.slider(state(2.8e6), 1, 0);
    expect(visual.particleCount).toBe(0);
    for (const time of [1e6, 2.1e6, 3.999e6, 4.3e6, 60e6])
      expect(sliderParticles(s.note.id, 10, state(time, true)).length).toBeLessThanOrEqual(9);
    expect(sliderParticles(s.note.id, 10, state(4.3e6, true))).toEqual([]);
    take.seek(2e6);
    const rewound = sliderAppearance(
      2.8e6,
      2e6,
      4e6,
      true,
      undefined,
      null,
      null,
      take.tracks.get(s.note.id),
    );
    visual.slider(rewound, 1, 10);
    expect(visual.particleCount).toBe(0);
    visual.dispose();
  });
  it('grows one ring to its target without changing the actual click area', () => {
    const { note, session } = play();
    const early = circleAppearance(1e6, 2e6, null, 2.1e6, windows),
      late = circleAppearance(1.95e6, 2e6, null, 2.1e6, windows);
    expect(early.scale).toBeLessThan(late.scale);
    expect(late.scale).toBeLessThan(1);
    expect(circleAppearance(2e6, 2e6, null, 2.1e6, windows).scale).toBe(1);
    session.input(1.92e6, { x: 123.9, y: 100 }, true, true);
    expect(session.snapshot().results[note.id].status).toBe('good');
    expect(note.radius).toBe(24);
  });
  it('starts the collapse at the real early/late hit, keeps its particles after the ring disappears, and misses never burst', () => {
    const { note, take, session } = play();
    session.input(2.04e6, note.position, true, true);
    const hit = take.eventTime(note.id, 'circle-hit');
    expect(hit).toBe(2.04e6);
    expect(circleAppearance(2.02e6, 2e6, hit, 2.1e6, windows).phase).toBe('ready');
    expect(circleAppearance(2.12e6, 2e6, hit, 2.1e6, windows).scale).toBeLessThan(0.5);
    const tail = circleAppearance(2.27e6, 2e6, hit, 2.1e6, windows);
    expect(tail.scale).toBe(0);
    expect(hitParticles(note.id, note.radius, tail.particleAgeUs!).some((p) => p.alpha > 0)).toBe(
      true,
    );
    expect(circleAppearance(2.04e6 + HIT_PARTICLE_US, 2e6, hit, 2.1e6, windows).phase).toBe(
      'hidden',
    );
    expect(circleAppearance(2.15e6, 2e6, null, 2.1e6, windows)).toMatchObject({
      phase: 'miss',
      particleAgeUs: null,
    });
  });
  it('reconstructs the same burst on a seek, removes future hits on rewind, and rejects another run', () => {
    const { note, take, session } = play();
    session.input(2e6, note.position, true, true);
    const particles = hitParticles(note.id, note.radius, 120000);
    take.accept({ kind: 'session-reset', reason: 'seek', runId: 'seek-a', timeUs: 2.12e6 });
    expect(take.eventTime(note.id, 'circle-hit')).toBe(2e6);
    expect(hitParticles(note.id, note.radius, 120000)).toEqual(particles);
    take.accept({ kind: 'circle-hit', runId: session.runId, noteId: note.id, timeUs: 2.3e6 });
    expect(take.events).toHaveLength(1);
    take.accept({ kind: 'session-reset', reason: 'seek', runId: 'seek-b', timeUs: 1.5e6 });
    expect(take.eventTime(note.id, 'circle-hit')).toBeNull();
    take.accept({ kind: 'session-reset', reason: 'restart', runId: 'restart', timeUs: 0 });
    expect(take.events).toHaveLength(0);
    expect(take.tracks.size).toBe(0);
  });
  it('dims interrupted Slider tracking while its time and path remain unchanged', () => {
    const p = createProject(),
      s = createSlider({ x: 100, y: 100 }, { x: 400, y: 100 }, { basis: 'time', timeUs: 2e6 });
    s.note.duration = { basis: 'time', durationUs: 2e6 };
    p.notes[s.note.id] = s.note;
    p.paths[s.path.id] = s.path;
    const session = new PlaySession(p);
    session.input(2e6, { x: 100, y: 100 }, true, true);
    session.advance(2.1e6);
    const result = session.snapshot().results[s.note.id];
    const tracked = sliderAppearance(2.1e6, 2e6, 4e6, true, result, null, null);
    session.input(2.1e6, { x: 100, y: 100 }, false);
    session.advance(2.2e6);
    const released = sliderAppearance(2.2e6, 2e6, 4e6, true, result, null, null);
    expect(tracked.tracking).toBe(true);
    expect(released.tracking).toBe(false);
    expect(released.dotAlpha).toBeLessThan(tracked.dotAlpha);
    expect(released.progress).toBeCloseTo(0.1);
    const geometry = new ArcPath(s.path, s.note.path.transform);
    expect(geometry.at(released.progress)).toEqual({ x: 130, y: 100 });
  });
  it('bounds simultaneous particles and releases every owned glow geometry without touching shared textures', () => {
    const { note } = play();
    const visual = new LuminousNote(note, note.position);
    const state = circleAppearance(2.08e6, 2e6, 2e6, 2.1e6, windows);
    visual.circle(state, 1, 5);
    expect(visual.particleCount).toBe(5);
    visual.circle(state, 1, 0);
    expect(visual.particleCount).toBe(0);
    const contexts = visual.root.children.map((child) => (child as Graphics).context);
    visual.dispose();
    expect(contexts.every((context) => context.destroyed)).toBe(true);
    expect(Texture.WHITE.destroyed).toBe(false);
  });
});
