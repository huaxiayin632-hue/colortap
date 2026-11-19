import { Graphics } from 'pixi.js';
import type { BezierPath, Transform2D, Vec2 } from '../../shared/models';
import { matrix, point } from '../../core/layers';
import { add, distance } from '../../core/path';

export interface PathHandle {
  id: string;
  field: 'point' | 'handleIn' | 'handleOut';
  point: Vec2;
}
/** Reusable overlay for any path instance: no notes, playback, PSD layers, or judgement. */
export class PathEditorOverlay {
  private handles: PathHandle[] = [];
  clear(): void {
    this.handles = [];
  }
  draw(
    g: Graphics,
    path: BezierPath,
    transform: Transform2D,
    selectedNodeId: string | null,
    pixelUnit: number,
  ): void {
    this.clear();
    const m = matrix(transform),
      size = 4.5 * pixelUnit;
    for (const node of path.nodes) {
      const pos = point(m, node.point);
      if (path.interpolation !== 'polyline')
        for (const field of ['handleIn', 'handleOut'] as const) {
          if (Math.hypot(node[field].x, node[field].y) < 1e-6) continue;
          const handle = point(m, add(node.point, node[field]));
          g.moveTo(pos.x, pos.y)
            .lineTo(handle.x, handle.y)
            .stroke({ color: 0xc8a5da, width: pixelUnit });
          g.circle(handle.x, handle.y, size)
            .fill(0x4e3c59)
            .stroke({ color: 0xe4c3f3, width: pixelUnit });
          this.handles.push({ id: node.id, field, point: handle });
        }
      g.rect(pos.x - size, pos.y - size, size * 2, size * 2)
        .fill(selectedNodeId === node.id ? 0xf3d398 : 0x87ced5)
        .stroke({ color: 0x15222b, width: pixelUnit });
      this.handles.push({ id: node.id, field: 'point', point: pos });
    }
  }
  hit(at: Vec2, radius: number): PathHandle | undefined {
    return [...this.handles].reverse().find((handle) => distance(handle.point, at) <= radius);
  }
}
