import type { Layer, Project, Transform2D, Vec2 } from '../shared/models';

export type Affine = { a: number; b: number; c: number; d: number; tx: number; ty: number };
export const identityTransform = (): Transform2D => ({
  position: { x: 0, y: 0 },
  scale: { x: 1, y: 1 },
  rotationRad: 0,
  skewRad: { x: 0, y: 0 },
  pivot: { x: 0, y: 0 },
});
export function matrix(t: Transform2D): Affine {
  const a = Math.cos(t.rotationRad + t.skewRad.y) * t.scale.x;
  const b = Math.sin(t.rotationRad + t.skewRad.y) * t.scale.x;
  const c = -Math.sin(t.rotationRad - t.skewRad.x) * t.scale.y;
  const d = Math.cos(t.rotationRad - t.skewRad.x) * t.scale.y;
  return {
    a,
    b,
    c,
    d,
    tx: t.position.x - t.pivot.x * a - t.pivot.y * c,
    ty: t.position.y - t.pivot.x * b - t.pivot.y * d,
  };
}
export function multiply(p: Affine, q: Affine): Affine {
  return {
    a: p.a * q.a + p.c * q.b,
    b: p.b * q.a + p.d * q.b,
    c: p.a * q.c + p.c * q.d,
    d: p.b * q.c + p.d * q.d,
    tx: p.a * q.tx + p.c * q.ty + p.tx,
    ty: p.b * q.tx + p.d * q.ty + p.ty,
  };
}
export function inverse(m: Affine): Affine {
  const det = m.a * m.d - m.b * m.c;
  if (Math.abs(det) < 1e-14) throw new Error('该分组缩放为零，无法移动图层到其中');
  return {
    a: m.d / det,
    b: -m.b / det,
    c: -m.c / det,
    d: m.a / det,
    tx: (m.c * m.ty - m.d * m.tx) / det,
    ty: (m.b * m.tx - m.a * m.ty) / det,
  };
}
export function point(m: Affine, v: Vec2): Vec2 {
  return { x: m.a * v.x + m.c * v.y + m.tx, y: m.b * v.x + m.d * v.y + m.ty };
}
export function decompose(m: Affine): Transform2D {
  const rotationRad = Math.atan2(m.b, m.a),
    cos = Math.cos(rotationRad),
    sin = Math.sin(rotationRad);
  return {
    position: { x: m.tx, y: m.ty },
    scale: { x: Math.hypot(m.a, m.b), y: Math.hypot(m.c, m.d) },
    rotationRad,
    skewRad: { x: Math.atan2(cos * m.c + sin * m.d, -sin * m.c + cos * m.d), y: 0 },
    pivot: { x: 0, y: 0 },
  };
}
export function parents(project: Project): Map<string, string | null> {
  const result = new Map<string, string | null>();
  for (const id of project.rootLayersBottomToTop) result.set(id, null);
  for (const layer of Object.values(project.layers))
    if (layer.kind === 'group')
      for (const id of layer.childrenBottomToTop) result.set(id, layer.id);
  return result;
}
export function worldMatrix(project: Project, id: string | null): Affine {
  const parentMap = parents(project),
    chain: Layer[] = [];
  while (id) {
    const layer = project.layers[id];
    if (!layer) throw new Error('图层不存在');
    chain.push(layer);
    id = parentMap.get(id) ?? null;
  }
  return chain
    .reverse()
    .reduce((m, l) => multiply(m, matrix(l.transform)), matrix(identityTransform()));
}
export function isLocked(project: Project, id: string, includeSelf = true): boolean {
  const parentMap = parents(project);
  let current: string | null = includeSelf ? id : (parentMap.get(id) ?? null);
  while (current) {
    if (project.layers[current].locked) return true;
    current = parentMap.get(current) ?? null;
  }
  return false;
}
export function moveLayer(
  project: Project,
  id: string,
  parentId: string | null,
  index: number,
): void {
  const layer = project.layers[id];
  if (!layer) throw new Error('图层不存在');
  if (isLocked(project, id) || (parentId && isLocked(project, parentId)))
    throw new Error('请先解锁图层或所属分组');
  const parentMap = parents(project);
  for (let p = parentId; p; p = parentMap.get(p) ?? null)
    if (p === id) throw new Error('不能把分组放入自身或它的子分组');
  const target = parentId ? project.layers[parentId] : null;
  if (target && target.kind !== 'group') throw new Error('目标不是分组');
  const oldParent = parentMap.get(id) ?? null;
  const from = oldParent
    ? (project.layers[oldParent] as Extract<Layer, { kind: 'group' }>).childrenBottomToTop
    : project.rootLayersBottomToTop;
  const to = target?.kind === 'group' ? target.childrenBottomToTop : project.rootLayersBottomToTop;
  const original = from.indexOf(id);
  if (from !== to)
    layer.transform = decompose(
      multiply(inverse(worldMatrix(project, parentId)), worldMatrix(project, id)),
    );
  from.splice(original, 1);
  to.splice(
    Math.max(0, Math.min(to.length, index - (from === to && original < index ? 1 : 0))),
    0,
    id,
  );
}

export function deleteLayer(project: Project, id: string): void {
  if (!project.layers[id]) throw new Error('图层不存在');
  if (isLocked(project, id)) throw new Error('请先解锁图层或所属分组');
  const removed = new Set<string>(),
    pending = [id];
  while (pending.length) {
    const key = pending.pop()!,
      layer = project.layers[key];
    if (layer.locked) throw new Error('分组内有锁定图层，请先解锁后再删除');
    removed.add(key);
    if (layer.kind === 'group') pending.push(...layer.childrenBottomToTop);
  }
  const parentId = parents(project).get(id),
    parent = parentId ? project.layers[parentId] : null,
    siblings =
      parent?.kind === 'group' ? parent.childrenBottomToTop : project.rootLayersBottomToTop;
  siblings.splice(siblings.indexOf(id), 1);
  for (const key of removed) delete project.layers[key];
  const removedReveals = new Set<string>();
  for (const [key, reveal] of Object.entries(project.reveals))
    if (removed.has(reveal.layerId)) {
      removedReveals.add(key);
      delete project.reveals[key];
    }
  for (const [key, sound] of Object.entries(project.sounds))
    if ('revealId' in sound.trigger && removedReveals.has(sound.trigger.revealId))
      delete project.sounds[key];
  // Original image assets stay in the library. Removing a logical layer never destroys source pixels.
}
