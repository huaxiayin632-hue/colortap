import type { Project, Rect, Vec2 } from '../shared/models';
import { matrix, multiply, point, type Affine } from './layers';

export function layerBounds(project: Project, id: string): Rect {
  const l = project.layers[id];
  if (l.kind !== 'group') return project.pixelSources[l.pixelSourceId].cropRect;
  const points: Vec2[] = [];
  for (const childId of l.childrenBottomToTop) {
    const r = layerBounds(project, childId),
      m = matrix(project.layers[childId].transform);
    points.push(
      ...[
        { x: r.x, y: r.y },
        { x: r.x + r.width, y: r.y },
        { x: r.x, y: r.y + r.height },
        { x: r.x + r.width, y: r.y + r.height },
      ].map((p) => point(m, p)),
    );
  }
  if (!points.length) return { x: 0, y: 0, width: 1, height: 1 };
  const x = Math.min(...points.map((p) => p.x)),
    y = Math.min(...points.map((p) => p.y));
  return {
    x,
    y,
    width: Math.max(1, Math.max(...points.map((p) => p.x)) - x),
    height: Math.max(1, Math.max(...points.map((p) => p.y)) - y),
  };
}

export function revealMatrix(
  base: Affine,
  bounds: Rect,
  state?: { scale: number; offset: Vec2 },
): Affine {
  if (!state) return base;
  const cx = bounds.x + bounds.width / 2,
    cy = bounds.y + bounds.height / 2,
    s = state.scale;
  const m = multiply(base, { a: s, b: 0, c: 0, d: s, tx: cx * (1 - s), ty: cy * (1 - s) });
  return { ...m, tx: m.tx + state.offset.x, ty: m.ty + state.offset.y };
}
