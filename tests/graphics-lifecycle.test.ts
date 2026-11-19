import { describe, expect, it, vi } from 'vitest';
import { Graphics, Texture } from 'pixi.js';
import { ArcPath, createNode } from '../src/core/path';
import type { BezierPath } from '../src/shared/models';
import { PathVectorStroke } from '../src/renderer/reveals/vector-stroke';
import { PathVectorMask } from '../src/renderer/reveals/vector-mask';

function arc() {
  const nodes = [
    createNode({ x: 0, y: 500 }),
    createNode({ x: 500, y: 0 }),
    createNode({ x: 1000, y: 500 }),
    createNode({ x: 500, y: 1000 }),
  ];
  const tangents = [
    { x: 0, y: -276 },
    { x: 276, y: 0 },
    { x: 0, y: 276 },
    { x: -276, y: 0 },
  ];
  nodes.forEach((node, i) => {
    node.handleOut = tangents[i];
    node.handleIn = { x: -tangents[i].x, y: -tangents[i].y };
  });
  const path: BezierPath = {
    id: crypto.randomUUID(),
    name: '资源释放测试',
    closed: true,
    defaultWidth: 12,
    interpolation: 'bezier',
    nodes,
  };
  return new ArcPath(path);
}

describe('owned vector resource lifetime', () => {
  it('unloads every outline chunk, moving boundary and light when the stroke is removed', () => {
    const stroke = new PathVectorStroke(arc(), false, {
      color: '#ffffff',
      width: 12,
      glow: 1,
      tips: true,
      tipSize: 16,
    });
    stroke.setRanges([{ from: 0, to: 0.65 }], [0.65]);
    const contexts = stroke.root.children.map((child) => (child as Graphics).context);
    expect(contexts.length).toBeGreaterThan(3);
    const unloaded = contexts.map((context) => {
      const listener = vi.fn();
      context.on('unload', listener);
      return listener;
    });
    stroke.dispose();
    stroke.dispose();
    expect(contexts.every((context) => context.destroyed)).toBe(true);
    for (const listener of unloaded) expect(listener).toHaveBeenCalledTimes(1);
    // Disposing owned geometry must not destroy shared textures or original artwork.
    expect(Texture.WHITE.destroyed).toBe(false);
  });

  it('unloads the old Path Reveal geometry when a mask is replaced or the scene closes', () => {
    const mask = new PathVectorMask(arc(), 24, false);
    mask.setProgress(0.5);
    const contexts = mask.root.children.map((child) => (child as Graphics).context);
    expect(contexts.length).toBeGreaterThan(2);
    const unloaded = contexts.map((context) => {
      const listener = vi.fn();
      context.on('unload', listener);
      return listener;
    });
    mask.dispose();
    expect(contexts.every((context) => context.destroyed)).toBe(true);
    for (const listener of unloaded) expect(listener).toHaveBeenCalledTimes(1);
    expect(Texture.WHITE.destroyed).toBe(false);
  });
});
