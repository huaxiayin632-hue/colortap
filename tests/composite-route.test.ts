import { afterEach, expect, it, vi } from 'vitest';
import { Container, Texture } from 'pixi.js';
import { compositeRoute, normalSubtrees } from '../src/core/composite-route';
import { createProject, type Layer } from '../src/shared/models';
import { identityTransform } from '../src/core/layers';
import { LayerScene } from '../src/renderer/canvas/layer-scene';
import { TileTextureCache } from '../src/renderer/canvas/texture-cache';
import { Viewport } from '../src/core/viewport';
import type { RevealState } from '../src/core/reveal';
// These tests cover scene ownership; actual shader output is checked in Electron.
vi.mock('../src/renderer/canvas/composite-filter', () => ({
  CompositeFilter: class {
    alpha = 1;
    destroy = vi.fn();
  },
}));

const base = {
  name: 'test',
  transform: identityTransform(),
  opacity: 1,
  enabled: true,
  locked: false,
  initialReveal: 1 as const,
  blendMode: 'normal',
};
const raster: Layer = {
  ...base,
  id: 'raster',
  kind: 'raster',
  pixelSourceId: 'pixels',
  clippingBaseId: 'bottom',
};
const group: Layer = {
  ...base,
  id: 'group',
  kind: 'group',
  childrenBottomToTop: ['raster'],
  isolation: 'isolated',
};
const mask = {
  position: { x: 0, y: 0 },
  defaultValue: 0.5,
  enabled: true,
  density: 1,
  feather: 0,
  positionRelativeToLayer: false,
};
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it('preserves the original AA surfaces when there is no document isolation', () => {
  expect(compositeRoute(group, 1, false, false, true, false, false).key).toBeDefined();
  expect(
    compositeRoute(
      { ...raster, clippingBaseId: undefined, rasterMask: mask },
      1,
      false,
      false,
      true,
      false,
      false,
    ).key,
  ).toBeDefined();
  // A clipping stack is always isolated, so its simple rasters still use atop.
  expect(compositeRoute(raster, 1, false, false, true, false, false).directClipped).toBe(true);
});

it('keeps backdrop-sensitive descendants isolated, including through pass-through parents', () => {
  const p = createProject();
  p.layers = {
    group: { ...group, childrenBottomToTop: ['nested'] },
    nested: { ...group, id: 'nested', isolation: 'pass-through' },
    raster: { ...raster, blendMode: 'multiply' },
  };
  p.rootLayersBottomToTop = ['group'];
  expect(normalSubtrees(p).has('group')).toBe(false);
  expect(compositeRoute(group, 1, false, false, false, false, true).key).toBeDefined();
  p.layers.raster = { ...raster };
  expect(normalSubtrees(p).has('group')).toBe(true);
  expect(compositeRoute(group, 1, false, false, true, false, true).key).toBeUndefined();
  expect(compositeRoute(group, 0.5, false, false, true, false, true).key).toBeDefined();
});
it('directly clips only unmasked normal rasters and keeps all complex flattening', () => {
  expect(compositeRoute(raster, 0.5, false, false, true, false, true).directClipped).toBe(true);
  for (const layer of [
    { ...raster, blendMode: 'multiply' },
    { ...raster, rasterMask: mask },
    { ...group, clippingBaseId: 'bottom' },
  ]) {
    expect(compositeRoute(layer, 1, false, false, true, false, true).directClipped).toBe(false);
    expect(compositeRoute(layer, 1, false, false, true, false, true).key).toBeDefined();
  }
  expect(compositeRoute(raster, 1, false, true, true, true, true).key).toBeDefined();
  expect(
    compositeRoute({ ...group, rasterMask: mask }, 1, false, false, false, false, true).key,
  ).toBeUndefined();
  expect(
    compositeRoute({ ...group, rasterMask: mask }, 0.5, false, false, false, false, true).key,
  ).toBeDefined();
  expect(
    compositeRoute({ ...group, opacity: 0.5 }, 0.5, true, false, true, false, true).key,
  ).toBeUndefined();
});
it('changes dynamic routes without replacing the scene, restores clipping alpha and disposes detached filters', () => {
  vi.stubGlobal('window', { devicePixelRatio: 1 });
  vi.spyOn(TileTextureCache.prototype, 'request').mockImplementation(() => {});
  vi.spyOn(TileTextureCache.prototype, 'get').mockReturnValue(Texture.WHITE);
  const p = createProject();
  p.stage.artworkSize = { width: 100, height: 100 };
  p.layers = {
    group: { ...group, childrenBottomToTop: ['bottom', 'raster'] },
    bottom: { ...raster, id: 'bottom', clippingBaseId: undefined },
    raster: { ...raster },
    backdrop: { ...raster, id: 'backdrop', clippingBaseId: undefined, blendMode: 'multiply' },
  };
  p.rootLayersBottomToTop = ['group', 'backdrop'];
  p.pixelSources.pixels = {
    id: 'pixels',
    sourceAssetId: 'asset',
    originalBounds: { x: 0, y: 0, width: 100, height: 100 },
    cropRect: { x: 0, y: 0, width: 100, height: 100 },
    levels: [],
  };
  const view = new Viewport();
  view.screen = { width: 100, height: 100 };
  view.zoom = 1;
  const scene = new LayerScene(
    'test',
    view,
    4096,
    () => {},
    () => {},
  );
  scene.setProject(p);
  scene.animate({});
  scene.flush();
  const container = scene.root.children[0] as Container;
  const composite = container.children[0] as Container;
  const created = scene.stats().sceneLayersCreated;
  const originalFilters = scene.stats().compositeFilters;
  const state: RevealState = {
    layerId: 'group',
    clipId: 'clip',
    started: true,
    rawProgress: 0.5,
    progress: 0.5,
    alpha: 0.5,
    scale: 1,
    offset: { x: 0, y: 0 },
    mask: null,
  };
  scene.animate({ group: state });
  scene.flush();
  expect(scene.stats().compositeFilters).toBe(originalFilters + 1);
  const filtered = composite.filters![0];
  const destroy = vi.spyOn(filtered, 'destroy');
  const rasterState = {
    ...state,
    layerId: 'raster',
    alpha: 1,
    mask: { kind: 'directional' as const, direction: { x: 1, y: 0 }, progress: 0.5 },
  };
  scene.animate({ group: state, raster: rasterState });
  scene.flush();
  expect(scene.stats().directClippedLayers).toBe(0);
  const attached = scene.stats().compositeFilters;
  for (let i = 0; i < 10; i++)
    scene.animate({ group: { ...state, alpha: 0.6 + i / 100 }, raster: rasterState });
  expect(scene.stats().compositeFilters).toBe(attached);
  expect(destroy).not.toHaveBeenCalled();
  scene.animate({});
  scene.flush();
  expect(destroy).toHaveBeenCalledOnce();
  expect(scene.stats().directClippedLayers).toBe(1);
  expect(scene.stats().compositeFilters).toBe(originalFilters);
  expect(container.alpha).toBe(1);
  expect(scene.stats().sceneLayersCreated).toBe(created);
  expect(scene.root.children[0]).toBe(container);
  const changed = structuredClone(p);
  changed.layers.raster.rasterMask = mask;
  scene.setProject(changed);
  scene.animate({});
  scene.flush();
  expect(scene.stats().directClippedLayers).toBe(0);
  scene.setProject(p);
  scene.animate({});
  scene.flush();
  expect(scene.stats().directClippedLayers).toBe(1);
  // Editing the last backdrop blend changes the document surface. Reparenting
  // it under this group changes the subtree proof; neither edit recreates layers.
  const plain = structuredClone(p);
  plain.layers.backdrop.blendMode = 'normal';
  scene.setProject(plain);
  scene.animate({});
  scene.flush();
  expect(composite.filters).toHaveLength(1);
  const nested = structuredClone(p);
  nested.rootLayersBottomToTop = ['group'];
  if (nested.layers.group.kind === 'group')
    nested.layers.group.childrenBottomToTop.push('backdrop');
  scene.setProject(nested);
  scene.animate({});
  scene.flush();
  expect(composite.filters).toHaveLength(1);
  scene.setProject(p);
  scene.animate({});
  scene.flush();
  expect(composite.filters ?? []).toHaveLength(0);
  expect(scene.stats().sceneLayersCreated).toBe(created);
  expect(scene.stats().compositeFilters).toBe(originalFilters);
  scene.dispose();
  expect(container.destroyed).toBe(true);
});
