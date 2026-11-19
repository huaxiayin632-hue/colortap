import { Container, Graphics } from 'pixi.js';
import type { ArcPath } from '../../core/path';
import {
  hitParticles,
  sliderParticles,
  type CircleAppearance,
  type SliderAppearance,
} from '../../core/note-visual';
import type { TrackInterval } from '../../core/judgement';
import type { Note, Vec2 } from '../../shared/models';
import { glowDot, glowLine, glowRing } from '../graphics/glow';

/** Owns display objects only. The caller supplies music-time states and a bounded particle budget. */
export class LuminousNote {
  readonly root = new Container();
  private readonly body = new Graphics();
  private readonly dot = new Graphics();
  private readonly particles = new Graphics();
  private width = -1;
  private lastParticleAge: number | null = null;
  private lastBudget = -1;
  private lastIntervals: readonly TrackInterval[] | undefined;
  particleCount = 0;
  perfectLit = false;
  phase = 'hidden';
  constructor(
    readonly note: Exclude<Note, { kind: 'hold' }>,
    readonly head: Vec2,
    readonly arc?: ArcPath,
  ) {
    this.root.addChild(this.body, this.dot, this.particles);
    this.particles.position.set(head.x, head.y);
  }
  private geometry(unit: number): void {
    const width = Math.max(0.65, unit * 1.1);
    if (Math.abs(width - this.width) < 0.0001) return;
    this.width = width;
    this.body.clear();
    this.dot.clear();
    if (this.note.kind === 'circle') {
      glowRing(this.body, this.note.radius, width);
      this.body.position.set(this.head.x, this.head.y);
      glowDot(this.dot, this.head.x, this.head.y, Math.max(2.5, this.note.radius * 0.2));
    } else {
      glowLine(
        this.body,
        this.arc!.samples.flatMap((s) => [s.point.x, s.point.y]),
        width,
      );
      glowRing(this.dot, Math.max(7, this.note.headRadius * 0.43), width * 0.8);
      glowDot(this.dot, 0, 0, Math.max(2.5, this.note.headRadius * 0.16));
    }
  }
  circle(state: CircleAppearance, unit: number, budget: number): void {
    this.phase = state.phase;
    this.root.visible = state.phase !== 'hidden';
    if (this.root.visible) this.geometry(unit);
    this.body.visible = state.alpha > 0 && state.scale > 0;
    this.body.scale.set(state.scale);
    this.body.alpha = state.alpha * state.glow;
    this.dot.visible = this.perfectLit = state.perfect;
    if (
      state.particleAgeUs === this.lastParticleAge &&
      (state.particleAgeUs === null || budget === this.lastBudget)
    )
      return;
    this.lastParticleAge = state.particleAgeUs;
    this.lastBudget = budget;
    this.particles.clear();
    this.particleCount = 0;
    if (state.particleAgeUs !== null && this.note.kind === 'circle') {
      for (const p of hitParticles(
        this.note.id,
        this.note.radius * state.burstScale,
        state.particleAgeUs,
      )) {
        if (this.particleCount >= budget) break;
        if (p.alpha <= 0.005) continue;
        glowDot(this.particles, p.x, p.y, p.radius, p.alpha);
        this.particleCount++;
      }
    }
  }
  slider(state: SliderAppearance, unit: number, budget: number): void {
    this.root.visible = state.visible;
    if (state.visible) this.geometry(unit);
    this.root.alpha = state.alpha;
    this.phase = !state.visible ? 'hidden' : state.tracking ? 'tracking' : 'waiting';
    this.body.alpha = 0.58 + 0.32 * state.glow;
    const pos = this.arc!.at(
      state.progress,
      this.note.kind === 'slider' && this.note.path.reversed,
    );
    this.dot.position.set(pos.x, pos.y);
    this.dot.alpha = state.dotAlpha;
    this.dot.scale.set(state.tracking ? 1.08 : 1);
    if (
      this.lastParticleAge === state.timeUs &&
      this.lastBudget === budget &&
      this.lastIntervals === state.intervals
    )
      return;
    this.lastParticleAge = state.timeUs;
    this.lastBudget = budget;
    this.lastIntervals = state.intervals;
    this.particles.clear();
    this.particles.position.set(0, 0);
    this.particleCount = 0;
    const reversed = this.note.kind === 'slider' && this.note.path.reversed;
    for (const p of sliderParticles(
      this.note.id,
      this.note.kind === 'slider' ? Math.max(7, this.note.headRadius * 0.43) : 7,
      state,
    )) {
      if (this.particleCount >= budget) break;
      if (p.alpha <= 0.005) continue;
      const origin = this.arc!.at(p.pathProgress, reversed);
      glowDot(this.particles, origin.x + p.x, origin.y + p.y, p.radius, p.alpha);
      this.particleCount++;
    }
  }
  dispose(): void {
    this.root.destroy({ children: true, context: true });
  }
}
