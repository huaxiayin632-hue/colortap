import { afterEach, describe, expect, it, vi } from 'vitest';
import { EditHistory } from '../src/application/history';
import { identityTransform } from '../src/core/layers';
import { Viewport } from '../src/core/viewport';
import { createProject } from '../src/shared/models';
import { LayerScene } from '../src/renderer/canvas/layer-scene';
import { Container, Graphics } from 'pixi.js';
import type { RevealState } from '../src/core/reveal';

afterEach(() => vi.unstubAllGlobals());
describe('scene ownership across document edits', () => {
  it('keeps illustration objects through property edits and undo, then releases them on disposal', () => {
    vi.stubGlobal('window', { devicePixelRatio: 1 });
    vi.stubGlobal(
      'requestAnimationFrame',
      vi.fn(() => 1),
    );
    vi.stubGlobal('cancelAnimationFrame', vi.fn());
    const p = createProject(),
      id = crypto.randomUUID();
    p.layers[id] = {
      id,
      name: '分组',
      kind: 'group',
      childrenBottomToTop: [],
      isolation: 'pass-through',
      transform: identityTransform(),
      opacity: 1,
      enabled: true,
      locked: false,
      initialReveal: 1,
      blendMode: 'normal',
    };
    p.rootLayersBottomToTop = [id];
    const h = new EditHistory(p);
    const scene = new LayerScene(
      'test',
      new Viewport(),
      4096,
      () => {},
      () => {},
    );
    scene.setProject(p);
    const original = scene.root.children[0];
    h.execute({ type: 'rename', name: '改名' });
    scene.setProject(h.current);
    expect(scene.root.children[0]).toBe(original);
    h.execute({
      type: 'put-camera-key',
      key: {
        id: crypto.randomUUID(),
        at: { basis: 'time', timeUs: 0 },
        position: { x: 3000, y: 3000 },
        zoom: 2,
        rotationRad: 0,
        easingToNext: 'linear',
      },
    });
    scene.setProject(h.current);
    expect(scene.root.children[0]).toBe(original);
    expect(original.destroyed).toBe(false);
    h.execute({ type: 'set-layer', id, patch: { enabled: false } });
    scene.setProject(h.current);
    expect(original.destroyed).toBe(false);
    expect(scene.root.children[0]).toBe(original);
    expect(scene.root.children[0].visible).toBe(false);
    h.undo();
    scene.setProject(h.current);
    expect(scene.root.children[0].visible).toBe(true);
    const last = scene.root.children[0];
    scene.dispose();
    expect(last.destroyed).toBe(true);
  });
  it('updates ancestor reveal bounds and same-progress mask geometry while reusing layer containers', () => {
    vi.stubGlobal('window', { devicePixelRatio: 1 });
    vi.stubGlobal('requestAnimationFrame', () => 1);
    vi.stubGlobal('cancelAnimationFrame', vi.fn());
    const p = createProject(),
      group = crypto.randomUUID(),
      leaf = crypto.randomUUID(),
      source = crypto.randomUUID();
    const base = {
      name: 'test',
      transform: identityTransform(),
      opacity: 1,
      enabled: true,
      locked: false,
      initialReveal: 1 as const,
      blendMode: 'normal',
    };
    p.layers[group] = {
      ...base,
      id: group,
      kind: 'group',
      isolation: 'pass-through',
      childrenBottomToTop: [leaf],
    };
    p.layers[leaf] = { ...base, id: leaf, kind: 'raster', pixelSourceId: source };
    p.pixelSources[source] = {
      id: source,
      sourceAssetId: source,
      originalBounds: { x: 0, y: 0, width: 100, height: 80 },
      cropRect: { x: 0, y: 0, width: 100, height: 80 },
      levels: [],
    };
    p.rootLayersBottomToTop = [group];
    const scene = new LayerScene(
      'test',
      new Viewport(),
      4096,
      () => {},
      () => {},
    );
    scene.setProject(p);
    const original = scene.root.children[0];
    const state: RevealState = {
      layerId: group,
      clipId: 'clip',
      started: true,
      rawProgress: 0.5,
      progress: 0.5,
      alpha: 1,
      scale: 0.5,
      offset: { x: 0, y: 0 },
      mask: null,
    };
    scene.animate({ [group]: state });
    expect(original.x).toBeCloseTo(25);
    const moved = {
      ...p,
      layers: {
        ...p.layers,
        [leaf]: {
          ...p.layers[leaf],
          transform: { ...identityTransform(), position: { x: 100, y: 0 } },
        },
      },
    };
    scene.setProject(moved);
    scene.animate({ [group]: state });
    expect(scene.root.children[0]).toBe(original);
    expect(original.x).toBeCloseTo(75);
    scene.flush();
    const updates = vi.spyOn(scene, 'update');
    scene.animate({ [group]: { ...state, offset: { x: 40, y: 0 } } });
    expect(updates).toHaveBeenCalledOnce();
    const maskState: RevealState = {
      ...state,
      scale: 1,
      mask: { kind: 'directional', direction: { x: 1, y: 0 }, progress: 0.5 },
    };
    scene.animate({ [group]: maskState });
    const reveal = (original as Container).children[0] as Container;
    const mask = (reveal.children[0] as Container).children.find(
      (c) => c instanceof Graphics,
    ) as Graphics;
    const before = { ...mask.getLocalBounds() };
    scene.setProject({ ...moved, reveals: { ...moved.reveals } });
    scene.animate({
      [group]: {
        ...maskState,
        mask: { kind: 'directional', direction: { x: 0, y: 1 }, progress: 0.5 },
      },
    });
    expect(mask.getLocalBounds().width).not.toBe(before.maxX - before.minX);
    scene.dispose();
  });
});
