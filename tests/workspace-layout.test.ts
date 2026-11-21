import { describe, expect, it } from 'vitest';
import {
  fitLayout,
  presetLayout,
  readLayout,
  sectionIds,
  sectionSizes,
} from '../src/renderer/workspace/layout';

describe('local workspace preferences', () => {
  it('rejects corrupt JSON and unknown versions without blocking startup', () => {
    for (const raw of [null, '{broken', 'null', '[]', '{"version":99,"left":900}'])
      expect(readLayout(raw)).toEqual(presetLayout());
  });
  it('sanitizes each preference independently and ignores unrelated data', () => {
    const value = readLayout(
      JSON.stringify({
        version: 1,
        left: -200,
        right: '900',
        timeline: 1e9,
        collapsed: { left: true, right: 'yes' },
        sections: { layers: { weight: -4, collapsed: true } },
      }),
    );
    expect(value.left).toBe(220);
    expect(value.right).toBe(300);
    expect(value.timeline).toBe(1200);
    expect(value.collapsed).toEqual({ left: true, right: false, timeline: false });
    expect(value.sections.layers).toEqual({ weight: 0.01, collapsed: true });
    expect(readLayout(JSON.stringify(value))).toEqual(value);
  });
  it('keeps the canvas usable at the minimum window size and restores large-window preferences', () => {
    const layout = presetLayout();
    layout.left = 500;
    layout.right = 600;
    layout.timeline = 700;
    const original = JSON.stringify(layout);
    const small = fitLayout(layout, 1080, 720);
    expect(
      1080 - small.left - small.right - small.leftHandle - small.rightHandle,
    ).toBeGreaterThanOrEqual(359.99);
    expect(720 - 88 - 34 - small.timelineHandle - small.timeline - 27).toBeGreaterThanOrEqual(240);
    expect(fitLayout(layout, 2560, 1600)).toMatchObject({ left: 500, right: 600, timeline: 700 });
    expect(JSON.stringify(layout)).toBe(original);
  });
  it('keeps restore rails for collapsed panels and treats focus as a temporary view', () => {
    const layout = presetLayout();
    layout.collapsed = { left: true, right: true, timeline: true };
    expect(fitLayout(layout, 1080, 720)).toMatchObject({
      left: 28,
      right: 28,
      timeline: 28,
      leftHandle: 0,
    });
    const original = JSON.stringify(layout);
    expect(fitLayout(layout, 1080, 720, true)).toMatchObject({ left: 0, right: 0, timeline: 0 });
    expect(JSON.stringify(layout)).toBe(original);
  });
  it('distributes section space, returns it when collapsed, and restores proportions on reopening', () => {
    const layout = presetLayout();
    const before = sectionSizes(layout, 500);
    expect(sectionIds.reduce((sum, id) => sum + before[id], 12)).toBeCloseTo(500);
    layout.sections.assets.collapsed = true;
    const collapsed = sectionSizes(layout, 500);
    expect(collapsed.assets).toBe(32);
    expect(collapsed.layers).toBeGreaterThan(before.layers);
    layout.sections.assets.collapsed = false;
    expect(sectionSizes(layout, 500)).toEqual(before);
  });
  it('keeps all section headers reachable in short workspaces, even with everything folded', () => {
    const layout = presetLayout();
    const small = sectionSizes(layout, 170);
    expect(sectionIds.reduce((sum, id) => sum + small[id], 12)).toBeCloseTo(170);
    for (const id of sectionIds) layout.sections[id].collapsed = true;
    expect(sectionSizes(layout, 170)).toEqual({ layers: 32, assets: 32, sounds: 32 });
  });
  it('creates independent built-in presets with distinct space priorities', () => {
    const chart = presetLayout('chart'),
      show = presetLayout('show'),
      camera = presetLayout('camera');
    expect(chart.timeline).toBeGreaterThan(show.timeline);
    expect(show.left).toBeGreaterThan(chart.left);
    expect(show.right).toBeGreaterThan(chart.right);
    expect(camera.collapsed.left).toBe(true);
    expect(camera.timeline).toBeLessThan(show.timeline);
    chart.sections.layers.weight = 99;
    expect(presetLayout().sections.layers.weight).toBe(3);
  });
});
