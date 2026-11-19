import { describe, expect, it, vi } from 'vitest';
import { createProject, type Layer, type Project, type Vec2 } from '../src/shared/models';
import { createSlider, copyNotes } from '../src/core/chart';
import { identityTransform, point } from '../src/core/layers';
import { PathBindings, identityMatrix } from '../src/core/path-binding';
import { SceneGeometry } from '../src/core/scene-geometry';
import { RevealEvaluator, resolveRevealPath } from '../src/core/reveal';
import { PlaybackTake } from '../src/core/playback';
import { PlaySession } from '../src/core/judgement';
import { ArcPath } from '../src/core/path';
import { EditHistory } from '../src/application/history';
import { serializeProject, validateProject } from '../src/shared/schema';
import { createChart } from '../src/renderer/chart/controller';

function fixture() {
  const p = createProject('绑定验证', { width: 512, height: 384 });
  const group = (name: string): Extract<Layer, { kind: 'group' }> => ({
    id: crypto.randomUUID(),
    name,
    kind: 'group',
    childrenBottomToTop: [],
    isolation: 'pass-through',
    transform: identityTransform(),
    opacity: 1,
    enabled: true,
    locked: false,
    initialReveal: 1,
    blendMode: 'normal',
  });
  const parent = group('父分组'),
    layer = group('曲线层');
  parent.childrenBottomToTop.push(layer.id);
  p.layers[parent.id] = parent;
  p.layers[layer.id] = layer;
  p.rootLayersBottomToTop = [parent.id];
  const { note, path } = createSlider(
    { x: 100, y: 100 },
    { x: 300, y: 100 },
    { basis: 'time', timeUs: 1e6 },
  );
  note.duration = { basis: 'time', durationUs: 2e6 };
  p.notes[note.id] = note;
  p.paths[path.id] = path;
  note.binding = { layerId: layer.id, reference: identityTransform() };
  p.camera.enabled = false;
  return { p, parent, layer, note, path };
}
function expectPoint(actual: Vec2, expected: Vec2) {
  expect(actual.x).toBeCloseTo(expected.x, 7);
  expect(actual.y).toBeCloseTo(expected.y, 7);
}
function key(p: Project, time: number, x: number, zoom = 1, angle = 0) {
  const id = crypto.randomUUID();
  p.camera.enabled = true;
  p.camera.keys[id] = {
    id,
    at: { basis: 'time', timeUs: time },
    position: { x: 256 + x, y: 192 },
    zoom,
    rotationRad: angle,
    easingToNext: 'linear',
  };
}
function simulate(p: Project, fps: number, pointer: Vec2) {
  const take = new PlaybackTake(),
    geometry = new SceneGeometry(p);
  const session = new PlaySession(
    p,
    0,
    (e) => take.accept(e),
    { matrix: (n, t) => geometry.display(n, t, 'playtest', take) },
    take.recordTrack,
  );
  session.input(1e6, pointer, true, true);
  for (let t = 1e6 + 1e6 / fps; t < 3e6; t += 1e6 / fps) session.advance(t);
  session.advance(3e6);
  return session.snapshot().results[Object.keys(p.notes)[0]];
}
describe('layer-attached Slider geometry', () => {
  it('queries only the target ancestry while matching the complete scene pose', () => {
    const { p, parent, layer, note } = fixture(),
      take = new PlaybackTake();
    parent.transform.rotationRad = 0.2;
    layer.transform.scale = { x: 1.3, y: 0.7 };
    const targets = [parent.id, layer.id];
    for (let i = 0; i < 100; i++) {
      const id = crypto.randomUUID();
      p.layers[id] = { ...structuredClone(layer), id };
      p.rootLayersBottomToTop.push(id);
      targets.push(id);
    }
    for (const layerId of targets) {
      const id = crypto.randomUUID();
      p.reveals[id] = {
        id,
        layerId,
        trigger: { kind: 'note', noteId: note.id, event: 'hit' },
        effect: { kind: 'slide-in', offset: { x: 20, y: 10 } },
        easing: 'linear',
        progress: { kind: 'elapsed', duration: { basis: 'time', durationUs: 2e6 } },
        after: 'hold',
        priority: 0,
      };
    }
    key(p, 0, 40, 1.5, 0.3);
    take.accept({ kind: 'session-reset', runId: 'scope', timeUs: 0 });
    take.accept({ kind: 'slider-start', noteId: note.id, runId: 'scope', timeUs: 1e6 });
    const geometry = new SceneGeometry(p),
      triggers = vi.spyOn(take, 'triggerTime'),
      complete = geometry.at(1.5e6, 'playtest', take),
      expected = geometry.bindings.display(note, complete.camera, complete.poses);
    expect(triggers).toHaveBeenCalledTimes(102);
    triggers.mockClear();
    expect(geometry.display(note, 1.5e6, 'playtest', take)).toEqual(expected);
    expect(triggers).toHaveBeenCalledTimes(2);
    const free = structuredClone(note);
    delete free.binding;
    expect(geometry.display(free, 1.5e6, 'playtest', take)).toEqual(identityMatrix());
    expect(triggers).toHaveBeenCalledTimes(2);
    triggers.mockRestore();
  });
  it('attaches and detaches without jumping under a rotated, zoomed camera and nested transforms', () => {
    const { p, note, parent, layer } = fixture();
    delete note.binding;
    parent.transform.position = { x: 40, y: -20 };
    parent.transform.rotationRad = 0.3;
    layer.transform.scale = { x: 1.4, y: 0.7 };
    layer.transform.skewRad.x = 0.2;
    key(p, 0, 70, 1.6, 0.4);
    const geometry = new SceneGeometry(p),
      pose = geometry.at(1e6, 'preview');
    const bound = geometry.bindings.attach(note, layer.id, pose.camera, pose.poses);
    const head = new ArcPath(p.paths[note.path.pathId], note.path.transform).at(0);
    expectPoint(
      point(
        geometry.bindings.display(bound, pose.camera, pose.poses),
        new ArcPath(p.paths[bound.path.pathId], bound.path.transform).at(0),
      ),
      head,
    );
    const free = geometry.bindings.attach(bound, null, pose.camera, pose.poses);
    expect(free.binding).toBeUndefined();
    expectPoint(new ArcPath(p.paths[free.path.pathId], free.path.transform).at(0), head);
    expect(note.binding).toBeUndefined();
  });
  it('shares the exact animated layer transform with linked outlines without rebuilding their arc tables', () => {
    const { p, note, parent, layer } = fixture();
    parent.transform.position.x = 25;
    const revealId = crypto.randomUUID();
    p.reveals[revealId] = {
      id: revealId,
      layerId: layer.id,
      trigger: { kind: 'timeline', at: { basis: 'time', timeUs: 0 } },
      effect: { kind: 'slide-in', offset: { x: 80, y: 10 } },
      easing: 'linear',
      progress: { kind: 'elapsed', duration: { basis: 'time', durationUs: 2e6 } },
      after: 'hold',
      priority: 1,
    };
    const outlineId = crypto.randomUUID();
    p.reveals[outlineId] = {
      id: outlineId,
      layerId: parent.id,
      trigger: { kind: 'timeline', at: { basis: 'time', timeUs: 0 } },
      effect: {
        kind: 'outline',
        path: structuredClone(note.path),
        linkedSliderId: note.id,
        drawing: { mode: 'single', start: 0, forwardRatio: 0.5 },
        stroke: { color: '#ffffff', width: 1, glow: 1, tips: true, tipSize: 2 },
        layer: { kind: 'instant', threshold: 1, durationUs: 0, fromScale: 1, overshoot: 0 },
        lineAfter: { kind: 'keep', durationUs: 0 },
      },
      easing: 'linear',
      progress: { kind: 'elapsed', duration: { basis: 'time', durationUs: 2e6 } },
      after: 'hold',
      priority: 1,
    };
    const evaluate = new RevealEvaluator(p),
      a = evaluate.evaluate(0.5e6, { mode: 'preview' }),
      b = evaluate.evaluate(1.5e6, { mode: 'preview' });
    expect(a[parent.id].outline!.arc).toBe(b[parent.id].outline!.arc);
    const arc = new ArcPath(p.paths[note.path.pathId], note.path.transform);
    const bound = new PathBindings(p);
    for (const state of [a, b]) {
      const outline = state[parent.id].outline!;
      expectPoint(
        point(outline.transform!, outline.arc.at(0.4)),
        point(bound.display(note, identityMatrix(), state), arc.at(0.4)),
      );
      const resolved = resolveRevealPath(
        p,
        p.reveals[outlineId].effect as Extract<
          (typeof p.reveals)[string]['effect'],
          { kind: 'outline' }
        >,
        state,
      );
      expectPoint(
        new ArcPath(p.paths[resolved.pathId], resolved.transform).at(0.4),
        point(outline.transform!, outline.arc.at(0.4)),
      );
    }
  });
  it('keeps a stationary pointer valid when camera movement exactly cancels the sliding ball, at any update rate', () => {
    const { p } = fixture();
    key(p, 1e6, 0);
    key(p, 3e6, 200);
    for (const fps of [0.5, 30, 60, 144]) {
      const r = simulate(p, fps, { x: 100, y: 100 });
      expect(r.status).toBe('complete');
      expect(r.progress).toBeCloseTo(1, 8);
    }
  });
  it('counts a stationary pointer outside once a moving target leaves its real follow radius', () => {
    const { p, note, path } = fixture();
    path.nodes[1].point = { x: 100, y: 100 };
    path.nodes.forEach((n) => {
      n.handleIn = { x: 0, y: 0 };
      n.handleOut = { x: 0, y: 0 };
    });
    note.followRadius = 10;
    key(p, 1e6, 0);
    key(p, 3e6, 100);
    for (const fps of [0.5, 30, 144]) {
      const r = simulate(p, fps, { x: 100, y: 100 });
      expect(r.status).toBe('failed');
      expect(r.trackedUs).toBeCloseTo(200000, 4);
    }
  });
  it('remains reproducible when its own valid-follow progress moves the attached layer', () => {
    const { p, note, layer } = fixture(),
      id = crypto.randomUUID();
    note.followRadius = 1;
    p.reveals[id] = {
      id,
      layerId: layer.id,
      trigger: { kind: 'timeline', at: { basis: 'time', timeUs: 0 } },
      effect: { kind: 'slide-in', offset: { x: 200, y: 0 } },
      easing: 'linear',
      progress: { kind: 'slider-follow', noteId: note.id },
      after: 'hold',
      priority: 0,
    };
    note.binding!.reference.position.x = 200;
    const results = [0.5, 30, 144].map((fps) => simulate(p, fps, { x: 100, y: 100 }));
    expect(results.every((r) => r.status === 'complete')).toBe(true);
    expect(
      Math.max(...results.map((r) => r.trackedUs)) - Math.min(...results.map((r) => r.trackedUs)),
    ).toBeLessThan(0.01);
  });
  it('rejects missing/zero reference bindings and retains valid binding data on save, copy and undo', () => {
    const { p, note, layer } = fixture();
    expect(validateProject(JSON.parse(serializeProject(p))).notes[note.id]).toEqual(note);
    const copied = copyNotes(p, [note.id]);
    expect(copied.notes[0]).toMatchObject({ binding: note.binding });
    expect((copied.notes[0] as typeof note).path.pathId).not.toBe(note.path.pathId);
    const bad = structuredClone(p);
    (bad.notes[note.id] as typeof note).binding!.reference.scale.x = 0;
    expect(() => validateProject(bad)).toThrow('零缩放');
    (bad.notes[note.id] as typeof note).binding = {
      layerId: crypto.randomUUID(),
      reference: identityTransform(),
    };
    expect(() => validateProject(bad)).toThrow('贴合图层');
    const history = new EditHistory(p);
    history.execute({
      type: 'set-layer',
      id: layer.id,
      patch: { transform: { ...identityTransform(), position: { x: 40, y: 0 } } },
    });
    expect(
      point(new SceneGeometry(history.current).display(note, 0, 'preview'), { x: 100, y: 100 }).x,
    ).toBe(140);
    history.undo();
    expect(
      point(new SceneGeometry(history.current).display(note, 0, 'preview'), { x: 100, y: 100 }).x,
    ).toBe(100);
  });
  it('detaches notes when their layer or ancestor is deleted, preserving current screen position and undo', () => {
    const { p, parent, note } = fixture();
    parent.transform.position.x = 50;
    key(p, 0, 20, 1.4, 0.2);
    const g = new SceneGeometry(p),
      arc = new ArcPath(p.paths[note.path.pathId], note.path.transform),
      expected = point(g.display(note, 2e6, 'preview'), arc.at(0.6));
    const history = new EditHistory(p);
    history.execute({ type: 'delete-layer', id: parent.id, atUs: 2e6 });
    const detached = history.current.notes[note.id] as typeof note;
    expect(detached.binding).toBeUndefined();
    expectPoint(
      new ArcPath(history.current.paths[detached.path.pathId], detached.path.transform).at(0.6),
      expected,
    );
    history.undo();
    expect(history.current.notes[note.id]).toEqual(note);
  });
  it('edits control points in the visible space and can reuse an existing artwork path', () => {
    const { p, note, parent, layer, path } = fixture();
    parent.transform.position.x = 40;
    const history = new EditHistory(p),
      clock = { time: 0 };
    const chart = createChart({
      project: () => history.current,
      time: () => clock.time,
      playing: () => false,
      commit(c) {
        history.execute(c);
        chart.setProject(history.current);
        return true;
      },
      pause() {},
      seek() {},
      async play() {},
      selectLayer() {},
      notify() {},
    });
    chart.select(note.id);
    chart.moveNode(path.nodes[0].id, 'point', { x: 155, y: 110 }, true);
    const updated = history.current.paths[path.id].nodes[0].point;
    expectPoint(updated, { x: 115, y: 110 });
    chart.bindLayer(null);
    expect((history.current.notes[note.id] as typeof note).binding).toBeUndefined();
    chart.bindLayer(layer.id);
    expect((history.current.notes[note.id] as typeof note).binding?.layerId).toBe(layer.id);
    chart.dispose();
  });
});
