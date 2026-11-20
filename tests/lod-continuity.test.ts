import { afterEach, expect, it, vi } from 'vitest';
import { Container, Sprite, Texture } from 'pixi.js';
import { LayerScene } from '../src/renderer/canvas/layer-scene';
import { TileTextureCache } from '../src/renderer/canvas/texture-cache';
import { createProject } from '../src/shared/models';
import { identityTransform } from '../src/core/layers';
import { Viewport } from '../src/core/viewport';
import type { RevealState } from '../src/core/reveal';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
it('retains a complete LOD across edits to a paused animated layer until every replacement tile is ready', () => {
  const raf = vi.fn();
  vi.stubGlobal('requestAnimationFrame', raf);
  vi.stubGlobal('window', { devicePixelRatio: 1 });
  const loaded = new Set(['low']);
  vi.spyOn(TileTextureCache.prototype, 'get').mockImplementation((id) =>
    loaded.has(id) ? Texture.WHITE : undefined,
  );
  const requests = vi.spyOn(TileTextureCache.prototype, 'request').mockImplementation(() => {});
  const p = createProject();
  p.stage.artworkSize = { width: 100, height: 100 };
  const source = 'source',
    id = 'layer';
  const tile = (assetId: string, x: number, width: number, scale: number) => ({
    assetId,
    sourceRect: { x, y: 0, width, height: 100 },
    pixelRect: { x: 0, y: 0, width: width * scale, height: 100 * scale },
  });
  const levels = [
    {
      level: 0,
      scale: 1,
      pixelSize: { width: 100, height: 100 },
      tileSize: 50,
      gutter: 0,
      tiles: [tile('left', 0, 50, 1), tile('right', 50, 50, 1)],
    },
    {
      level: 1,
      scale: 0.5,
      pixelSize: { width: 50, height: 50 },
      tileSize: 50,
      gutter: 0,
      tiles: [tile('low', 0, 100, 0.5)],
    },
  ];
  p.pixelSources[source] = {
    id: source,
    sourceAssetId: source,
    originalBounds: { x: 0, y: 0, width: 100, height: 100 },
    cropRect: { x: 0, y: 0, width: 100, height: 100 },
    levels,
  };
  for (const level of levels)
    for (const tile of level.tiles)
      p.assets[tile.assetId] = {
        id: tile.assetId,
        kind: 'png',
        relativePath: tile.assetId,
        originalName: tile.assetId,
        sha256: 'a'.repeat(64),
        byteLength: 1,
        pixelSize: { width: tile.pixelRect.width, height: tile.pixelRect.height },
      };
  p.layers[id] = {
    id,
    name: 'outside base',
    kind: 'raster',
    pixelSourceId: source,
    transform: { ...identityTransform(), position: { x: 200, y: 0 } },
    opacity: 0.5,
    enabled: true,
    locked: false,
    initialReveal: 1,
    blendMode: 'normal',
  };
  p.rootLayersBottomToTop = [id];
  const view = new Viewport();
  view.zoom = 0.5;
  view.screen = { width: 100, height: 100 };
  const scene = new LayerScene(
    'test',
    view,
    4096,
    () => {},
    () => {},
  );
  const state: RevealState = {
    layerId: id,
    clipId: 'clip',
    started: true,
    rawProgress: 0.5,
    progress: 0.5,
    alpha: 1,
    scale: 1,
    offset: { x: -200, y: 0 },
    mask: null,
  };
  const render = () => {
    scene.animate({ [id]: state });
    scene.flush();
  };
  scene.setProject(p);
  render();
  const collect = (container: Container): Sprite[] =>
    container.children.flatMap((c) =>
      c instanceof Sprite ? [c] : c instanceof Container ? collect(c) : [],
    );
  const original = collect(scene.root)[0];
  expect(collect(scene.root)).toHaveLength(1);
  view.zoom = 1;
  scene.update();
  render();
  loaded.add('left');
  scene.update();
  render();
  expect(collect(scene.root)).toEqual([original]);
  scene.setProject({ ...p, layers: { ...p.layers, [id]: { ...p.layers[id], name: 'renamed' } } });
  expect(raf).not.toHaveBeenCalled(); // No independent culling before the stage applies the paused pose.
  render();
  expect(collect(scene.root)).toEqual([original]);
  expect(requests.mock.lastCall?.[1]).toContain('low');
  loaded.add('right');
  scene.update();
  render();
  expect(original.destroyed).toBe(true);
  expect(collect(scene.root)).toHaveLength(2);
  expect(requests.mock.lastCall?.[1]).not.toContain('low');
  scene.dispose();
});
