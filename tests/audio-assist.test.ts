import { describe, expect, it, vi } from 'vitest';
import { nextTick, ref, shallowRef } from 'vue';
import {
  alignmentPlan,
  musicAnalysis,
  nearestOnset,
  noteMoment,
  shiftedNotes,
} from '../src/core/note-alignment';
import { analyzeAudio } from '../src/core/audio-analysis';
import { TempoMap } from '../src/core/timing';
import { endUs } from '../src/core/chart';
import { EditHistory } from '../src/application/history';
import { createAudioAnalysis } from '../src/renderer/audio/analysis-controller';
import { createChart } from '../src/renderer/chart/controller';
import type { AnalysisResult } from '../src/renderer/audio/audio-analysis-task';
import { createProject, type Note } from '../src/shared/models';
import { serializeProject, validateProject } from '../src/shared/schema';

function setup(
  times = [137_321, 637_321, 1_137_321, 1_637_321, 2_137_321, 2_637_321, 3_137_321, 3_637_321],
) {
  const p = createProject(),
    id = crypto.randomUUID();
  p.assets[id] = {
    id,
    kind: 'audio',
    sha256: 'a'.repeat(64),
    byteLength: 100,
    originalName: 'known.wav',
    relativePath: 'assets/known.wav',
    audioRole: 'music',
  };
  const result = analyzeAudio({ sampleRate: 48000, channels: [new Float32Array(48000 * 4)] });
  result.onsets = times.map((timeUs) => ({ timeUs, strength: 0.7 }));
  p.music = { assetId: id, gain: 0.8, analysis: { sourceSha256: p.assets[id].sha256, result } };
  return p;
}
function circle(timeUs: number): Extract<Note, { kind: 'circle' }> {
  return {
    id: crypto.randomUUID(),
    kind: 'circle',
    at: { basis: 'time', timeUs },
    position: { x: 100, y: 100 },
    radius: 24,
  };
}
describe('analysis suggestions and explicit note edits', () => {
  it('queries nearest candidates within an inclusive threshold, with strength then earlier-time ties', () => {
    const onsets = [
      { timeUs: 100_000, strength: 0.2 },
      { timeUs: 200_000, strength: 0.8 },
    ];
    expect(nearestOnset(onsets, 150_000, 50_000)).toBe(onsets[1]);
    expect(nearestOnset(onsets, 150_000, 49_999)).toBeUndefined();
    expect(
      nearestOnset(
        onsets.map((o) => ({ ...o, strength: 0.8 })),
        150_000,
        50_000,
      )?.timeUs,
    ).toBe(100_000);
    expect(nearestOnset([], 123, 40_000)).toBeUndefined();
    expect(nearestOnset(onsets, 101_000, 100_000, 100_001)).toBe(onsets[1]);
  });
  it('keeps exact onset microseconds, falls back to raw time, and labels musical divisions correctly', () => {
    const p = setup(),
      tempo = new TempoMap(p.timing),
      onsets = musicAnalysis(p)!.onsets;
    expect(noteMoment(130_000, tempo, 'onset', 4, onsets, 40_000)).toEqual({
      basis: 'time',
      timeUs: 137_321,
    });
    expect(noteMoment(300_123, tempo, 'onset', 4, onsets, 40_000)).toEqual({
      basis: 'time',
      timeUs: 300_123,
    });
    expect(noteMoment(130_000, tempo, 'off', 4, onsets, 40_000)).toEqual({
      basis: 'time',
      timeUs: 130_000,
    });
    expect([1, 2, 4, 8].map((d) => tempo.snap(300_000, d))).toEqual([
      500_000, 250_000, 250_000, 312_500,
    ]);
    expect(noteMoment(312_500, tempo, 'grid', 8, onsets, 40_000)).toEqual({
      basis: 'beat',
      tick: 600,
    });
  });
  it('snaps just the grabbed group head, preserving other microsecond gaps and all durations', () => {
    const p = setup(),
      a = circle(1_137_321),
      b = circle(1_400_123);
    p.notes = { [a.id]: a, [b.id]: b };
    const updates = shiftedNotes(p, [a.id, b.id], 510_000, a.id, 'onset', 8, 40_000);
    expect(updates).toEqual([
      { id: a.id, at: { basis: 'time', timeUs: 1_637_321 } },
      { id: b.id, at: { basis: 'time', timeUs: 1_900_123 } },
    ]);
    const clamped = shiftedNotes(p, [a.id, b.id], -2e6, b.id, 'off', 8, 40_000);
    expect(clamped[0].at).toEqual({ basis: 'time', timeUs: 0 });
    expect(clamped[1].at).toEqual({ basis: 'time', timeUs: 262_802 });
  });
  it('previews head and tail changes across a tempo boundary and commits the whole batch once', () => {
    const exact = setup([137_321, 637_321]);
    exact.timing.beatZeroUs = 137_321;
    const already: Note = {
      ...circle(0),
      kind: 'hold',
      at: { basis: 'beat', tick: 0 },
      duration: { basis: 'beat', ticks: 960 },
    };
    exact.notes[already.id] = already;
    expect(alignmentPlan(exact, [already.id], 40_000, 'head')[0].edit?.at).toEqual({
      basis: 'time',
      timeUs: 137_321,
    });
    expect(alignmentPlan(exact, [already.id], 40_000, 'tail')[0].edit?.duration).toEqual({
      basis: 'time',
      durationUs: 500_000,
    });
    const p = setup([1_625_000, 2_400_000]);
    p.timing.points.push({ id: crypto.randomUUID(), tick: 3840, bpm: 240, meter: [4, 4] });
    const hold: Note = {
      ...circle(1_600_000),
      kind: 'hold',
      duration: { basis: 'beat', ticks: 1920 },
    };
    const missed = circle(1_800_000);
    p.notes = { [hold.id]: hold, [missed.id]: missed };
    const h = new EditHistory(p),
      ids = [hold.id, missed.id];
    const plan = alignmentPlan(p, ids, 40_000, 'head');
    expect(plan[0]).toMatchObject({
      fromUs: 1_600_000,
      toUs: 1_625_000,
      endBeforeUs: 2_300_000,
      endAfterUs: 2_312_500,
    });
    expect(plan[1].toUs).toBeNull();
    h.execute({ type: 'set-note-times', updates: plan.flatMap((e) => (e.edit ? [e.edit] : [])) });
    expect(h.current.notes[hold.id]).toMatchObject({
      at: { basis: 'time', timeUs: 1_625_000 },
      duration: { basis: 'beat', ticks: 1920 },
    });
    expect(h.current.notes[missed.id]).toBe(missed);
    h.undo();
    expect(h.current).toBe(p);
    expect(h.canUndo).toBe(false);
    h.redo();
    expect(endUs(h.current.notes[hold.id], new TempoMap(p.timing))).toBe(2_312_500);
    const tails = alignmentPlan(h.current, ids, 100_000, 'tail');
    expect(tails).toHaveLength(1);
    h.execute({ type: 'set-note-times', updates: tails.flatMap((e) => (e.edit ? [e.edit] : [])) });
    expect(h.current.notes[hold.id]).toMatchObject({
      at: { basis: 'time', timeUs: 1_625_000 },
      duration: { basis: 'time', durationUs: 775_000 },
    });
  });
  it('adopts timing in one undo step and keeps stored notes, duration bases, and later BPM points', () => {
    const p = setup(),
      beat: Note = { ...circle(0), at: { basis: 'beat', tick: 3840 } },
      fixed = circle(1_234_567);
    p.notes = { [beat.id]: beat, [fixed.id]: fixed };
    p.timing.points.push({ id: crypto.randomUUID(), tick: 7680, bpm: 150, meter: [4, 4] });
    const h = new EditHistory(p);
    h.execute({
      type: 'set-timing',
      timing: {
        ...p.timing,
        beatZeroUs: 137_321,
        points: p.timing.points.map((t, i) => (i ? t : { ...t, bpm: 60 })),
      },
    });
    expect(h.current.notes).toBe(p.notes);
    expect(new TempoMap(h.current.timing).resolve(beat.at)).toBe(4_137_321);
    expect(new TempoMap(h.current.timing).resolve(fixed.at)).toBe(1_234_567);
    expect(h.current.timing.points[1]).toEqual(p.timing.points[1]);
    h.undo();
    expect(h.current).toBe(p);
    expect(h.canUndo).toBe(false);
  });
  it('persists only suggestions, validates sorted times, ignores stale hashes, and keeps old files readable', () => {
    const p = setup(),
      h = new EditHistory(p),
      note = circle(1_234_567);
    h.execute({ type: 'add-notes', notes: [note] });
    h.execute({
      type: 'set-audio-analysis',
      assetId: p.music!.assetId,
      sha256: 'a'.repeat(64),
      analysis: musicAnalysis(p)!,
    });
    const reopened = validateProject(JSON.parse(serializeProject(h.current)));
    expect(reopened.music).toEqual(h.current.music);
    expect(reopened.notes[note.id]).toEqual(note);
    expect(() =>
      h.execute({
        type: 'set-audio-analysis',
        assetId: p.music!.assetId,
        sha256: 'b'.repeat(64),
        analysis: musicAnalysis(p)!,
      }),
    ).toThrow(/当前音乐/);
    reopened.music!.analysis!.sourceSha256 = 'b'.repeat(64);
    expect(musicAnalysis(reopened)).toBeUndefined();
    const bad = structuredClone(p);
    bad.music!.analysis!.result.onsets.reverse();
    expect(() => validateProject(bad)).toThrow(/递增/);
    expect(validateProject(createProject()).music).toBeUndefined();
  });
  it('limits visible grid generation at variable tempos without changing subdivision phase', () => {
    const p = setup();
    p.timing.beatZeroUs = 137_321;
    p.timing.points.push({ id: crypto.randomUUID(), tick: 3840, bpm: 240, meter: [4, 4] });
    const tempo = new TempoMap(p.timing),
      grid = tempo.grid(2e6, 3e6, 8, 20_000);
    expect(grid.some((l) => l.tick === 3840 && l.timeUs === 2_137_321)).toBe(true);
    expect(grid.every((l) => l.tick % 120 === 0 && l.timeUs >= 2e6 && l.timeUs <= 3e6)).toBe(true);
    expect(tempo.grid(0, 100e6, 8, 1e6).length).toBeLessThan(105);
  });
  it('shares the same snapping entry for creation, numeric correction and Alt bypass without moving on selection', () => {
    const h = new EditHistory(setup());
    let chart!: ReturnType<typeof createChart>;
    chart = createChart({
      project: () => h.current,
      time: () => 130_000,
      playing: () => false,
      commit: (command) => {
        h.execute(command);
        chart.setProject(h.current);
        return true;
      },
      pause() {},
      seek() {},
      async play() {},
      selectLayer() {},
      notify() {},
    });
    chart.snapMode.value = 'onset';
    chart.addCircle({ x: 50, y: 50 });
    const id = chart.selected.value[0];
    expect(h.current.notes[id].at).toEqual({ basis: 'time', timeUs: 137_321 });
    const before = h.current;
    chart.choose([]);
    chart.select(id);
    expect(h.current).toBe(before);
    chart.setNoteTime(id, 630_123);
    expect(h.current.notes[id].at).toEqual({ basis: 'time', timeUs: 637_321 });
    chart.setNoteTime(id, 630_123, true);
    expect(h.current.notes[id].at).toEqual({ basis: 'time', timeUs: 630_123 });
    chart.dispose();
  });
});
describe('editor analysis publication and source lifetime', () => {
  function controller() {
    const project = shallowRef(setup()),
      buffer = shallowRef({} as AudioBuffer),
      busy = ref(false);
    const jobs: {
      resolve: (value: AnalysisResult) => void;
      source: { assetId: string; sha256: string };
    }[] = [];
    const task = {
      cancel: vi.fn(),
      analyze: vi.fn(
        (_buffer, source) =>
          new Promise<AnalysisResult>((resolve) => jobs.push({ resolve, source })),
      ),
    };
    const commit = vi.fn((command: Parameters<EditHistory['execute']>[0]) => {
      const h = new EditHistory(project.value);
      h.execute(command);
      project.value = h.current;
      return true;
    });
    const a = createAudioAnalysis(
      { project, buffer, busy, commit, seek: vi.fn(), notify: vi.fn() },
      task,
    );
    return { a, project, busy, jobs, commit, task };
  }
  it('publishes suggestions after a concurrent save finishes, without changing notes or timing', async () => {
    const { a, project, busy, jobs, commit } = controller(),
      before = project.value;
    const pending = a.analyze();
    busy.value = true;
    const result = structuredClone(musicAnalysis(before)!);
    result.onsets.push({ timeUs: 3_900_000, strength: 0.3 });
    jobs[0].resolve({ source: jobs[0].source, analysis: result });
    await pending;
    await nextTick();
    expect(commit).not.toHaveBeenCalled();
    expect(a.running.value).toBe(true);
    busy.value = false;
    await nextTick();
    expect(commit).toHaveBeenCalledTimes(1);
    expect(project.value.notes).toBe(before.notes);
    expect(project.value.timing).toBe(before.timing);
    expect(a.running.value).toBe(false);
    a.dispose();
  });
  it('drops late output after music/project replacement, explicit cancel and disposal', async () => {
    for (const action of ['music', 'project', 'cancel', 'dispose'] as const) {
      const { a, project, jobs, commit } = controller(),
        pending = a.analyze();
      if (action === 'music') project.value = { ...project.value, music: undefined };
      else if (action === 'project') project.value = { ...project.value, id: crypto.randomUUID() };
      else a[action]();
      jobs[0].resolve({
        source: jobs[0].source,
        analysis: analyzeAudio({ sampleRate: 48000, channels: [new Float32Array(0)] }),
      });
      await pending;
      await nextTick();
      expect(commit).not.toHaveBeenCalled();
      expect(a.running.value).toBe(false);
      a.dispose();
    }
  });
  it('does not cancel for manual note edits or clear a replacement request with late output', async () => {
    const { a, project, jobs, commit } = controller(),
      first = a.analyze();
    project.value = { ...project.value, notes: {} };
    expect(a.running.value).toBe(true);
    const second = a.analyze();
    jobs[0].resolve({ source: jobs[0].source, analysis: musicAnalysis(project.value)! });
    await first;
    await nextTick();
    expect(commit).not.toHaveBeenCalled();
    expect(a.running.value).toBe(true);
    jobs[1].resolve({ source: jobs[1].source, analysis: musicAnalysis(project.value)! });
    await second;
    await nextTick();
    expect(commit).toHaveBeenCalledTimes(1);
    a.dispose();
  });
});
