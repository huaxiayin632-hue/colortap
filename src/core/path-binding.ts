import type { Note, PathInstance, Project, Vec2 } from '../shared/models';
import { chartMapping } from './chart';
import { decompose, inverse, matrix, multiply, parents, type Affine } from './layers';
import { layerBounds, revealMatrix } from './layer-pose';

export type Slider = Extract<Note, { kind: 'slider' }>;
export type LayerPoses = Record<string, { scale: number; offset: Vec2 }>;
export const identityMatrix = (): Affine => ({ a: 1, b: 0, c: 0, d: 1, tx: 0, ty: 0 });
export function chartMatrix(project: Project): Affine {
  const m = chartMapping(project);
  return { a: m.scale, b: 0, c: 0, d: m.scale, tx: m.x, ty: m.y };
}
export function invertible(m: Affine): boolean {
  return Math.abs(m.a * m.d - m.b * m.c) >= 1e-12 && Object.values(m).every(Number.isFinite);
}

/** Shares precisely the layer hierarchy and local animation used by the artwork renderer. */
export class PathBindings {
  private parent: Map<string, string | null>;
  private bounds = new Map<string, ReturnType<typeof layerBounds>>();
  constructor(readonly project: Project) {
    this.parent = parents(project);
  }
  layersFor(notes: Iterable<Note>): Set<string> {
    const layers = new Set<string>();
    for (const note of notes) {
      if (note.kind !== 'slider' || !note.binding) continue;
      let id: string | null = note.binding.layerId;
      while (id && !layers.has(id)) {
        layers.add(id);
        id = this.parent.get(id) ?? null;
      }
    }
    return layers;
  }
  layerWorld(id: string, poses: LayerPoses = {}): Affine {
    const layer = this.project.layers[id];
    if (!layer) throw Error('贴合图层不存在');
    let local = matrix(layer.transform);
    if (poses[id]) {
      if (!this.bounds.has(id)) this.bounds.set(id, layerBounds(this.project, id));
      local = revealMatrix(local, this.bounds.get(id)!, poses[id]);
    }
    const parent = this.parent.get(id);
    return parent ? multiply(this.layerWorld(parent, poses), local) : local;
  }
  artworkDelta(note: Slider, poses: LayerPoses = {}): Affine {
    return note.binding
      ? multiply(
          this.layerWorld(note.binding.layerId, poses),
          inverse(matrix(note.binding.reference)),
        )
      : identityMatrix();
  }
  display(note: Note, camera: Affine, poses: LayerPoses = {}): Affine {
    if (note.kind !== 'slider' || !note.binding) return identityMatrix();
    const chart = chartMatrix(this.project);
    return multiply(
      inverse(chart),
      multiply(camera, multiply(this.artworkDelta(note, poses), chart)),
    );
  }
  artworkPath(note: Slider, poses: LayerPoses = {}): PathInstance {
    return {
      ...note.path,
      transform: decompose(
        multiply(
          this.artworkDelta(note, poses),
          multiply(chartMatrix(this.project), matrix(note.path.transform)),
        ),
      ),
    };
  }
  attach(note: Slider, layerId: string | null, camera: Affine, poses: LayerPoses = {}): Slider {
    const previous = this.display(note, camera, poses);
    const next = structuredClone(note);
    if (layerId) {
      const reference = this.layerWorld(layerId, poses);
      if (!invertible(reference)) throw Error('图层当前缩放为零，请定位到展开后的时刻再贴合');
      next.binding = { layerId, reference: decompose(reference) };
    } else delete next.binding;
    const target = this.display(next, camera, poses);
    if (!invertible(target)) throw Error('图层当前不可编辑，请先调整图层缩放');
    next.path.transform = decompose(
      multiply(inverse(target), multiply(previous, matrix(note.path.transform))),
    );
    return next;
  }
}
