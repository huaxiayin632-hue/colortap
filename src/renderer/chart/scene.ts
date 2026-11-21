import { Container, Graphics, Text, Matrix } from 'pixi.js';
import {
  decompose,
  identityTransform,
  inverse,
  matrix,
  multiply,
  point,
  type Affine,
} from '../../core/layers';
import { identityMatrix, invertible } from '../../core/path-binding';
import { APPROACH_US, chartMapping, endUs } from '../../core/chart';
import { ArcPath, distance, subtract } from '../../core/path';
import type { Note, Project, Vec2 } from '../../shared/models';
import type { ChartController } from './controller';
import { PathEditorOverlay } from '../paths/path-editor';
import { circleAppearance, sliderAppearance, MAX_VISIBLE_PARTICLES } from '../../core/note-visual';
import { LuminousNote } from './note-visual';
import { glowLine } from '../graphics/glow';

interface VisualNote {
  note: Note;
  root: Container;
  ring: Graphics;
  ball: Graphics;
  follow: Graphics;
  label: Text;
  luminous?: LuminousNote;
  head: Vec2;
  arc?: ArcPath;
  start: number;
  end: number;
  display: Affine;
}
type Gesture =
  | { kind: 'move'; start: Vec2 }
  | { kind: 'node'; id: string; field: 'point' | 'handleIn' | 'handleOut' }
  | { kind: 'slider'; start: Vec2; id: string }
  | { kind: 'draft-node'; id: string; field: 'point' | 'handleIn' | 'handleOut' }
  | { kind: 'box'; start: Vec2; additive: boolean };

/** Rendering/input adapter only. Path tables and judgement never depend on these display objects. */
export class ChartScene {
  readonly root = new Container();
  private readonly shade = new Graphics();
  private readonly frame = new Graphics();
  private readonly notesRoot = new Container();
  private readonly controls = new Graphics();
  private readonly cursor = new Graphics();
  private visuals = new Map<string, VisualNote>();
  private notes: Project['notes'] | null = null;
  private paths: Project['paths'] | null = null;
  private timing: Project['timing'] | null = null;
  private gesture: Gesture | null = null;
  private gestureEpoch = 0;
  private readonly pathEditor = new PathEditorOverlay();
  constructor(
    readonly chart: ChartController,
    private readonly screenScale: () => number,
  ) {
    this.root.addChild(this.shade, this.frame, this.notesRoot, this.controls, this.cursor);
  }
  toChart(world: Vec2): Vec2 {
    const m = chartMapping(this.chart.document.value);
    return { x: (world.x - m.x) / m.scale, y: (world.y - m.y) / m.scale };
  }
  private inside(at: Vec2): boolean {
    const size = this.chart.document.value.stage.chartSize;
    return at.x >= 0 && at.y >= 0 && at.x <= size.width && at.y <= size.height;
  }
  private rebuild(): void {
    const p = this.chart.document.value;
    if (p.notes === this.notes && p.paths === this.paths && p.timing === this.timing) return;
    this.notes = p.notes;
    this.paths = p.paths;
    this.timing = p.timing;
    this.notesRoot.removeChildren().forEach((c) => c.destroy({ children: true, context: true }));
    this.visuals.clear();
    const notes = Object.values(p.notes).sort(
      (a, b) => this.chart.tempo.value.resolve(a.at) - this.chart.tempo.value.resolve(b.at),
    );
    notes.forEach((note, index) => {
      const root = new Container(),
        base = new Graphics(),
        ring = new Graphics(),
        ball = new Graphics(),
        follow = new Graphics();
      const arc =
        note.kind === 'slider'
          ? new ArcPath(p.paths[note.path.pathId], note.path.transform)
          : undefined;
      const head = note.kind !== 'slider' ? note.position : arc!.at(0, note.path.reversed),
        radius = note.kind !== 'slider' ? note.radius : note.headRadius;
      const color = note.kind === 'circle' ? 0xe9b76f : note.kind === 'hold' ? 0xc2a4e8 : 0x67c0ce;
      const luminous = note.kind === 'hold' ? undefined : new LuminousNote(note, head, arc);
      if (note.kind === 'hold') {
        base
          .circle(head.x, head.y, radius)
          .fill({ color: 0x17252e, alpha: 0.94 })
          .stroke({ color, width: 3 });
        base.circle(head.x, head.y, radius - 5).stroke({ color, width: 1.5 });
      }
      const label = new Text({
        text: note.kind === 'hold' ? `H${index + 1}` : String(index + 1),
        style: { fontFamily: 'Segoe UI', fontSize: Math.max(12, radius * 0.8), fill: 0xf1f5f7 },
      });
      label.anchor.set(0.5);
      label.position.set(head.x, head.y);
      root.addChild(base);
      if (luminous) root.addChild(luminous.root);
      root.addChild(ring, follow, ball, label);
      this.notesRoot.addChildAt(root, 0);
      this.visuals.set(note.id, {
        note,
        root,
        ring,
        ball,
        follow,
        label,
        luminous,
        arc,
        head,
        start: this.chart.tempo.value.resolve(note.at),
        end: endUs(note, this.chart.tempo.value),
        display: identityMatrix(),
      });
    });
  }
  draw(): void {
    const chart = this.chart,
      p = chart.document.value,
      mode = chart.mode.value,
      at = chart.timeUs.value;
    this.root.visible = mode !== 'edit' || chart.tool.value !== 'layers';
    if (!this.root.visible) return;
    const mapping = chartMapping(p);
    this.root.position.set(mapping.x, mapping.y);
    this.root.scale.set(mapping.scale);
    this.rebuild();
    const lineWidth = 1 / Math.max(1e-8, this.screenScale() * mapping.scale);
    this.shade.clear();
    this.frame.clear();
    // Performance artwork keeps its source colors. The older chart-only view
    // still dims the background to emphasize note timing.
    if (mode !== 'edit' && !Object.keys(p.reveals).length)
      this.shade
        .rect(0, 0, p.stage.chartSize.width, p.stage.chartSize.height)
        .fill({ color: 0x101820, alpha: 0.45 });
    if (mode === 'edit')
      this.frame
        .rect(0, 0, p.stage.chartSize.width, p.stage.chartSize.height)
        .stroke({ color: 0x82c9d1, width: lineWidth, alpha: 0.35 });
    let particleBudget = MAX_VISIBLE_PARTICLES;
    const displays = chart.displayMatrices();
    for (const [id, v] of this.visuals) {
      const display = displays[id] ?? identityMatrix();
      if (!invertible(display)) {
        v.display = display;
        v.root.visible = false;
        continue;
      }
      if (
        Object.keys(display).some(
          (k) => display[k as keyof Affine] !== v.display[k as keyof Affine],
        )
      )
        v.root.setFromMatrix(
          new Matrix(display.a, display.b, display.c, display.d, display.tx, display.ty),
        );
      v.display = display;
      const selected = chart.selected.value.includes(id),
        result = chart.runtime.value?.results[id];
      const visibleTime =
        at >= v.start - APPROACH_US && at <= v.end + (mode === 'edit' ? 300000 : 200000);
      const radius = v.note.kind !== 'slider' ? v.note.radius : v.note.headRadius;
      const guide = mode === 'edit' && selected;
      v.label.visible = v.note.kind === 'hold' || guide;
      if (v.note.kind === 'circle' && v.luminous) {
        const hit = mode === 'playtest' ? chart.take.eventTime(id, 'circle-hit') : v.start,
          miss = chart.take.eventTime(id, 'circle-miss') ?? v.start + p.rules.hitWindowsUs.good;
        let state = circleAppearance(
          at,
          v.start,
          hit,
          miss,
          p.rules.hitWindowsUs,
          result?.status === 'skipped',
        );
        const ghost = state.phase === 'hidden' && guide;
        if (ghost)
          state = {
            ...circleAppearance(
              v.start,
              v.start,
              null,
              v.start + p.rules.hitWindowsUs.good,
              p.rules.hitWindowsUs,
            ),
            perfect: false,
          };
        v.luminous.circle(state, lineWidth, particleBudget);
        particleBudget -= v.luminous.particleCount;
        v.root.visible = state.phase !== 'hidden';
        v.root.alpha = ghost ? 0.35 : 1;
      } else if (v.note.kind === 'slider' && v.luminous) {
        let state = sliderAppearance(
          at,
          v.start,
          v.end,
          mode === 'playtest',
          result,
          mode === 'playtest' ? chart.take.eventTime(id, 'slider-complete') : v.end,
          mode === 'playtest' ? chart.take.eventTime(id, 'slider-fail') : null,
          mode === 'playtest' ? chart.take.tracks.get(id) : undefined,
        );
        const ghost = !state.visible && guide;
        if (ghost) state = sliderAppearance(v.start, v.start, v.end, false, undefined, null, null);
        v.luminous.slider(state, lineWidth, particleBudget);
        particleBudget -= v.luminous.particleCount;
        v.root.visible = state.visible;
        v.root.alpha = ghost ? 0.35 : 1;
      } else {
        v.root.visible =
          (visibleTime || guide) && !(mode === 'playtest' && result?.status === 'skipped');
        v.root.alpha = mode === 'edit' && !visibleTime ? 0.45 : 1;
      }
      if (!v.root.visible) continue;
      v.ring.clear();
      v.ball.clear();
      v.follow.clear();
      if (selected && mode === 'edit')
        v.ring
          .circle(v.head.x, v.head.y, radius + 4)
          .stroke({ color: 0xffffff, width: 1.5 * lineWidth });
      if (v.note.kind === 'hold' && at <= v.start && at >= v.start - APPROACH_US)
        v.ring
          .circle(v.head.x, v.head.y, radius * (1 + (2.3 * (v.start - at)) / APPROACH_US))
          .stroke({ color: 0xe1ebf0, width: 2 * lineWidth, alpha: 0.75 });
      if (v.note.kind === 'slider' && v.arc && guide && at >= v.start && at <= v.end) {
        const progress = (at - v.start) / Math.max(1, v.end - v.start),
          pos = v.arc.at(progress, v.note.path.reversed);
        v.follow.circle(pos.x, pos.y, v.note.followRadius).stroke({
          color: result?.valid ? 0xa4dfb4 : 0xabc4d0,
          width: 1.5 * lineWidth,
          alpha: 0.8,
        });
      }
      if (v.note.kind === 'hold' && at >= v.start && at <= v.end) {
        const progress = (at - v.start) / Math.max(1, v.end - v.start);
        v.follow.circle(v.head.x, v.head.y, radius + 8).stroke({ color: 0x7d6a96, width: 4 });
        if (progress > 0)
          v.ball
            .arc(
              v.head.x,
              v.head.y,
              radius + 8,
              -Math.PI / 2,
              -Math.PI / 2 + progress * Math.PI * 2,
            )
            .stroke({
              color: mode === 'playtest' && result?.valid === false ? 0xeaaca5 : 0xe3c9ff,
              width: 4,
            });
      }
    }
    this.drawControls(lineWidth);
    this.cursor.clear();
    if (mode === 'playtest' && chart.pointer.value) {
      const pos = chart.pointer.value;
      this.cursor
        .circle(pos.x, pos.y, 1.6)
        .fill({ color: 0xffffff, alpha: 0.75 })
        .circle(pos.x, pos.y, 5)
        .stroke({ color: 0xe5d7ff, width: lineWidth, alpha: 0.45 });
    }
  }
  private drawControls(lineWidth: number): void {
    const c = this.chart,
      g = this.controls;
    g.clear();
    this.pathEditor.clear();
    if (c.mode.value !== 'edit') return;
    const note = c.selectedNote.value,
      path = c.selectedPath.value;
    if (c.tool.value === 'path' && note?.kind === 'slider' && path) {
      const display = c.displayMatrix(note);
      if (invertible(display))
        this.pathEditor.draw(
          g,
          path,
          decompose(multiply(display, matrix(note.path.transform))),
          c.nodeId.value,
          lineWidth,
        );
    }
    const draft = c.sliderDraft.value,
      preview = c.sliderPreview.value;
    if (draft && preview) {
      if (preview.nodes.length >= 2)
        glowLine(
          g,
          new ArcPath(preview).samples.flatMap((s) => [s.point.x, s.point.y]),
          Math.max(0.65, lineWidth * 1.1),
        );
      this.pathEditor.draw(
        g,
        { ...preview, nodes: preview.nodes.slice(0, draft.nodes.length) },
        identityTransform(),
        draft.nodes.at(-1)!.id,
        lineWidth,
      );
    }
    const box = c.selectionBox.value;
    if (box)
      g.rect(
        Math.min(box.start.x, box.end.x),
        Math.min(box.start.y, box.end.y),
        Math.abs(box.start.x - box.end.x),
        Math.abs(box.start.y - box.end.y),
      )
        .fill({ color: 0x82c9d1, alpha: 0.1 })
        .stroke({ color: 0x82c9d1, width: lineWidth });
  }
  private hit(at: Vec2): string | null {
    for (const [id, v] of this.visuals) {
      if (!v.root.visible || !invertible(v.display)) continue;
      const local = point(inverse(v.display), at);
      if (
        v.note.kind !== 'slider'
          ? distance(v.head, local) <= v.note.radius
          : v.arc!.closest(local).distance <= v.note.headRadius
      )
        return id;
    }
    return null;
  }
  contextTarget(world: Vec2): string | null {
    const at = this.toChart(world),
      c = this.chart;
    if (c.tool.value === 'path') {
      const control = this.pathEditor.hit(
        at,
        9 / Math.max(1e-8, this.screenScale() * chartMapping(c.document.value).scale),
      );
      if (control && c.selectedNote.value) {
        c.nodeId.value = control.id;
        c.claimSelection();
        return c.selectedNote.value.id;
      }
    }
    return this.hit(at);
  }
  down(world: Vec2, shift: boolean): void {
    const at = this.toChart(world),
      c = this.chart;
    this.gestureEpoch = c.gestureEpoch.value;
    c.setPointer(this.pointerInside(world, at) ? at : null);
    if (c.mode.value === 'playtest') {
      c.input('mouse', true);
      return;
    }
    if (c.mode.value !== 'edit') return;
    if (c.tool.value === 'path' || (c.tool.value === 'slider' && c.sliderDraft.value)) {
      const threshold =
        9 / Math.max(1e-8, this.screenScale() * chartMapping(c.document.value).scale);
      const control = this.pathEditor.hit(at, threshold);
      if (control) {
        c.claimSelection();
        c.nodeId.value = control.id;
        c.sliderCursor.value = null;
        this.gesture = {
          kind: c.tool.value === 'slider' ? 'draft-node' : 'node',
          id: control.id,
          field: control.field,
        };
        return;
      }
    }
    if (!this.inside(at) && ['circle', 'hold', 'slider'].includes(c.tool.value)) return;
    if (c.tool.value === 'path' && c.appendMode.value) {
      c.appendNode(at);
      return;
    }
    if (c.tool.value === 'circle') {
      c.addCircle(at);
      return;
    }
    if (c.tool.value === 'hold') {
      c.addHold(at);
      return;
    }
    if (c.tool.value === 'slider') {
      const id = c.addSliderPoint(at);
      if (id) this.gesture = { kind: 'slider', start: at, id };
      return;
    }
    const hit = this.hit(at);
    if (hit) {
      if (shift) c.select(hit, true);
      else if (!c.selected.value.includes(hit)) c.select(hit);
      if (c.selected.value.includes(hit)) c.claimSelection();
      if (c.selected.value.includes(hit)) this.gesture = { kind: 'move', start: at };
    } else {
      this.gesture = { kind: 'box', start: at, additive: shift };
      c.selectionBox.value = { start: at, end: at };
    }
  }
  move(world: Vec2): void {
    const at = this.toChart(world),
      c = this.chart;
    c.setPointer(this.pointerInside(world, at) ? at : null);
    const gesture = this.gesture;
    if (this.gestureEpoch !== c.gestureEpoch.value) {
      this.gesture = null;
      return;
    }
    if (c.mode.value !== 'edit') return;
    if (!gesture && c.tool.value === 'slider' && c.sliderDraft.value) c.sliderCursor.value = at;
    if (!gesture) return;
    if (gesture.kind === 'move') c.moveSelected(subtract(at, gesture.start), false);
    if (gesture.kind === 'node') c.moveNode(gesture.id, gesture.field, at, false);
    if (gesture.kind === 'draft-node') c.moveDraftNode(gesture.id, gesture.field, at);
    if (
      gesture.kind === 'slider' &&
      distance(at, gesture.start) * this.screenScale() * chartMapping(c.document.value).scale >= 3
    )
      c.moveDraftNode(gesture.id, 'handleOut', at);
    if (gesture.kind === 'box') c.selectionBox.value = { start: gesture.start, end: at };
  }
  up(world: Vec2, cancelled = false): void {
    const at = this.toChart(world),
      c = this.chart;
    c.input('mouse', false);
    const gesture = this.gesture;
    this.gesture = null;
    if (!gesture) return;
    if (this.gestureEpoch !== c.gestureEpoch.value) return;
    if (cancelled || c.mode.value !== 'edit') {
      c.cancelGesture();
      return;
    }
    if (gesture.kind === 'move') c.moveSelected(subtract(at, gesture.start), true);
    if (gesture.kind === 'node') c.moveNode(gesture.id, gesture.field, at, true);
    if (gesture.kind === 'draft-node') c.moveDraftNode(gesture.id, gesture.field, at);
    if (gesture.kind === 'slider') {
      if (
        distance(at, gesture.start) * this.screenScale() * chartMapping(c.document.value).scale >=
        3
      )
        c.moveDraftNode(gesture.id, 'handleOut', at);
    }
    if (gesture.kind === 'box') {
      const minX = Math.min(at.x, gesture.start.x),
        maxX = Math.max(at.x, gesture.start.x),
        minY = Math.min(at.y, gesture.start.y),
        maxY = Math.max(at.y, gesture.start.y);
      const inside = (p: Vec2) => p.x >= minX && p.x <= maxX && p.y >= minY && p.y <= maxY;
      c.choose(
        [...this.visuals]
          .filter(
            ([, v]) =>
              v.root.visible &&
              (inside(point(v.display, v.head)) ||
                v.arc?.samples.some((s) => inside(point(v.display, s.point)))),
          )
          .map(([id]) => id),
        gesture.additive,
      );
      c.selectionBox.value = null;
    }
  }
  doubleClick(world: Vec2): void {
    if (this.chart.mode.value === 'edit' && this.chart.tool.value === 'slider') {
      this.chart.finishSlider();
      return;
    }
    if (this.chart.appendMode.value) return;
    if (
      this.chart.mode.value === 'edit' &&
      this.chart.tool.value === 'path' &&
      this.chart.selectedPath.value
    )
      this.chart.addNode(this.toChart(world));
  }
  metrics() {
    return {
      visibleNotes: this.root.visible
        ? [...this.visuals].filter(([, v]) => v.root.visible).length
        : 0,
      selected: [...this.chart.selected.value],
      particles: [...this.visuals.values()].reduce(
        (sum, v) => sum + (v.root.visible ? (v.luminous?.particleCount ?? 0) : 0),
        0,
      ),
      appearances: [...this.visuals]
        .filter(([, v]) => v.root.visible && v.luminous)
        .map(([id, v]) => ({
          id,
          phase: v.luminous!.phase,
          perfect: v.luminous!.perfectLit,
          particles: v.luminous!.particleCount,
        })),
      mapping: chartMapping(this.chart.document.value),
      boundNotes: [...this.visuals.values()]
        .filter((v) => v.note.kind === 'slider' && v.note.binding)
        .map((v) => ({ id: v.note.id, matrix: v.display, head: point(v.display, v.head) })),
    };
  }
  private pointerInside(world: Vec2, at: Vec2): boolean {
    const p = this.chart.document.value;
    const bound = Object.values(p.notes).some((n) => n.kind === 'slider' && n.binding);
    return bound
      ? world.x >= 0 &&
          world.y >= 0 &&
          world.x <= p.stage.artworkSize.width &&
          world.y <= p.stage.artworkSize.height
      : this.inside(at);
  }
  dispose(): void {
    this.root.destroy({ children: true, context: true });
    this.visuals.clear();
  }
}
