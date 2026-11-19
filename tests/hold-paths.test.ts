import { describe, expect, it } from 'vitest';
import { EditHistory } from '../src/application/history';
import { copyNotes, createSliderFromPoints, endUs } from '../src/core/chart';
import { PlaySession, type GameplayEvent } from '../src/core/judgement';
import { ArcPath } from '../src/core/path';
import { TempoMap } from '../src/core/timing';
import { createProject, type Note } from '../src/shared/models';
import { serializeProject, validateProject } from '../src/shared/schema';

function holdProject() {
  const project = createProject();
  const note: Extract<Note, { kind: 'hold' }> = {
    id: crypto.randomUUID(),
    kind: 'hold',
    at: { basis: 'time', timeUs: 1_000_000 },
    position: { x: 100, y: 80 },
    radius: 24,
    duration: { basis: 'time', durationUs: 1_000_000 },
  };
  project.notes[note.id] = note;
  return { project, note };
}

describe('stationary long press with music timestamps', () => {
  it('requires the head click, then holds without requiring the pointer to remain at the head', () => {
    const { project, note } = holdProject(),
      events: GameplayEvent[] = [];
    const run = new PlaySession(project, 0, (e) => events.push(e));
    expect(run.input(1_000_000, { x: 300, y: 300 }, true, true)).toBeNull();
    expect(run.input(1_000_000, note.position, true, true)).toBe(note.id);
    run.input(1_250_000, { x: 500, y: 350 }, true);
    run.input(1_500_000, null, true);
    run.advance(2_000_000);
    expect(run.snapshot().results[note.id]).toMatchObject({
      status: 'complete',
      progress: 1,
      trackedUs: 1_000_000,
    });
    expect(run.snapshot().counts).toMatchObject({ holdComplete: 1, complete: 0, failed: 0 });
    expect(events.filter((e) => e.kind === 'hold-start')).toHaveLength(1);
    expect(events.filter((e) => e.kind === 'hold-complete')).toHaveLength(1);
    expect(events.filter((e) => e.kind.startsWith('slider-'))).toHaveLength(0);
    expect(events.at(-1)).toMatchObject({ noteId: note.id, runId: run.runId, timeUs: 2_000_000 });
  });
  it('fails an early release and records exact release intervals when re-held', () => {
    const { project, note } = holdProject(),
      events: GameplayEvent[] = [];
    const run = new PlaySession(project, 0, (e) => events.push(e));
    run.input(1_000_000, note.position, true, true);
    run.input(1_200_000, note.position, false);
    run.advance(1_500_000);
    run.input(1_700_000, null, true);
    run.advance(2_000_000);
    expect(run.snapshot().results[note.id]).toMatchObject({
      status: 'failed',
      progress: 0.5,
      trackedUs: 500_000,
    });
    expect(run.snapshot().results[note.id].intervals).toContainEqual({
      startUs: 1_200_000,
      endUs: 1_700_000,
      valid: false,
      reason: 'released',
    });
    expect(events.filter((e) => e.kind === 'hold-break')).toHaveLength(1);
    expect(events.at(-1)).toMatchObject({ kind: 'hold-fail', reason: 'insufficient-tracking' });
    expect(run.snapshot().counts).toMatchObject({ holdFailed: 1, failed: 0 });
  });
  it('does not count a tap or an already-held key as a successful head press', () => {
    const { project, note } = holdProject();
    const tap = new PlaySession(project);
    tap.input(1_000_000, note.position, true, true);
    tap.input(1_010_000, note.position, false);
    tap.advance(2_000_000);
    expect(tap.snapshot().results[note.id].status).toBe('failed');
    const held = new PlaySession(project);
    held.input(500_000, note.position, true, true);
    held.input(1_000_000, note.position, true);
    held.advance(2_000_000);
    expect(held.snapshot().results[note.id]).toMatchObject({ status: 'failed', trackedUs: 0 });
  });
  it('applies the configurable completion threshold, including old projects without the optional rule', () => {
    const { project, note } = holdProject();
    delete project.rules.holdCompleteRatio;
    const old = new PlaySession(project);
    old.input(1_000_000, note.position, true, true);
    old.input(1_950_000, note.position, false);
    old.advance(2_000_000);
    expect(old.snapshot().results[note.id].status).toBe('complete');
    project.rules.holdCompleteRatio = 0.96;
    const strict = new PlaySession(project);
    strict.input(1_000_000, note.position, true, true);
    strict.input(1_950_000, note.position, false);
    strict.advance(2_000_000);
    expect(strict.snapshot().results[note.id].status).toBe('failed');
  });
  it('rejects head timing outside the window and never counts unheld time before a late head', () => {
    const { project, note } = holdProject();
    const run = new PlaySession(project);
    expect(run.input(899_999, note.position, true, true)).toBeNull();
    expect(run.input(1_030_000, note.position, true, true)).toBe(note.id);
    run.advance(2_000_000);
    expect(run.snapshot().results[note.id]).toMatchObject({ status: 'complete', progress: 0.97 });
    expect(run.snapshot().results[note.id].intervals[0]).toEqual({
      startUs: 1_000_000,
      endUs: 1_030_000,
      valid: false,
      reason: 'late-head',
    });
    const missed = new PlaySession(project);
    expect(missed.input(1_100_001, note.position, true, true)).toBeNull();
    expect(missed.snapshot().results[note.id].status).toBe('failed');
  });
  it('does not depend on render rate, freezes on pause, and resets replay/seek independently', () => {
    const { project, note } = holdProject();
    for (const step of [1_000_000, 125_000, 16_667, 2_500]) {
      const run = new PlaySession(project);
      run.input(1_000_000, note.position, true, true);
      for (let t = 1_000_000 + step; t < 2_000_000; t += step) run.advance(t);
      run.advance(2_000_000);
      expect(run.snapshot().results[note.id].trackedUs).toBe(1_000_000);
    }
    const paused = new PlaySession(project);
    paused.input(1_000_000, note.position, true, true);
    paused.input(1_400_000, null, false);
    for (let i = 0; i < 60; i++) paused.advance(1_400_000);
    expect(paused.snapshot().results[note.id].trackedUs).toBe(400_000);
    paused.input(1_400_000, null, true);
    paused.advance(2_000_000);
    expect(paused.snapshot().results[note.id].status).toBe('complete');
    const replay = new PlaySession(project),
      seek = new PlaySession(project, 1_500_000);
    expect(replay.runId).not.toBe(paused.runId);
    expect(replay.snapshot().results[note.id].status).toBe('pending');
    expect(seek.snapshot().results[note.id].status).toBe('skipped');
  });
});

describe('hold editing and reusable paths with multiple turns', () => {
  it('converts hold beat duration across tempo changes and serializes without view objects', () => {
    const { project, note } = holdProject();
    note.at = { basis: 'beat', tick: 0 };
    note.duration = { basis: 'beat', ticks: 1920 };
    project.timing.points.push({ id: crypto.randomUUID(), tick: 960, bpm: 60, meter: [4, 4] });
    expect(endUs(note, new TempoMap(project.timing))).toBe(1_500_000);
    expect(validateProject(JSON.parse(serializeProject(project))).notes[note.id]).toEqual(note);
    note.duration = { basis: 'time', durationUs: 0 };
    expect(() => validateProject(project)).toThrow('持续时间必须大于零');
  });
  it('copies, moves, deletes and undoes holds using the existing command history', () => {
    const { project, note } = holdProject(),
      history = new EditHistory(project);
    const copied = copyNotes(project, [note.id]);
    expect(copied.paths).toHaveLength(0);
    expect(copied.notes[0]).toMatchObject({
      kind: 'hold',
      position: { x: 116, y: 96 },
      duration: note.duration,
    });
    history.execute({ type: 'add-notes', ...copied });
    history.execute({ type: 'move-notes', ids: [note.id], delta: { x: 20, y: -5 } });
    expect(history.current.notes[note.id]).toMatchObject({ position: { x: 120, y: 75 } });
    history.execute({ type: 'delete-notes', ids: [note.id] });
    expect(history.current.notes[note.id]).toBeUndefined();
    history.undo();
    history.undo();
    expect(history.current.notes[note.id]).toEqual(note);
    history.redo();
    expect(history.current.notes[note.id]).toMatchObject({ position: { x: 120, y: 75 } });
  });
  it('travels multiple turns and a U-turn by arc length instead of by segment index', () => {
    const points = [
      { x: 0, y: 0 },
      { x: 100, y: 0 },
      { x: 100, y: 50 },
      { x: 20, y: 50 },
      { x: 100, y: 50 },
    ];
    const { path } = createSliderFromPoints(points, { basis: 'beat', tick: 0 }, 'polyline');
    const arc = new ArcPath(path);
    expect(arc.length).toBe(310);
    for (const [progress, reversed, expected] of [
      [125 / 310, false, { x: 100, y: 25 }],
      [190 / 310, false, { x: 60, y: 50 }],
      [270 / 310, false, { x: 60, y: 50 }],
      [40 / 310, true, { x: 60, y: 50 }],
    ] as const) {
      expect(arc.at(progress, reversed).x).toBeCloseTo(expected.x, 8);
      expect(arc.at(progress, reversed).y).toBeCloseTo(expected.y, 8);
    }
    expect(path.nodes.map((n) => n.point)).toEqual(points);
    expect(new Set(path.nodes.map((n) => n.id)).size).toBe(points.length);
    expect(() => createSliderFromPoints([points[0]], { basis: 'time', timeUs: 0 })).toThrow();
  });
  it('tracks a multi-turn polyline and its reversed route successfully without touching source geometry', () => {
    const project = createProject();
    const { note, path } = createSliderFromPoints(
      [
        { x: 0, y: 0 },
        { x: 90, y: 0 },
        { x: 90, y: 70 },
        { x: 20, y: 70 },
        { x: 20, y: 10 },
      ],
      { basis: 'time', timeUs: 0 },
      'polyline',
    );
    note.duration = { basis: 'time', durationUs: 2_000_000 };
    note.followRadius = 12;
    project.notes[note.id] = note;
    project.paths[path.id] = path;
    const geometry = structuredClone(path),
      arc = new ArcPath(path);
    for (const reversed of [false, true]) {
      note.path.reversed = reversed;
      const run = new PlaySession(project);
      run.input(0, arc.at(0, reversed), true, true);
      for (let t = 5_000; t <= 2_000_000; t += 5_000)
        run.input(t, arc.at(t / 2_000_000, reversed), true);
      expect(run.snapshot().results[note.id]).toMatchObject({ status: 'complete', progress: 1 });
    }
    expect(project.paths[path.id]).toEqual(geometry);
    expect(validateProject(JSON.parse(serializeProject(project))).paths[path.id]).toEqual(geometry);
  });
});
