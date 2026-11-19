import { Container, Graphics } from 'pixi.js';
import { ArcPath, lerp } from '../../core/path';
import { clamp01 } from '../../core/reveal';

/** Static vector chunks + one small moving boundary. No bitmap, render texture or full-artboard redraw. */
export class PathVectorMask {
  readonly root = new Container();
  private readonly boundary = new Graphics();
  private readonly chunks: {
    graphics: Graphics;
    start: number;
    end: number;
    from: number;
    to: number;
  }[] = [];
  private samples: { point: { x: number; y: number }; distance: number }[];
  private previous = -1;
  boundaryUpdates = 0;
  constructor(
    readonly arc: ArcPath,
    readonly width: number,
    readonly reversed: boolean,
  ) {
    this.samples = reversed
      ? [...arc.samples]
          .reverse()
          .map((s) => ({ point: s.point, distance: arc.length - s.distance }))
      : arc.samples;
    const stride = 16;
    for (let i = 0; i < this.samples.length - 1; i += stride) {
      const end = Math.min(i + stride, this.samples.length - 1),
        graphics = new Graphics();
      graphics
        .poly(
          this.samples.slice(i, end + 1).flatMap((s) => [s.point.x, s.point.y]),
          false,
        )
        .stroke({ color: 0xffffff, width, cap: 'round', join: 'round' });
      graphics.visible = false;
      this.root.addChild(graphics);
      this.chunks.push({
        graphics,
        start: this.samples[i].distance,
        end: this.samples[end].distance,
        from: i,
        to: end,
      });
    }
    this.root.addChild(this.boundary);
  }
  setProgress(progress: number): void {
    const p = clamp01(progress);
    if (p === this.previous) return;
    this.previous = p;
    const distance = p * this.arc.length;
    this.boundary.clear();
    this.boundaryUpdates++;
    for (const c of this.chunks) {
      c.graphics.visible = p > 0 && c.end <= distance;
      if (p <= 0 || c.start >= distance || c.end <= distance) continue;
      const positions: number[] = [];
      for (let i = c.from; i <= c.to; i++) {
        const b = this.samples[i];
        if (b.distance <= distance) positions.push(b.point.x, b.point.y);
        else {
          const a = this.samples[i - 1],
            tip = lerp(
              a.point,
              b.point,
              (distance - a.distance) / Math.max(1e-10, b.distance - a.distance),
            );
          positions.push(tip.x, tip.y);
          break;
        }
      }
      if (positions.length >= 4)
        this.boundary
          .poly(positions, false)
          .stroke({ color: 0xffffff, width: this.width, cap: 'round', join: 'round' });
    }
    if (p > 0 && this.arc.length < 1e-8) {
      const a = this.samples[0].point;
      this.boundary.circle(a.x, a.y, this.width / 2).fill(0xffffff);
    }
  }
  stats() {
    return {
      chunks: this.chunks.length,
      boundaryUpdates: this.boundaryUpdates,
      samples: this.samples.length,
    };
  }
  dispose(): void {
    this.root.destroy({ children: true, context: true });
  }
}
