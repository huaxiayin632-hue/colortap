import { describe, expect, it } from 'vitest';
import {
  decompose,
  identityTransform,
  matrix,
  multiply,
  point,
  worldMatrix,
} from '../src/core/layers';
import { createProject, type Layer } from '../src/shared/models';
import { EditHistory } from '../src/application/history';

function setup() {
  const p = createProject();
  const group = (name: string): Extract<Layer, { kind: 'group' }> => ({
    id: crypto.randomUUID(),
    kind: 'group',
    name,
    childrenBottomToTop: [],
    isolation: 'isolated',
    transform: identityTransform(),
    opacity: 1,
    enabled: true,
    locked: false,
    initialReveal: 1,
    blendMode: 'normal',
  });
  const a = group('A'),
    b = group('B'),
    c = group('C');
  for (const g of [a, b, c]) p.layers[g.id] = g;
  p.rootLayersBottomToTop = [a.id, b.id];
  a.childrenBottomToTop = [c.id];
  a.transform.position = { x: 80, y: 40 };
  a.transform.scale = { x: 2, y: 1.3 };
  a.transform.rotationRad = 0.4;
  b.transform.position = { x: -20, y: 56 };
  b.transform.scale = { x: 0.6, y: 3 };
  b.transform.rotationRad = -0.3;
  c.transform.position = { x: 20, y: 44 };
  c.transform.rotationRad = 0.7;
  return { p, a, b, c };
}
describe('layer editing and transform math', () => {
  it('preserves world coordinates on reparenting under rotated/nonuniformly scaled groups and supports undo', () => {
    const { p, b, c } = setup(),
      h = new EditHistory(p),
      before = worldMatrix(p, c.id);
    h.execute({ type: 'move-layer', id: c.id, parentId: b.id, index: 0 });
    const after = worldMatrix(h.current, c.id);
    for (const key of Object.keys(before) as (keyof typeof before)[])
      expect(after[key]).toBeCloseTo(before[key], 9);
    h.undo();
    expect(h.current).toEqual(p);
    h.redo();
    expect(h.current.layers[b.id]).toMatchObject({ childrenBottomToTop: [c.id] });
  });
  it('decomposes reflection and skew without changing rendered positions', () => {
    const t = identityTransform();
    t.scale = { x: -2, y: 0.7 };
    t.skewRad = { x: 0.2, y: 0.1 };
    t.pivot = { x: 12, y: 30 };
    t.rotationRad = -0.7;
    const m = matrix(t),
      roundTrip = matrix(decompose(m));
    expect(point(roundTrip, { x: 10, y: 20 }).x).toBeCloseTo(point(m, { x: 10, y: 20 }).x, 9);
    expect(point(roundTrip, { x: 10, y: 20 }).y).toBeCloseTo(point(m, { x: 10, y: 20 }).y, 9);
    expect(multiply(matrix(identityTransform()), m)).toEqual(m);
  });
  it('rejects cycles and inherited locks without changing the document', () => {
    const { p, a, c } = setup(),
      h = new EditHistory(p);
    expect(() => h.execute({ type: 'move-layer', id: a.id, parentId: c.id, index: 0 })).toThrow(
      '自身',
    );
    h.execute({ type: 'set-layer', id: a.id, patch: { locked: true } });
    const locked = h.current;
    expect(() => h.execute({ type: 'set-layer', id: c.id, patch: { opacity: 0.2 } })).toThrow(
      '解锁',
    );
    expect(() => h.execute({ type: 'move-layer', id: c.id, parentId: null, index: 0 })).toThrow(
      '解锁',
    );
    expect(h.current).toBe(locked);
  });
  it('keeps order within a parent deterministic and restores visibility/opacity/group expansion', () => {
    const { p, a, b } = setup(),
      h = new EditHistory(p);
    h.execute({ type: 'move-layer', id: a.id, parentId: null, index: 2 });
    expect(h.current.rootLayersBottomToTop).toEqual([b.id, a.id]);
    h.execute({ type: 'set-layer', id: a.id, patch: { opacity: 0.25, enabled: false } });
    h.execute({ type: 'set-group-expanded', id: a.id, expanded: false });
    h.markSaved();
    expect(h.current.layers[a.id]).toMatchObject({
      opacity: 0.25,
      enabled: false,
      expanded: false,
    });
    h.undo();
    expect(h.dirty).toBe(true);
    h.redo();
    expect(h.dirty).toBe(false);
  });
  it('deletes a nested group and dependent bindings atomically, restoring the entire subtree on undo', () => {
    const { p, a, b, c } = setup();
    const revealId = crypto.randomUUID(),
      soundId = crypto.randomUUID(),
      assetId = crypto.randomUUID();
    p.assets[assetId] = {
      id: assetId,
      kind: 'audio',
      relativePath: 'assets/test.wav',
      originalName: 'test.wav',
      byteLength: 0,
      sha256: '0'.repeat(64),
    };
    p.reveals[revealId] = {
      id: revealId,
      layerId: c.id,
      trigger: { kind: 'timeline', at: { basis: 'time', timeUs: 0 } },
      effect: { kind: 'instant' },
      easing: 'linear',
      progress: { kind: 'elapsed', duration: { basis: 'time', durationUs: 0 } },
      after: 'hold',
      priority: 0,
    };
    p.sounds[soundId] = {
      id: soundId,
      assetId,
      trigger: { kind: 'reveal-start', revealId },
      delayUs: 0,
      gain: 1,
      pan: 0,
    };
    const h = new EditHistory(p);
    h.execute({ type: 'delete-layer', id: a.id });
    expect(Object.keys(h.current.layers)).toEqual([b.id]);
    expect(h.current.rootLayersBottomToTop).toEqual([b.id]);
    expect(h.current.reveals).toEqual({});
    expect(h.current.sounds).toEqual({});
    expect(p.layers[c.id]).toBe(c);
    h.undo();
    expect(h.current).toEqual(p);
    h.redo();
    expect(h.current.layers[a.id]).toBeUndefined();
    expect(h.current.layers[c.id]).toBeUndefined();
  });
  it('deletes a child without changing siblings or the parent transform', () => {
    const { p, a, b, c } = setup(),
      h = new EditHistory(p);
    h.execute({ type: 'delete-layer', id: c.id });
    expect(h.current.layers[a.id]).toMatchObject({
      childrenBottomToTop: [],
      transform: a.transform,
    });
    expect(h.current.layers[b.id]).toEqual(b);
    expect(h.current.rootLayersBottomToTop).toEqual(p.rootLayersBottomToTop);
    h.undo();
    expect(h.current).toEqual(p);
  });
  it('rejects deletion of locked layers, locked descendants, inherited locks, and absent IDs', () => {
    const { p, a, c } = setup(),
      h = new EditHistory(p);
    h.execute({ type: 'set-layer', id: c.id, patch: { locked: true } });
    expect(() => h.execute({ type: 'delete-layer', id: c.id })).toThrow('解锁');
    expect(() => h.execute({ type: 'delete-layer', id: a.id })).toThrow('解锁');
    h.undo();
    h.execute({ type: 'set-layer', id: a.id, patch: { locked: true } });
    expect(() => h.execute({ type: 'delete-layer', id: c.id })).toThrow('解锁');
    expect(() => h.execute({ type: 'delete-layer', id: crypto.randomUUID() })).toThrow('不存在');
    expect(h.current.layers[c.id]).toBeDefined();
  });
});
