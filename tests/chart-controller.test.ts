import { describe, expect, it } from 'vitest';
import { EditHistory } from '../src/application/history';
import { createChart } from '../src/renderer/chart/controller';
import { createProject, type Note } from '../src/shared/models';
import { chartMapping, createSlider } from '../src/core/chart';
import { ChartScene } from '../src/renderer/chart/scene';
import { serializeProject, validateProject } from '../src/shared/schema';

function setup() {
  const h = new EditHistory(createProject()),
    clock = { time: 0, playing: false };
  const chart = createChart({
    project: () => h.current,
    time: () => clock.time,
    playing: () => clock.playing,
    commit(command) {
      h.execute(command);
      chart.setProject(h.current);
      return true;
    },
    pause() {
      clock.playing = false;
    },
    seek(time) {
      clock.time = time;
    },
    async play() {
      clock.playing = true;
    },
    selectLayer() {},
    notify() {},
  });
  return { h, chart, clock };
}
describe('chart session lifecycle and editing boundaries', () => {
  it('uses pen drags as tangents, previews curves and commits the same anchors/handles once', () => {
    const { h, chart } = setup(),
      scene = new ChartScene(chart, () => 1),
      m = chartMapping(h.current),
      world = (x: number, y: number) => ({ x: m.x + x * m.scale, y: m.y + y * m.scale });
    chart.setTool('slider');
    scene.down(world(40, 50), false);
    scene.move(world(70, 20));
    scene.up(world(70, 20));
    scene.move(world(190, 80));
    expect(chart.sliderPreview.value!.nodes).toHaveLength(2);
    expect(chart.sliderDraft.value!.nodes).toHaveLength(1);
    for (const p of [
      [190, 80],
      [280, 240],
    ]) {
      scene.draw();
      scene.down(world(p[0], p[1]), false);
      scene.up(world(p[0], p[1]));
    }
    expect(h.canUndo).toBe(false);
    scene.draw();
    scene.down(world(280, 240), false);
    scene.up(world(280, 240));
    scene.doubleClick(world(280, 240));
    const path = chart.selectedPath.value!;
    expect(path.interpolation).toBe('bezier');
    expect(path.nodes).toHaveLength(3);
    expect(path.nodes[0].handleOut).toEqual({ x: 30, y: -30 });
    expect(path.nodes[0].handleIn).toEqual({ x: -30, y: 30 });
    expect(path.nodes[1].mode).toBe('mirrored');
    expect(path.nodes[1].handleOut.y).toBeGreaterThan(0);
    expect(validateProject(JSON.parse(serializeProject(h.current))).paths[path.id]).toEqual(path);
    h.undo();
    expect(h.current.paths).toEqual({});
    expect(h.current.notes).toEqual({});
    expect(h.canUndo).toBe(false);
    h.redo();
    expect(h.current.paths[path.id]).toEqual(path);
    scene.dispose();
    chart.dispose();
  });
  it('publishes free-Slider intervals at their source and retains the correct history across seeks', () => {
    const { h, chart, clock } = setup(),
      { note, path } = createSlider(
        { x: 80, y: 120 },
        { x: 80, y: 120 },
        { basis: 'time', timeUs: 1e6 },
      );
    note.duration = { basis: 'time', durationUs: 2e6 };
    h.execute({ type: 'add-notes', notes: [note], paths: [path] });
    chart.setProject(h.current);
    chart.setMode('playtest');
    clock.playing = true;
    chart.setPointer({ x: 80, y: 120 });
    clock.time = 1e6;
    chart.input('z', true);
    clock.time = 1.5e6;
    chart.release();
    expect(chart.take.tracks.get(note.id)).toBe(chart.runtime.value!.results[note.id].intervals);
    expect(chart.take.follow(note.id, 3e6, 1e6, 2e6)).toBe(0.25);
    chart.reset(1.2e6, 'seek');
    expect(chart.take.follow(note.id, 3e6, 1e6, 2e6)).toBe(0.1);
    chart.reset(0, 'restart');
    expect(chart.take.tracks.size).toBe(0);
    chart.dispose();
  });
  it('creates and edits a hold with duration, movement, duplication and undo', () => {
    const { h, chart } = setup();
    chart.setTool('hold');
    chart.addHold({ x: 80, y: 120 });
    const id = chart.selected.value[0];
    chart.setDuration(2.5);
    expect(chart.duration.value).toBe(2_500_000);
    chart.setDurationBeats(3);
    expect(chart.duration.value).toBe(1_500_000);
    chart.moveSelected({ x: 20, y: -30 }, true);
    expect(h.current.notes[id]).toMatchObject({ kind: 'hold', position: { x: 100, y: 90 } });
    chart.duplicate();
    expect(Object.keys(h.current.notes)).toHaveLength(2);
    expect(Object.values(h.current.paths)).toHaveLength(0);
    h.undo();
    chart.setProject(h.current);
    expect(Object.keys(h.current.notes)).toHaveLength(1);
    chart.dispose();
  });
  it('captures the first point time, stores multiple turns in one command and cancels drafts without undo entries', () => {
    const { h, chart, clock } = setup();
    chart.setTool('slider');
    clock.time = 1_000_000;
    chart.beginSlider();
    chart.addSliderPoint({ x: 30, y: 40 });
    clock.time = 2_500_000;
    chart.addSliderPoint({ x: 160, y: 40 });
    chart.addSliderPoint({ x: 160, y: 180 });
    chart.addSliderPoint({ x: 50, y: 180 });
    expect(h.current.notes).toEqual({});
    chart.finishSlider();
    const note = chart.selectedNote.value!;
    expect(note.at).toEqual({ basis: 'beat', tick: 1920 });
    expect(chart.selectedPath.value!.nodes).toHaveLength(4);
    expect(chart.sliderDraft.value).toBeNull();
    h.undo();
    chart.setProject(h.current);
    expect(h.current.notes).toEqual({});
    expect(h.current.paths).toEqual({});
    chart.setTool('slider');
    chart.addSliderPoint({ x: 20, y: 20 });
    chart.cancelGesture();
    chart.finishSlider();
    expect(h.current.notes).toEqual({});
    chart.dispose();
  });
  it('appends nodes in path-local coordinates, preserves existing bends and undoes each append', () => {
    const { h, chart } = setup();
    chart.addSliderPoint({ x: 40, y: 50 });
    chart.addSliderPoint({ x: 200, y: 50 });
    chart.addSliderPoint({ x: 200, y: 180 });
    chart.finishSlider();
    const original = structuredClone(chart.selectedPath.value!);
    chart.moveSelected({ x: 20, y: 10 }, true);
    chart.toggleAppend();
    expect(chart.appendMode.value).toBe(true);
    chart.appendNode({ x: 70, y: 190 });
    expect(chart.selectedPath.value!.nodes.slice(0, 3)).toEqual(original.nodes);
    expect(chart.selectedPath.value!.nodes[3].point).toEqual({ x: 50, y: 180 });
    chart.appendNode({ x: 70, y: 190 });
    expect(chart.selectedPath.value!.nodes).toHaveLength(4);
    h.undo();
    chart.setProject(h.current);
    expect(chart.selectedPath.value!.nodes).toHaveLength(3);
    chart.cancelGesture();
    expect(chart.appendMode.value).toBe(false);
    chart.dispose();
  });
  it('keeps judgement intact when audio gain or unrelated layer metadata changes', () => {
    const { h, chart, clock } = setup();
    const note: Note = {
      id: crypto.randomUUID(),
      at: { basis: 'time', timeUs: 1000000 },
      kind: 'circle',
      position: { x: 80, y: 100 },
      radius: 24,
    };
    h.execute({
      type: 'set-music',
      asset: {
        id: crypto.randomUUID(),
        kind: 'audio',
        relativePath: 'assets/music.wav',
        originalName: 'music.wav',
        sha256: '0'.repeat(64),
        byteLength: 44,
      },
    });
    h.execute({ type: 'add-notes', notes: [note] });
    chart.setProject(h.current);
    chart.setMode('playtest');
    clock.playing = true;
    clock.time = 1000000;
    chart.setPointer(note.position);
    chart.input('KeyZ', true);
    const runId = chart.runtime.value!.runId;
    expect(chart.runtime.value!.results[note.id].status).toBe('perfect');
    h.execute({ type: 'set-gain', gain: 0.35 });
    chart.setProject(h.current);
    expect(chart.runtime.value!.runId).toBe(runId);
    expect(h.current.music!.gain).toBe(0.35);
    h.execute({ type: 'rename', name: '不相关元数据' });
    chart.setProject(h.current);
    chart.update(1000000);
    expect(chart.runtime.value!.runId).toBe(runId);
    expect(chart.runtime.value!.counts.perfect).toBe(1);
    expect(chart.events.value.filter((e) => e.kind === 'circle-hit')).toHaveLength(1);
    chart.dispose();
  });
  it('cancels a live group movement without an undo entry and commits a finished movement once', () => {
    const { h, chart } = setup();
    chart.setTool('circle');
    chart.addCircle({ x: 100, y: 100 });
    const id = chart.selected.value[0];
    chart.moveSelected({ x: 30, y: 20 }, false);
    expect(chart.document.value.notes[id]).toMatchObject({ position: { x: 130, y: 120 } });
    expect(h.current.notes[id]).toMatchObject({ position: { x: 100, y: 100 } });
    chart.cancelGesture();
    expect(chart.document.value).toBe(h.current);
    chart.moveSelected({ x: 40, y: 25 }, false);
    chart.moveSelected({ x: 40, y: 25 }, true);
    expect(h.current.notes[id]).toMatchObject({ position: { x: 140, y: 125 } });
    h.undo();
    expect(h.current.notes[id]).toMatchObject({ position: { x: 100, y: 100 } });
    h.undo();
    expect(h.current.notes).toEqual({});
    chart.dispose();
  });
  it('resets an explicit seek and replay with fresh run IDs, while timestamp jitter preserves the run', async () => {
    const { chart, clock } = setup();
    chart.setTool('circle');
    chart.addCircle({ x: 100, y: 100 });
    chart.setMode('playtest');
    clock.playing = true;
    clock.time = 0;
    chart.setPointer({ x: 100, y: 100 });
    chart.input('mouse', true);
    chart.update(100);
    const first = chart.runtime.value!.runId;
    chart.update(99);
    expect(chart.runtime.value!.runId).toBe(first);
    chart.reset(0);
    expect(chart.runtime.value!.runId).not.toBe(first);
    expect(chart.runtime.value!.counts.perfect).toBe(0);
    const resetId = chart.runtime.value!.runId;
    await chart.replay();
    expect(chart.runtime.value!.runId).not.toBe(resetId);
    expect(clock.playing).toBe(true);
    expect(clock.time).toBe(0);
    chart.dispose();
  });
});
