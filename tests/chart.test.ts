import { describe, expect, it } from 'vitest';
import { ArcPath, changeNode, createNode, cubic, distance, insertNode } from '../src/core/path';
import {
  chartMapping,
  copyNotes,
  createSlider,
  endUs,
  snappedMoment,
  spanUs,
} from '../src/core/chart';
import {
  PlaySession,
  circleGrade,
  lineFollowInterval,
  type GameplayEvent,
} from '../src/core/judgement';
import { createProject, type BezierPath, type Note, type Project } from '../src/shared/models';
import { TempoMap } from '../src/core/timing';
import { identityTransform } from '../src/core/layers';
import { EditHistory } from '../src/application/history';
import { serializeProject, validateProject } from '../src/shared/schema';

function curve(): BezierPath {
  const a = createNode({ x: 0, y: 0 }),
    b = createNode({ x: 100, y: 0 });
  a.handleOut = { x: 0, y: 100 };
  b.handleIn = { x: 0, y: 100 };
  return { id: crypto.randomUUID(), name: '曲线', closed: false, defaultWidth: 48, nodes: [a, b] };
}
function circle(at = 1_000_000): Extract<Note, { kind: 'circle' }> {
  return {
    id: crypto.randomUUID(),
    kind: 'circle',
    at: { basis: 'time', timeUs: at },
    position: { x: 80, y: 100 },
    radius: 24,
  };
}
function sliderProject() {
  const project = createProject();
  const { note, path } = createSlider(
    { x: 0, y: 0 },
    { x: 100, y: 0 },
    { basis: 'time', timeUs: 0 },
  );
  note.duration = { basis: 'time', durationUs: 1_000_000 };
  note.followRadius = 10;
  project.notes[note.id] = note;
  project.paths[path.id] = path;
  return { project, note, path };
}
describe('reusable path geometry and arc length', () => {
  it('evaluates a cubic and integrates a known 200-unit curve within a bounded tolerance', () => {
    const path = curve(),
      arc = new ArcPath(path);
    expect(
      cubic({ x: 0, y: 0 }, { x: 0, y: 100 }, { x: 100, y: 100 }, { x: 100, y: 0 }, 0.5),
    ).toEqual({ x: 50, y: 75 });
    expect(arc.length).toBeCloseTo(200, 1);
    expect(arc.at(0.5).x).toBeCloseTo(50, 3);
    expect(arc.at(0.5).y).toBeCloseTo(75, 3);
    expect(arc.at(-1)).toEqual({ x: 0, y: 0 });
    expect(arc.at(2)).toEqual({ x: 100, y: 0 });
  });
  it('travels unequal polyline segments at uniform speed and reverses without altering path data', () => {
    const path = curve();
    path.interpolation = 'polyline';
    path.nodes = [
      createNode({ x: 0, y: 0 }),
      createNode({ x: 90, y: 0 }),
      createNode({ x: 90, y: 10 }),
    ];
    const arc = new ArcPath(path);
    expect(arc.length).toBe(100);
    expect(arc.at(0.5)).toEqual({ x: 50, y: 0 });
    expect(arc.at(0.95)).toEqual({ x: 90, y: 5 });
    expect(arc.at(0.25, true)).toEqual({ x: 75, y: 0 });
  });
  it('does not mistake cubic parameter increments for constant-speed motion', () => {
    const path = curve();
    path.nodes[0].handleOut = { x: 0, y: 0 };
    path.nodes[1].handleIn = { x: -95, y: 100 };
    const arc = new ArcPath(path);
    const a = arc.at(0.2),
      b = arc.at(0.3),
      c = arc.at(0.4);
    expect(Math.abs(distance(a, b) - distance(b, c))).toBeLessThan(0.25);
    const parameter = cubic(
      path.nodes[0].point,
      path.nodes[0].point,
      { x: 5, y: 100 },
      path.nodes[1].point,
      0.3,
    );
    expect(distance(parameter, b)).toBeGreaterThan(8);
  });
  it('measures in transformed coordinates, including nonuniform scale, and handles zero-length curves', () => {
    const path = curve(),
      transform = identityTransform();
    transform.scale = { x: 2, y: 2 };
    transform.position = { x: 11, y: 20 };
    const arc = new ArcPath(path, transform);
    expect(arc.length).toBeCloseTo(400, 1);
    expect(arc.at(0.5).y).toBeCloseTo(170, 2);
    const poly = {
      ...path,
      interpolation: 'polyline' as const,
      nodes: [
        createNode({ x: 0, y: 0 }),
        createNode({ x: 100, y: 0 }),
        createNode({ x: 100, y: 10 }),
      ],
    };
    transform.scale = { x: 2, y: 3 };
    expect(new ArcPath(poly, transform).length).toBe(230);
    path.nodes[1] = createNode({ x: 0, y: 0 });
    path.nodes[0].handleOut = { x: 0, y: 0 };
    expect(new ArcPath(path).at(0.8)).toEqual({ x: 0, y: 0 });
  });
  it('inserts an anchor with De Casteljau without changing the original curve', () => {
    const path = curve(),
      before = new ArcPath(path),
      inserted = insertNode(path, 0, 0.37),
      after = new ArcPath(inserted);
    expect(path.nodes.length).toBe(2);
    expect(inserted.nodes.length).toBe(3);
    expect(after.length).toBeCloseTo(before.length, 1);
    for (let t = 0; t <= 1; t += 0.025)
      expect(distance(before.at(t), after.at(t))).toBeLessThan(0.05);
    const close = before.closest({ x: 50, y: 80 });
    expect(close.segment).toBe(0);
    expect(close.t).toBeCloseTo(0.5, 1);
  });
  it('keeps aligned and mirrored handles consistent and moves anchors without moving relative handles', () => {
    const path = curve();
    path.nodes[0].mode = 'mirrored';
    const changed = changeNode(path, path.nodes[0].id, 'handleOut', { x: 20, y: 30 });
    expect(changed.nodes[0].handleIn).toEqual({ x: -20, y: -30 });
    const moved = changeNode(changed, path.nodes[0].id, 'point', { x: 50, y: 60 });
    expect(moved.nodes[0].handleOut).toEqual({ x: 20, y: 30 });
    changed.nodes[0].mode = 'aligned';
    const aligned = changeNode(changed, path.nodes[0].id, 'handleOut', { x: 80, y: 0 });
    expect(aligned.nodes[0].handleIn.x).toBeCloseTo(-Math.hypot(20, 30), 8);
    expect(aligned.nodes[0].handleIn.y).toBeCloseTo(0, 10);
  });
});
describe('chart commands, timing, and coordinate isolation', () => {
  it('keeps beat-based durations correct across BPM changes and supports sixteenth snapping', () => {
    const p = createProject();
    p.timing.points.push({ id: crypto.randomUUID(), tick: 960, bpm: 60, meter: [4, 4] });
    const tempo = new TempoMap(p.timing);
    expect(spanUs({ basis: 'beat', ticks: 1920 }, { basis: 'beat', tick: 0 }, tempo)).toBe(
      1_500_000,
    );
    expect(snappedMoment(123000, tempo, 16, true)).toEqual({ basis: 'beat', tick: 240 });
    expect(snappedMoment(123000, tempo, 16, false)).toEqual({ basis: 'time', timeUs: 123000 });
  });
  it('uniformly maps chart coordinates independently of source art, output size, and screen zoom', () => {
    const p = createProject();
    p.stage.artworkSize = { width: 640, height: 480 };
    expect(chartMapping(p)).toEqual({ scale: 1.25, x: 0, y: 0 });
    p.output.size = { width: 4000, height: 2000 };
    expect(chartMapping(p).scale).toBe(1.25);
  });
  it('saves/reopens independently editable cloned paths, batch movement/deletion, and undo', () => {
    const p = createProject(),
      c = circle(),
      s = createSlider({ x: 10, y: 50 }, { x: 400, y: 200 }, { basis: 'beat', tick: 1920 }),
      h = new EditHistory(p);
    h.execute({ type: 'add-notes', notes: [c, s.note], paths: [s.path] });
    const copied = copyNotes(h.current, [c.id, s.note.id]);
    h.execute({ type: 'add-notes', ...copied });
    expect(copied.paths[0].id).not.toBe(s.path.id);
    expect(copied.paths[0].nodes[0].id).not.toBe(s.path.nodes[0].id);
    h.execute({ type: 'move-notes', ids: [c.id, s.note.id], delta: { x: 12, y: -2 } });
    const reopened = validateProject(JSON.parse(serializeProject(h.current)));
    expect(reopened.notes[c.id]).toMatchObject({ position: { x: 92, y: 98 } });
    expect(reopened.paths).toEqual(h.current.paths);
    h.execute({ type: 'delete-notes', ids: [c.id, s.note.id] });
    expect(Object.keys(h.current.notes)).toHaveLength(2);
    h.undo();
    expect(Object.keys(h.current.notes)).toHaveLength(4);
    expect(endUs(s.note, new TempoMap(p.timing))).toBe(2_000_000);
  });
});
describe('timestamp-driven Circle judgement and stable events', () => {
  it('uses inclusive Perfect/Good boundaries, rejects wrong positions, and consumes each note once', () => {
    const p = createProject(),
      n = circle(),
      events: GameplayEvent[] = [];
    p.notes[n.id] = n;
    expect(circleGrade(50000, p.rules.hitWindowsUs)).toBe('perfect');
    expect(circleGrade(-100000, p.rules.hitWindowsUs)).toBe('good');
    expect(circleGrade(100001, p.rules.hitWindowsUs)).toBeNull();
    const run = new PlaySession(p, 0, (e) => events.push(e));
    expect(run.input(950000, { x: 400, y: 300 }, true, true)).toBeNull();
    expect(run.input(950000, n.position, true, true)).toBe(n.id);
    expect(run.input(950000, n.position, true, true)).toBeNull();
    expect(run.snapshot().results[n.id].status).toBe('perfect');
    expect(events.filter((e) => e.kind === 'circle-hit')).toHaveLength(1);
    expect(events.at(-1)).toMatchObject({ noteId: n.id, runId: run.runId, errorUs: -50000 });
  });
  it('emits a miss automatically and resets seek/replay state without changing project data', () => {
    const p = createProject(),
      n = circle(),
      events: GameplayEvent[] = [];
    p.notes[n.id] = n;
    const saved = serializeProject(p),
      run = new PlaySession(p, 0, (e) => events.push(e));
    run.advance(1_100_001);
    expect(run.snapshot().counts.miss).toBe(1);
    expect(events.at(-1)).toMatchObject({ kind: 'circle-miss', noteId: n.id, timeUs: 1100000 });
    expect(new PlaySession(p, 2_000_000).snapshot().results[n.id].status).toBe('skipped');
    expect(new PlaySession(p).snapshot().results[n.id].status).toBe('pending');
    expect(() => run.advance(0)).toThrow('跳转');
    expect(serializeProject(p)).toBe(saved);
  });
});
describe('Slider tracking over elapsed music time', () => {
  it('marks a missed very short Slider at its end instead of waiting beyond its duration', () => {
    const { project, note } = sliderProject(),
      events: GameplayEvent[] = [];
    note.duration = { basis: 'time', durationUs: 10000 };
    const run = new PlaySession(project, 0, (event) => events.push(event));
    run.advance(10001);
    expect(run.snapshot().results[note.id].status).toBe('failed');
    expect(events.at(-1)).toMatchObject({
      kind: 'slider-fail',
      timeUs: 10000,
      reason: 'head-miss',
    });
  });
  it('solves continuous follow intervals analytically', () => {
    expect(
      lineFollowInterval({ x: 0, y: 0 }, { x: 100, y: 0 }, 0, 1000000, { x: 50, y: 0 }, 10),
    ).toEqual([400000, 600000]);
    expect(
      lineFollowInterval({ x: 0, y: 0 }, { x: 100, y: 0 }, 0, 1000000, { x: 50, y: 30 }, 10),
    ).toBeNull();
  });
  it('requires a head hit even if input is held along the entire body', () => {
    const { project, note } = sliderProject(),
      events: GameplayEvent[] = [],
      run = new PlaySession(project, 0, (e) => events.push(e));
    run.input(0, { x: 0, y: 0 }, true);
    run.advance(1_000_000);
    expect(run.snapshot().results[note.id].status).toBe('failed');
    expect(events.at(-1)).toMatchObject({ kind: 'slider-fail', reason: 'head-miss' });
  });
  it('passes a real moving pointer, records release and off-path intervals, and reports effective progress', () => {
    const { project, note } = sliderProject(),
      events: GameplayEvent[] = [],
      run = new PlaySession(project, 0, (e) => events.push(e));
    run.input(0, { x: 0, y: 0 }, true, true);
    for (let t = 10000; t <= 1_000_000; t += 10000) run.input(t, { x: t / 10000, y: 0 }, true);
    const result = run.snapshot().results[note.id];
    expect(result.status).toBe('complete');
    expect(result.progress).toBeCloseTo(1);
    expect(
      events.some((e) => e.kind === 'slider-progress' && 'noteId' in e && e.noteId === note.id),
    ).toBe(true);
    const failed = new PlaySession(project);
    failed.input(0, { x: 0, y: 0 }, true, true);
    failed.input(200000, { x: 20, y: 0 }, false);
    failed.input(500000, { x: 50, y: 100 }, true);
    failed.advance(1_000_000);
    expect(failed.snapshot().results[note.id].status).toBe('failed');
    expect(
      failed
        .snapshot()
        .results[note.id].intervals.some(
          (i) => i.reason === 'released' && i.startUs === 200000 && i.endUs === 500000,
        ),
    ).toBe(true);
    expect(failed.snapshot().results[note.id].intervals.some((i) => i.reason === 'outside')).toBe(
      true,
    );
  });
  it('produces the same tracking time at sparse and dense render update rates', () => {
    const { project, note } = sliderProject();
    note.followRadius = 50;
    const simulate = (step: number) => {
      const run = new PlaySession(project);
      run.input(0, { x: 0, y: 0 }, true, true);
      for (let t = step; t < 1000000; t += step) run.advance(t);
      run.advance(1000000);
      return run.snapshot().results[note.id];
    };
    for (const step of [1000000, 50000, 16667, 2500]) {
      const r = simulate(step);
      expect(r.trackedUs).toBeCloseTo(500000, 4);
      expect(r.progress).toBeCloseTo(0.5, 8);
    }
  });
  it('follows a reversed curve and freezes judgement when music time does not advance', () => {
    const { project, note, path } = sliderProject();
    note.path.reversed = true;
    path.nodes[0].handleOut = { x: 0, y: 100 };
    path.nodes[1].handleIn = { x: 0, y: 100 };
    const arc = new ArcPath(path),
      run = new PlaySession(project);
    run.input(0, arc.at(0, true), true, true);
    for (let t = 5000; t <= 500000; t += 5000) run.input(t, arc.at(t / 1000000, true), true);
    const tracked = run.snapshot().results[note.id].trackedUs;
    run.input(500000, null, false);
    for (let i = 0; i < 20; i++) run.advance(500000);
    expect(run.snapshot().results[note.id].trackedUs).toBe(tracked);
    for (let t = 505000; t <= 1000000; t += 5000) run.input(t, arc.at(t / 1000000, true), true);
    expect(run.snapshot().results[note.id].status).toBe('complete');
  });
});
