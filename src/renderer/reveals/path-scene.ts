import { Container, Graphics } from 'pixi.js';
import { ArcPath } from '../../core/path';
import type { Vec2 } from '../../shared/models';
import { equalData } from '../../core/project';
import { PathEditorOverlay, type PathHandle } from '../paths/path-editor';
import type { RevealController } from './controller';

/** Artwork-space authoring adapter, using exactly the same handles and core geometry as Slider. */
export class RevealPathScene {
  readonly root = new Container();
  private graphics = new Graphics();
  private overlay = new PathEditorOverlay();
  private gesture: PathHandle | null = null;
  private arc: ArcPath | null = null;
  constructor(
    readonly controller: RevealController,
    private zoom: () => number,
  ) {
    this.root.addChild(this.graphics);
  }
  active(): boolean {
    return this.controller.pathEditing.value;
  }
  draw(): void {
    const c = this.controller,
      g = this.graphics;
    g.clear();
    this.overlay.clear();
    this.root.visible = this.active();
    if (!this.active()) return;
    const unit = 1 / this.zoom(),
      p = c.path.value,
      use = c.pathUse.value;
    if (p && use && !c.drawing.value) {
      if (!this.arc || this.arc.path !== p || !equalData(this.arc.transform, use.transform)) {
        this.arc = new ArcPath(p, use.transform, 0.5);
      }
      const arc = this.arc;
      g.poly(
        arc.samples.flatMap((s) => [s.point.x, s.point.y]),
        false,
      ).stroke({ color: 0xf3b875, width: 3 * unit, cap: 'round', join: 'round' });
      const effect = c.selected.value?.effect;
      if (effect?.kind === 'outline') {
        const start =
          effect.drawing.mode === 'single' && !p.closed
            ? use.reversed
              ? 1
              : 0
            : effect.drawing.start;
        const at = arc.at(start);
        g.circle(at.x, at.y, 8 * unit).stroke({ color: 0xa3f4c1, width: 2 * unit });
      }
      this.overlay.draw(g, p, use.transform, c.nodeId.value, unit);
    }
    const points = [...c.draftPoints.value, ...(c.hover.value ? [c.hover.value] : [])];
    if (c.drawing.value && points.length >= 2)
      g.poly(
        points.flatMap((p) => [p.x, p.y]),
        false,
      ).stroke({ color: 0xf3b875, width: 3 * unit, cap: 'round', join: 'round' });
    if (c.drawing.value)
      for (const p of c.draftPoints.value) g.circle(p.x, p.y, 4 * unit).fill(0xf3b875);
  }
  down(at: Vec2): void {
    const c = this.controller;
    if (c.drawing.value) {
      c.appendPoint(at);
      return;
    }
    const handle = this.overlay.hit(at, 9 / this.zoom());
    if (handle) {
      this.gesture = handle;
      c.nodeId.value = handle.id;
    }
  }
  move(at: Vec2): void {
    this.controller.hover.value = at;
    if (this.gesture && this.active())
      this.controller.moveNode(this.gesture.id, this.gesture.field, at, false);
  }
  up(at: Vec2, cancelled: boolean): void {
    if (this.gesture) {
      if (!cancelled && this.active())
        this.controller.moveNode(this.gesture.id, this.gesture.field, at, true);
      else this.controller.cancel();
    }
    this.gesture = null;
  }
  doubleClick(at: Vec2): void {
    if (this.controller.drawing.value) this.controller.finishDrawing();
    else this.controller.addNode(at);
  }
  dispose(): void {
    this.root.destroy({ children: true, context: true });
  }
}
