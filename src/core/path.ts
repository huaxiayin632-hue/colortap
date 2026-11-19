import type { BezierPath, Transform2D, Vec2 } from '../shared/models';
import { identityTransform, matrix, point } from './layers';

export type PathNode = BezierPath['nodes'][number];
export const add = (a: Vec2, b: Vec2): Vec2 => ({ x: a.x + b.x, y: a.y + b.y });
export const subtract = (a: Vec2, b: Vec2): Vec2 => ({ x: a.x - b.x, y: a.y - b.y });
export const lerp = (a: Vec2, b: Vec2, t: number): Vec2 => ({
  x: a.x + (b.x - a.x) * t,
  y: a.y + (b.y - a.y) * t,
});
export const distance = (a: Vec2, b: Vec2): number => Math.hypot(a.x - b.x, a.y - b.y);
const clamp = (v: number, lo = 0, hi = 1) => Math.max(lo, Math.min(hi, v));
export function cubic(a: Vec2, b: Vec2, c: Vec2, d: Vec2, t: number): Vec2 {
  return lerp(lerp(lerp(a, b, t), lerp(b, c, t), t), lerp(lerp(b, c, t), lerp(c, d, t), t), t);
}
export interface PathSample {
  point: Vec2;
  distance: number;
  segment: number;
  t: number;
}

/** An immutable, renderer-independent arc-length table, in the requested coordinate space. */
export class ArcPath {
  readonly samples: PathSample[] = [];
  readonly length: number;
  constructor(
    readonly path: BezierPath,
    readonly transform: Transform2D = identityTransform(),
    tolerance = 0.04,
  ) {
    if (path.nodes.length < 2 || !(tolerance > 0)) throw new Error('路径至少需要两个节点');
    const m = matrix(transform);
    const emit = (p: Vec2, segment: number, t: number) => {
      const prev = this.samples.at(-1);
      this.samples.push({
        point: p,
        segment,
        t,
        distance: (prev?.distance ?? 0) + (prev ? distance(prev.point, p) : 0),
      });
    };
    const flatten = (
      a: Vec2,
      b: Vec2,
      c: Vec2,
      d: Vec2,
      segment: number,
      t0: number,
      t1: number,
      epsilon: number,
      depth: number,
    ) => {
      const polygon = distance(a, b) + distance(b, c) + distance(c, d);
      if (depth >= 18 || polygon - distance(a, d) <= epsilon) {
        emit(d, segment, t1);
        return;
      }
      const ab = lerp(a, b, 0.5),
        bc = lerp(b, c, 0.5),
        cd = lerp(c, d, 0.5);
      const abc = lerp(ab, bc, 0.5),
        bcd = lerp(bc, cd, 0.5),
        mid = lerp(abc, bcd, 0.5),
        tm = (t0 + t1) / 2;
      flatten(a, ab, abc, mid, segment, t0, tm, epsilon / 2, depth + 1);
      flatten(mid, bcd, cd, d, segment, tm, t1, epsilon / 2, depth + 1);
    };
    emit(point(m, path.nodes[0].point), 0, 0);
    const segments = path.closed ? path.nodes.length : path.nodes.length - 1;
    for (let i = 0; i < segments; i++) {
      const a = path.nodes[i],
        b = path.nodes[(i + 1) % path.nodes.length];
      if (path.interpolation === 'polyline') emit(point(m, b.point), i, 1);
      else
        flatten(
          point(m, a.point),
          point(m, add(a.point, a.handleOut)),
          point(m, add(b.point, b.handleIn)),
          point(m, b.point),
          i,
          0,
          1,
          tolerance,
          0,
        );
    }
    this.length = this.samples.at(-1)!.distance;
  }
  at(progress: number, reversed = false): Vec2 {
    const d = clamp(reversed ? 1 - progress : progress) * this.length;
    let low = 0,
      high = this.samples.length - 1;
    while (low < high) {
      const mid = (low + high) >>> 1;
      if (this.samples[mid].distance < d) low = mid + 1;
      else high = mid;
    }
    const b = this.samples[low],
      a = this.samples[Math.max(0, low - 1)];
    return lerp(
      a.point,
      b.point,
      b.distance > a.distance ? (d - a.distance) / (b.distance - a.distance) : 0,
    );
  }
  closest(p: Vec2): { point: Vec2; distance: number; segment: number; t: number } {
    let result = { point: this.samples[0].point, distance: Infinity, segment: 0, t: 0 };
    for (let i = 1; i < this.samples.length; i++) {
      const a = this.samples[i - 1],
        b = this.samples[i],
        delta = subtract(b.point, a.point),
        len2 = delta.x ** 2 + delta.y ** 2;
      const ratio = len2
        ? clamp(((p.x - a.point.x) * delta.x + (p.y - a.point.y) * delta.y) / len2)
        : 0;
      const at = lerp(a.point, b.point, ratio),
        d = distance(at, p);
      if (d < result.distance)
        result = {
          point: at,
          distance: d,
          segment: b.segment,
          t:
            (a.segment === b.segment ? a.t : 0) +
            (b.t - (a.segment === b.segment ? a.t : 0)) * ratio,
        };
    }
    return result;
  }
}
export function createNode(at: Vec2): PathNode {
  return {
    id: crypto.randomUUID(),
    point: { ...at },
    handleIn: { x: 0, y: 0 },
    handleOut: { x: 0, y: 0 },
    mode: 'corner',
  };
}
/** Default tangents for a new pen stroke. Explicitly dragged handles remain authoritative. */
export function smoothNodes(nodes: PathNode[], fixed?: ReadonlySet<string>): PathNode[] {
  return nodes.map((node, i) => {
    if (fixed?.has(node.id)) return node;
    const before = nodes[Math.max(0, i - 1)].point,
      after = nodes[Math.min(nodes.length - 1, i + 1)].point,
      delta = subtract(after, before),
      length = Math.hypot(delta.x, delta.y),
      reach =
        Math.min(
          i > 0 ? distance(before, node.point) : Infinity,
          i < nodes.length - 1 ? distance(after, node.point) : Infinity,
        ) / 3,
      ratio = length
        ? Math.min(1 / (i === 0 || i === nodes.length - 1 ? 3 : 6), reach / length)
        : 0,
      tangent = { x: delta.x * ratio, y: delta.y * ratio };
    return {
      ...node,
      mode: 'mirrored',
      handleOut: tangent,
      handleIn: { x: -tangent.x, y: -tangent.y },
    };
  });
}
/** De Casteljau subdivision preserves the curve exactly when inserting an anchor. */
export function insertNode(path: BezierPath, segment: number, t = 0.5): BezierPath {
  const next = structuredClone(path),
    a = next.nodes[segment],
    b = next.nodes[(segment + 1) % next.nodes.length];
  if (!a || !b || (!path.closed && segment >= path.nodes.length - 1))
    throw new Error('路径段不存在');
  t = clamp(t, 0.001, 0.999);
  const node = createNode(lerp(a.point, b.point, t));
  if (path.interpolation !== 'polyline') {
    const ab = lerp(a.point, add(a.point, a.handleOut), t),
      bc = lerp(add(a.point, a.handleOut), add(b.point, b.handleIn), t),
      cd = lerp(add(b.point, b.handleIn), b.point, t);
    const abc = lerp(ab, bc, t),
      bcd = lerp(bc, cd, t);
    node.point = lerp(abc, bcd, t);
    node.handleIn = subtract(abc, node.point);
    node.handleOut = subtract(bcd, node.point);
    a.handleOut = subtract(ab, a.point);
    b.handleIn = subtract(cd, b.point);
  }
  next.nodes.splice(segment + 1, 0, node);
  return next;
}
export function changeNode(
  path: BezierPath,
  nodeId: string,
  field: 'point' | 'handleIn' | 'handleOut',
  value: Vec2,
): BezierPath {
  const next = structuredClone(path),
    node = next.nodes.find((n) => n.id === nodeId);
  if (!node) throw new Error('节点不存在');
  node[field] = { ...value };
  if (field !== 'point' && node.mode !== 'corner') {
    const other = field === 'handleIn' ? 'handleOut' : 'handleIn',
      length =
        node.mode === 'mirrored'
          ? distance(value, { x: 0, y: 0 })
          : distance(node[other], { x: 0, y: 0 });
    const size = Math.hypot(value.x, value.y);
    node[other] =
      node.mode === 'mirrored'
        ? { x: -value.x, y: -value.y }
        : size
          ? { x: (-value.x * length) / size, y: (-value.y * length) / size }
          : { x: 0, y: 0 };
  }
  return next;
}
