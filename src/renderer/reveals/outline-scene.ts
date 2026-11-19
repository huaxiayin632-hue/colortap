import { Container, Matrix } from 'pixi.js';
import { identityMatrix } from '../../core/path-binding';
import type { Project } from '../../shared/models';
import type { RevealState } from '../../core/reveal';
import { parents } from '../../core/layers';
import { PathVectorStroke } from './vector-stroke';
import { sameProjectParts } from '../../core/project';

/** Visual adapter only: PSD visibility and timed phase transitions are evaluated in core/reveal. */
export class OutlineScene {
  readonly root = new Container();
  private entries = new Map<string, PathVectorStroke>();
  private project: Project | null = null;
  private enabled = new Map<string, boolean>();
  draw(states: Record<string, RevealState>, project: Project): void {
    if (!sameProjectParts(this.project, project, ['layers', 'rootLayersBottomToTop'])) {
      this.project = project;
      this.enabled.clear();
      const parent = parents(project);
      const enabled = (id: string): boolean => {
        if (this.enabled.has(id)) return this.enabled.get(id)!;
        const layer = project.layers[id],
          p = parent.get(id);
        const value = layer.enabled && (!p || enabled(p));
        this.enabled.set(id, value);
        return value;
      };
      for (const id of Object.keys(project.layers)) enabled(id);
    }
    const used = new Set<string>();
    for (const state of Object.values(states)) {
      const o = state.outline;
      if (!o || !state.clipId) continue;
      const id = state.clipId;
      used.add(id);
      let entry = this.entries.get(id);
      if (
        !entry ||
        entry.arc !== o.arc ||
        entry.reversed !== o.reversed ||
        entry.style !== o.stroke
      ) {
        entry?.dispose();
        entry = new PathVectorStroke(o.arc, o.reversed, o.stroke);
        this.entries.set(id, entry);
        this.root.addChild(entry.root);
      }
      entry.root.visible = o.opacity > 0 && (this.enabled.get(state.layerId) ?? false);
      entry.root.alpha = o.opacity;
      const m = o.transform ?? identityMatrix();
      entry.root.setFromMatrix(new Matrix(m.a, m.b, m.c, m.d, m.tx, m.ty));
      entry.setRanges(o.ranges, o.tips);
    }
    for (const [id, entry] of this.entries)
      if (!used.has(id)) {
        entry.dispose();
        this.entries.delete(id);
      }
  }
  metrics() {
    return {
      objects: this.entries.size,
      visibleObjects: [...this.entries.values()].filter((e) => e.root.visible).length,
      chunks: [...this.entries.values()].reduce((n, e) => n + e.stats().chunks, 0),
      boundaryUpdates: [...this.entries.values()].reduce(
        (n, e) => n + e.stats().boundaryUpdates,
        0,
      ),
      bitmapBytes: 0,
    };
  }
  dispose(): void {
    this.root.destroy({ children: true, context: true });
    this.entries.clear();
  }
}
