import { APPROACH_US } from './chart';
import { circleGrade, type NoteResult, type TrackInterval } from './judgement';
import type { Project, Vec2 } from '../shared/models';

export const CIRCLE_COLLAPSE_US = 180_000;
export const HIT_PARTICLE_US = 440_000;
export const MISS_FADE_US = 180_000;
export const PARTICLES_PER_HIT = 12;
export const MAX_VISIBLE_PARTICLES = 192;
export const SLIDER_SPARK_US = 300_000;
export const SLIDER_SPARK_INTERVAL_US = 120_000;
const noTracking: readonly TrackInterval[] = [];
const clamp = (n: number) => Math.max(0, Math.min(1, n));
const smooth = (n: number) => n * n * (3 - 2 * n);
const approach = (at: number, start: number) => clamp((at - start + APPROACH_US) / APPROACH_US);
export const circleScale = (at: number, start: number) => 0.35 + 0.65 * approach(at, start);

export interface CircleAppearance {
  phase: 'hidden' | 'approach' | 'ready' | 'hit' | 'miss';
  scale: number;
  alpha: number;
  glow: number;
  particleAgeUs: number | null;
  burstScale: number;
  perfect: boolean;
}

/** Visual time only. Neither shrinking nor fading alters a gameplay radius or result. */
export function circleAppearance(
  at: number,
  start: number,
  hitUs: number | null,
  missUs: number,
  windows: Project['rules']['hitWindowsUs'],
  skipped = false,
): CircleAppearance {
  const hidden: CircleAppearance = {
    phase: 'hidden',
    scale: 0,
    alpha: 0,
    glow: 1,
    particleAgeUs: null,
    burstScale: 1,
    perfect: false,
  };
  if (hitUs !== null && at >= hitUs) {
    const age = at - hitUs;
    if (age >= HIT_PARTICLE_US) return hidden;
    const progress = clamp(age / CIRCLE_COLLAPSE_US),
      burstScale = circleScale(hitUs, start);
    return {
      phase: 'hit',
      scale: burstScale * (1 - progress) ** 1.7,
      alpha: 1 - progress,
      glow: 1.25,
      particleAgeUs: age,
      burstScale,
      perfect: false,
    };
  }
  if (skipped || at < start - APPROACH_US) return hidden;
  if (at > missUs) {
    const progress = clamp((at - missUs) / MISS_FADE_US);
    return {
      ...hidden,
      phase: progress < 1 ? 'miss' : 'hidden',
      scale: 1 - progress * 0.08,
      alpha: (1 - progress) * 0.55,
      glow: 0.45,
    };
  }
  const progress = approach(at, start);
  return {
    ...hidden,
    phase: at < start ? 'approach' : 'ready',
    scale: circleScale(at, start),
    alpha: smooth(clamp(progress * 4)),
    glow: 0.55 + 0.45 * progress,
    perfect: circleGrade(at - start, windows) === 'perfect',
  };
}

export interface SliderAppearance {
  timeUs: number;
  startUs: number;
  endUs: number;
  intervals: readonly TrackInterval[] | undefined;
  visible: boolean;
  progress: number;
  alpha: number;
  dotAlpha: number;
  glow: number;
  tracking: boolean;
}
export function sliderAppearance(
  at: number,
  start: number,
  end: number,
  playing: boolean,
  result: NoteResult | undefined,
  completeUs: number | null,
  failUs: number | null,
  intervals?: readonly TrackInterval[],
): SliderAppearance {
  const progress = clamp((at - start) / Math.max(1, end - start)),
    stop = completeUs ?? failUs ?? end,
    alpha = at < start ? smooth(clamp(approach(at, start) * 4)) : 1 - clamp((at - stop) / 220_000),
    tracking = at >= start && at <= end && (!playing || result?.valid === true),
    broken = playing && at > start && !tracking,
    skipped = playing && result?.status === 'skipped' && completeUs === null && failUs === null;
  return {
    timeUs: at,
    startUs: start,
    endUs: end,
    intervals: playing ? (intervals ?? result?.intervals ?? noTracking) : undefined,
    visible: !skipped && at >= start - APPROACH_US && alpha > 0,
    progress,
    alpha,
    dotAlpha: broken ? 0.36 : 1,
    glow: tracking ? 1.15 : broken ? 0.35 : 0.65 + approach(at, start) * 0.25,
    tracking,
  };
}

export interface HitParticle extends Vec2 {
  radius: number;
  alpha: number;
}
/** Fixed seeds and analytic movement make pauses, reverse seeks and replays reproducible. */
export function hitParticles(id: string, radius: number, ageUs: number): HitParticle[] {
  return burstParticles(id, radius, ageUs, HIT_PARTICLE_US, PARTICLES_PER_HIT);
}
function burstParticles(
  id: string,
  radius: number,
  ageUs: number,
  lifeUs: number,
  count: number,
): HitParticle[] {
  if (ageUs <= 0 || ageUs >= lifeUs) return [];
  let seed = 2166136261;
  for (let i = 0; i < id.length; i++) seed = Math.imul(seed ^ id.charCodeAt(i), 16777619);
  const random = () => {
    seed = Math.imul(seed ^ (seed >>> 16), 2246822507);
    seed = Math.imul(seed ^ (seed >>> 13), 3266489909);
    return ((seed ^ (seed >>> 16)) >>> 0) / 4294967296;
  };
  return Array.from({ length: count }, (_, i) => {
    const angle = ((i + random() * 0.65) * Math.PI * 2) / count,
      life = lifeUs * (0.72 + random() * 0.28),
      progress = clamp(ageUs / life),
      travel = radius * (0.78 + random() * 0.2) + (18 + random() * 58) * (ageUs / 1e6),
      size = 0.65 + random() * 1.7;
    return {
      x: Math.cos(angle) * travel,
      y: Math.sin(angle) * travel,
      radius: size * (1 - progress * 0.4),
      alpha: clamp(ageUs / 18000) * (1 - progress) ** 1.6 * 0.9,
    };
  });
}

/** Only recent emissions are queried; released or missed intervals never emit. */
export function sliderParticles(
  id: string,
  radius: number,
  state: SliderAppearance,
): (HitParticle & { pathProgress: number })[] {
  if (!state.visible) return [];
  const particles: (HitParticle & { pathProgress: number })[] = [],
    first = Math.max(
      0,
      Math.ceil((state.timeUs - state.startUs - SLIDER_SPARK_US) / SLIDER_SPARK_INTERVAL_US),
    ),
    last = Math.floor(
      (Math.min(state.timeUs, state.endUs) - state.startUs) / SLIDER_SPARK_INTERVAL_US,
    );
  for (let i = first; i <= last; i++) {
    const emitted = state.startUs + i * SLIDER_SPARK_INTERVAL_US;
    if (emitted >= state.endUs) continue;
    if (state.intervals) {
      let low = 0,
        high = state.intervals.length;
      while (low < high) {
        const mid = (low + high) >>> 1;
        if (state.intervals[mid].startUs <= emitted) low = mid + 1;
        else high = mid;
      }
      const interval = state.intervals[low - 1];
      if (!interval?.valid || emitted >= interval.endUs) continue;
    }
    for (const particle of burstParticles(
      `${id}:${i}`,
      radius,
      state.timeUs - emitted,
      SLIDER_SPARK_US,
      3,
    ))
      particles.push({
        ...particle,
        pathProgress: (emitted - state.startUs) / Math.max(1, state.endUs - state.startUs),
      });
  }
  return particles;
}
