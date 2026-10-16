import { describe, expect, it } from 'vitest';
import { Viewport } from '../src/core/viewport';
import { chooseLevel, planTiles } from '../src/core/tiles';

describe('viewport coordinate transforms', () => {
  it('keeps the world point under the mouse fixed while zooming', () => {
    const view = new Viewport();
    view.screen = { width: 1000, height: 700 };
    view.fit({ width: 6000, height: 6000 });
    const mouse = { x: 723, y: 311 },
      before = view.toWorld(mouse);
    view.zoomAt(mouse, view.zoom * 2.5);
    expect(view.toWorld(mouse).x).toBeCloseTo(before.x, 8);
    expect(view.toWorld(mouse).y).toBeCloseTo(before.y, 8);
  });
  it('fits large canvases without changing source coordinates or allocating a source-sized viewport', () => {
    const view = new Viewport();
    view.screen = { width: 1000, height: 700 };
    view.fit({ width: 60000, height: 48000 });
    expect(view.zoom).toBeGreaterThan(0);
    expect(view.zoom).toBeLessThan(0.02);
    expect(view.screen).toEqual({ width: 1000, height: 700 });
    const point = { x: 54321, y: -456 };
    const restored = view.toWorld(view.toScreen(point));
    expect(restored.x).toBeCloseTo(point.x, 7);
    expect(restored.y).toBeCloseTo(point.y, 7);
  });
});

describe('lazy render tile planning', () => {
  const caps = {
    maxTextureSize: 2048,
    maxRenderbufferSize: 2048,
    maxViewport: { width: 2048, height: 2048 },
  };
  it('covers a 6000 square exactly while including GPU gutter in size limits', () => {
    const tiles = [
      ...planTiles({ width: 6000, height: 6000 }, { x: 0, y: 0, width: 6000, height: 6000 }, caps),
    ];
    expect(tiles).toHaveLength(9);
    expect(tiles.reduce((sum, tile) => sum + tile.width * tile.height, 0)).toBe(36000000);
    expect(tiles.every((tile) => tile.width + 4 <= 2048 && tile.height + 4 <= 2048)).toBe(true);
    expect(tiles.at(-1)).toEqual({ x: 4088, y: 4088, width: 1912, height: 1912 });
  });
  it('requests only tiles intersecting the viewport and supports source dimensions beyond 6000', () => {
    const tiles = [
      ...planTiles(
        { width: 12000, height: 12000 },
        { x: 5200, y: 5200, width: 200, height: 200 },
        caps,
      ),
    ];
    expect(tiles).toHaveLength(1);
    expect(tiles[0].x).toBe(4088);
  });
  it('uses the smaller renderbuffer limit and refuses impossible padding', () => {
    const tiles = [
      ...planTiles(
        { width: 1000, height: 1000 },
        { x: 0, y: 0, width: 1000, height: 1000 },
        { ...caps, maxRenderbufferSize: 512 },
      ),
    ];
    expect(tiles.every((tile) => tile.width <= 508)).toBe(true);
    expect(() => [
      ...planTiles(
        { width: 10, height: 10 },
        { x: 0, y: 0, width: 10, height: 10 },
        { ...caps, maxTextureSize: 4 },
      ),
    ]).toThrow();
  });
  it('selects preview levels without discarding the full-resolution representation', () => {
    const levels = [0, 1, 2, 3];
    expect(chooseLevel(0.25, levels)).toBe(2);
    expect(chooseLevel(1, levels)).toBe(0);
    expect(chooseLevel(2, levels)).toBe(0);
    expect(levels).toEqual([0, 1, 2, 3]);
  });
  it('rejects non-finite regions and invalid capabilities instead of silently skipping tiles', () => {
    const size = { width: 6000, height: 6000 };
    expect(() => [...planTiles(size, { x: NaN, y: 0, width: 100, height: 100 }, caps)]).toThrow();
    expect(() => [
      ...planTiles(size, { x: 0, y: 0, width: 100, height: 100 }, { ...caps, maxTextureSize: NaN }),
    ]).toThrow();
    expect(() => chooseLevel(1, [-1])).toThrow();
  });
});
