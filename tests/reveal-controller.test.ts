import { nextTick } from 'vue';
import { describe, expect, it } from 'vitest';
import {
  EditHistory,
  type ChartCommand,
  type EditCommand,
  type RevealCommand,
} from '../src/application/history';
import { identityTransform } from '../src/core/layers';
import { createSlider } from '../src/core/chart';
import { createProject, type Note, type Layer } from '../src/shared/models';
import { createChart } from '../src/renderer/chart/controller';
import { createReveals, type RevealController } from '../src/renderer/reveals/controller';

function setup() {
  const p = createProject(),
    layer: Layer = {
      id: crypto.randomUUID(),
      name: '演出分组',
      kind: 'group',
      childrenBottomToTop: [],
      isolation: 'isolated',
      transform: identityTransform(),
      opacity: 1,
      enabled: true,
      locked: false,
      initialReveal: 1,
      blendMode: 'normal',
    };
  const n: Note = {
    id: crypto.randomUUID(),
    kind: 'circle',
    position: { x: 50, y: 60 },
    radius: 24,
    at: { basis: 'time', timeUs: 1000000 },
  };
  p.layers[layer.id] = layer;
  p.rootLayersBottomToTop = [layer.id];
  p.notes[n.id] = n;
  const h = new EditHistory(p),
    clock = { time: 0, playing: false };
  let r: RevealController;
  const chart = createChart({
    project: () => h.current,
    time: () => clock.time,
    playing: () => clock.playing,
    commit,
    pause() {
      clock.playing = false;
    },
    seek(at) {
      clock.time = at;
    },
    async play() {
      clock.playing = true;
    },
    selectLayer() {},
    notify() {},
  });
  function publish() {
    chart.setProject(h.current);
    r?.setProject(h.current);
  }
  function commit(c: EditCommand | ChartCommand | RevealCommand) {
    h.execute(c);
    publish();
    return true;
  }
  r = createReveals({ project: () => h.current, chart, commit, notify() {} });
  publish();
  return {
    h,
    clock,
    chart,
    r,
    n,
    layer,
    publish,
    commit,
    dispose() {
      r.dispose();
      chart.dispose();
    },
  };
}
describe('reveal editing and recorded-playback lifecycle', () => {
  it('creates, edits and undoes fan masks without introducing paths or changing layer transforms', () => {
    const t = setup(),
      transform = structuredClone(t.layer.transform);
    t.r.add(t.n.id, t.layer.id, 'fan');
    const id = t.r.selectedId.value!;
    expect(t.h.current.layers[t.layer.id].initialReveal).toBe(0);
    expect(t.h.current.paths).toEqual({});
    t.r.patchEffect({ mode: 'close', center: { x: 0.3, y: 0.7 } });
    expect(t.h.current.reveals[id].effect).toMatchObject({
      kind: 'fan',
      mode: 'close',
      center: { x: 0.3, y: 0.7 },
    });
    t.r.update(1500000);
    expect(t.r.states.value[t.layer.id].alpha).toBe(0);
    t.h.undo();
    t.publish();
    expect(t.h.current.reveals[id].effect).toMatchObject({
      kind: 'fan',
      mode: 'open',
      center: { x: 0.5, y: 1 },
    });
    t.h.redo();
    t.publish();
    expect(t.h.current.reveals[id].effect).toMatchObject({ mode: 'close' });
    expect(t.h.current.layers[t.layer.id].transform).toEqual(transform);
    t.dispose();
  });
  it('reuses compiled path geometry for unrelated edits, but updates it for path edits and undo', () => {
    const t = setup();
    t.r.add(t.n.id, t.layer.id, 'path');
    t.r.update(1250000);
    const first = t.r.states.value[t.layer.id].mask;
    expect(first?.kind).toBe('path');
    t.commit({ type: 'rename', name: '只改名称' });
    t.r.update(1250000);
    const unchanged = t.r.states.value[t.layer.id].mask;
    if (first?.kind !== 'path' || unchanged?.kind !== 'path') throw new Error('missing mask');
    expect(unchanged.arc).toBe(first.arc);
    const path = structuredClone(t.r.path.value!);
    path.nodes[1].point.x += 200;
    t.r.setPath(path);
    t.r.update(1250000);
    const edited = t.r.states.value[t.layer.id].mask;
    if (edited?.kind !== 'path') throw new Error('missing mask');
    expect(edited.arc).not.toBe(first.arc);
    expect(edited.arc.length).not.toBe(first.arc.length);
    t.h.undo();
    t.publish();
    t.r.update(1250000);
    const restored = t.r.states.value[t.layer.id].mask;
    if (restored?.kind !== 'path') throw new Error('missing mask');
    expect(restored.arc.length).toBe(first.arc.length);
    t.dispose();
  });
  it('adds a binding and initial-hidden state in one undo step and preserves both when redone', () => {
    const t = setup();
    t.r.add(t.n.id, t.layer.id, 'path');
    const id = t.r.selectedId.value!;
    expect(Object.keys(t.h.current.paths)).toHaveLength(1);
    expect(t.h.current.layers[t.layer.id].initialReveal).toBe(0);
    t.h.undo();
    t.publish();
    expect(t.h.current.reveals).toEqual({});
    expect(t.h.current.paths).toEqual({});
    expect(t.h.current.layers[t.layer.id].initialReveal).toBe(1);
    t.h.redo();
    t.publish();
    expect(t.h.current.reveals[id].effect.kind).toBe('path');
    t.dispose();
  });
  it('supports one Circle controlling several layers without clearing previously added bindings', () => {
    const t = setup(),
      l = { ...structuredClone(t.layer), id: crypto.randomUUID() };
    t.h.current.layers[l.id] = l;
    t.h.current.rootLayersBottomToTop.push(l.id);
    t.publish();
    t.r.add(t.n.id, t.layer.id, 'instant');
    t.r.add(t.n.id, l.id, 'fade');
    expect(Object.values(t.h.current.reveals).map((c) => c.layerId)).toEqual([t.layer.id, l.id]);
    t.dispose();
  });
  it('uses an independent duration when switching a Slider binding to completion', () => {
    const t = setup();
    const built = createSlider({ x: 10, y: 20 }, { x: 300, y: 20 }, t.n.at);
    t.h.current.notes[t.n.id] = {
      ...built.note,
      id: t.n.id,
      duration: { basis: 'time', durationUs: 2000000 },
    };
    t.h.current.paths[built.path.id] = built.path;
    t.publish();
    t.r.add(t.n.id, t.layer.id, 'fade');
    expect(t.r.selected.value!.progress.kind).toBe('slider-timeline');
    t.r.patch({ trigger: { kind: 'note', noteId: t.n.id, event: 'slider-complete' } });
    expect(t.r.selected.value!.progress).toEqual({
      kind: 'elapsed',
      duration: { basis: 'time', durationUs: 500000 },
    });
    t.r.patch({ easing: 'linear' });
    t.r.update(3250000);
    expect(t.r.states.value[t.layer.id].alpha).toBeCloseTo(0.5);
    t.h.undo();
    t.h.undo();
    t.publish();
    expect(t.r.selected.value!.progress.kind).toBe('slider-timeline');
    t.dispose();
  });
  it('draws an independent reusable path in a single command and Escape drops only the unfinished draft', () => {
    const t = setup();
    t.r.add(t.n.id, t.layer.id, 'path');
    const original = t.r.path.value!;
    t.r.startDrawing();
    t.r.appendPoint({ x: 10, y: 20 });
    t.r.appendPoint({ x: 40, y: 60 });
    t.r.appendPoint({ x: 80, y: 90 });
    t.r.cancel();
    expect(t.r.path.value!.id).toBe(original.id);
    t.r.startDrawing();
    t.r.appendPoint({ x: 10, y: 20 });
    t.r.appendPoint({ x: 40, y: 60 });
    t.r.finishDrawing();
    expect(t.r.path.value!.nodes).toHaveLength(2);
    expect(t.r.path.value!.id).not.toBe(original.id);
    t.h.undo();
    t.publish();
    expect(t.r.path.value!.id).toBe(original.id);
    t.dispose();
  });
  it('keeps live node movement out of saved document state until pointer release', () => {
    const t = setup();
    t.r.add(t.n.id, t.layer.id, 'path');
    const path = t.r.path.value!,
      id = path.nodes[0].id,
      at = structuredClone(path.nodes[0].point);
    t.r.editPath();
    t.r.moveNode(id, 'point', { x: at.x + 30, y: at.y + 40 }, false);
    expect(t.h.current.paths[path.id].nodes[0].point).toEqual(at);
    expect(t.r.path.value!.nodes[0].point.x).toBe(at.x + 30);
    t.r.cancel();
    expect(t.r.path.value!.nodes[0].point).toEqual(at);
    t.r.editPath();
    t.r.moveNode(id, 'point', { x: at.x + 30, y: at.y + 40 }, true);
    expect(t.h.current.paths[path.id].nodes[0].point.x).toBe(at.x + 30);
    t.h.undo();
    t.publish();
    expect(t.r.path.value!.nodes[0].point).toEqual(at);
    t.dispose();
  });
  it('retains real hits on forward seek and unrelated edits, truncates them on backward seek and clears on replay', async () => {
    const t = setup();
    t.r.add(t.n.id, t.layer.id, 'instant');
    t.chart.setMode('playtest');
    await nextTick();
    t.clock.playing = true;
    t.chart.setPointer(t.n.position);
    t.clock.time = 1000000;
    t.chart.input('z', true);
    t.chart.update(1000000);
    t.r.update(1000000);
    expect(t.r.states.value[t.layer.id].alpha).toBe(1);
    t.clock.time = 2000000;
    t.chart.reset(2000000, 'seek');
    t.r.update(2000000);
    expect(t.r.states.value[t.layer.id].alpha).toBe(1);
    t.commit({ type: 'rename', name: '新名称' });
    t.r.update(2000000);
    expect(t.r.states.value[t.layer.id].alpha).toBe(1);
    t.clock.time = 500000;
    t.chart.reset(500000, 'seek');
    t.r.update(500000);
    expect(t.r.states.value[t.layer.id].alpha).toBe(0);
    t.chart.reset(0, 'restart');
    expect(t.r.take.events).toHaveLength(0);
    t.dispose();
  });
  it('previews Edit by default, permits a full-source alignment view and clears manual audition on mode changes', async () => {
    const t = setup();
    t.r.add(t.n.id, t.layer.id, 'fade');
    t.r.update(1500000);
    expect(t.r.states.value[t.layer.id].alpha).toBe(1);
    t.r.update(0);
    expect(t.r.states.value[t.layer.id].alpha).toBe(0);
    t.r.audition.value = false;
    t.r.update(1500000);
    expect(t.r.states.value).toEqual({});
    t.r.override.value = 0.25;
    t.r.update(0);
    expect(t.r.states.value[t.layer.id].started).toBe(true);
    t.chart.setMode('preview');
    await nextTick();
    expect(t.r.override.value).toBeNull();
    t.r.update(0);
    expect(t.r.states.value[t.layer.id].alpha).toBe(0);
    t.dispose();
  });
});
