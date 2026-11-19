import { Container, Graphics } from 'pixi.js';
import type { OutlineReveal, Vec2 } from '../../shared/models';
import { ArcPath } from '../../core/path';
import {
  orientedSamples,
  sliceSamples,
  type PathRange,
  type StrokeSample,
} from '../../core/outline';

/** Separate luminous vector object. Never used as a texture, PNG eraser or layer mask. */
export class PathVectorStroke {
  readonly root = new Container();
  private boundary = new Graphics();
  private tips = new Graphics();
  private samples: StrokeSample[];
  private chunks: { graphics: Graphics; start: number; end: number; samples: StrokeSample[] }[] =
    [];
  private ranges: PathRange[] = [];
  private endpoints: number[] = [];
  updates = 0;
  constructor(
    readonly arc: ArcPath,
    readonly reversed: boolean,
    readonly style: OutlineReveal['stroke'],
  ) {
    this.samples = orientedSamples(arc, reversed);
    for (let i = 0; i < this.samples.length - 1; i += 16) {
      const samples = this.samples.slice(i, Math.min(i + 17, this.samples.length)),
        graphics = new Graphics();
      this.stroke(
        graphics,
        samples.map((s) => s.point),
      );
      graphics.visible = false;
      this.chunks.push({
        graphics,
        start: samples[0].distance,
        end: samples.at(-1)!.distance,
        samples,
      });
      this.root.addChild(graphics);
    }
    this.root.addChild(this.boundary, this.tips);
  }
  private stroke(g: Graphics, points: Vec2[]): void {
    if (points.length < 2) return;
    const color = Number.parseInt(this.style.color.slice(1), 16),
      width = this.style.width,
      glow = this.style.glow,
      positions = points.flatMap((p) => [p.x, p.y]);
    if (glow > 0)
      for (const [spread, alpha] of [
        [5, 0.035],
        [2.5, 0.075],
        [1, 0.16],
      ])
        g.poly(positions, false).stroke({
          color,
          width: width * (1 + spread * glow),
          alpha: Math.min(0.6, alpha * Math.sqrt(glow)),
          cap: 'round',
          join: 'round',
        });
    g.poly(positions, false).stroke({ color, width, alpha: 1, cap: 'round', join: 'round' });
  }
  setRanges(ranges: PathRange[], tips: number[]): void {
    if (
      ranges.length === this.ranges.length &&
      tips.length === this.endpoints.length &&
      ranges.every((r, i) => r.from === this.ranges[i].from && r.to === this.ranges[i].to) &&
      tips.every((t, i) => t === this.endpoints[i])
    )
      return;
    this.ranges = ranges;
    this.endpoints = tips;
    this.updates++;
    this.boundary.clear();
    this.tips.clear();
    const actual = ranges.map((r) => ({
      from: r.from * this.arc.length,
      to: r.to * this.arc.length,
    }));
    for (const chunk of this.chunks) {
      const full = actual.some(
        (r) => r.from <= chunk.start + 1e-9 && r.to >= chunk.end - 1e-9 && r.to > r.from,
      );
      chunk.graphics.visible = full;
      if (full) continue;
      for (const range of actual) {
        const from = Math.max(range.from, chunk.start),
          to = Math.min(range.to, chunk.end);
        if (to > from) this.stroke(this.boundary, sliceSamples(chunk.samples, from, to));
      }
    }
    if (this.style.tips) {
      const color = Number.parseInt(this.style.color.slice(1), 16),
        glow = this.style.glow;
      for (const t of tips) {
        const p = this.arc.at(t, this.reversed),
          size = this.style.tipSize;
        if (glow > 0) {
          this.tips.circle(p.x, p.y, size * (1 + 2 * glow)).fill({ color, alpha: 0.06 });
          this.tips.circle(p.x, p.y, size * (1 + glow)).fill({ color, alpha: 0.14 });
        }
        this.tips.circle(p.x, p.y, size).fill({ color, alpha: 1 });
      }
    }
  }
  stats() {
    return { chunks: this.chunks.length, boundaryUpdates: this.updates };
  }
  dispose(): void {
    // Pixi 8 keeps GraphicsContext alive when an options object omits `context`.
    // These Graphics own their contexts; release them along with the visual children.
    this.root.destroy({ children: true, context: true });
  }
}
