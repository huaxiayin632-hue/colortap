import type {
  BezierPath,
  PathInstance,
  Project,
  Rect,
  RevealClip,
  RevealEffect,
  OutlineReveal,
  Vec2,
} from '../shared/models';
import type { PlaybackTake } from './playback';
export { PlaybackTake as RevealTake } from './playback';
import { chartMapping, endUs, nominalTriggerTime, spanUs } from './chart';
import { decompose, matrix, multiply, type Affine } from './layers';
import { ArcPath } from './path';
import { TempoMap } from './timing';
import { outlineRanges, type DrawRanges } from './outline';
import { easeProgress, outlineDrawProgress, outlineThresholdProgress } from './easing';
import { fanSector } from './fan';
import { layerBounds } from './layer-pose';
import { PathBindings, type LayerPoses } from './path-binding';
export { easeProgress } from './easing';

export const clamp01 = (n: number) => Math.max(0, Math.min(1, n));
export const effectLabels: Record<RevealEffect['kind'], string> = {
  instant: 'Instant · 瞬间',
  fade: 'Fade · 淡入',
  'slide-in': 'Slide In · 滑入',
  pop: 'Pop · 弹出',
  directional: 'Directional · 方向显现',
  fan: 'Fan · 扇形展开 / 收拢',
  path: 'Path Reveal · 路径显现',
  outline: 'Outline Draw → Layer Reveal · 描边后整层显现',
};
export function nominalClipRange(
  project: Project,
  clip: RevealClip,
  tempo = new TempoMap(project.timing),
) {
  const start = nominalTriggerTime(project, clip.trigger, tempo) + (clip.delayUs ?? 0);
  const duration =
    clip.progress.kind === 'elapsed'
      ? spanUs(clip.progress.duration, { basis: 'time', timeUs: start }, tempo)
      : Math.max(0, endUs(project.notes[clip.progress.noteId], tempo) - start);
  return { start, end: start + duration, duration };
}

export function resolveRevealPath(
  project: Project,
  effect: Extract<RevealEffect, { kind: 'path' | 'outline' }>,
  poses: LayerPoses = {},
  applyBinding = true,
): PathInstance {
  if (!effect.linkedSliderId) return effect.path;
  const slider = project.notes[effect.linkedSliderId];
  if (slider?.kind !== 'slider') return effect.path;
  if (slider.binding && applyBinding) return new PathBindings(project).artworkPath(slider, poses);
  const map = chartMapping(project),
    m: Affine = { a: map.scale, b: 0, c: 0, d: map.scale, tx: map.x, ty: map.y };
  return { ...slider.path, transform: decompose(multiply(m, matrix(slider.path.transform))) };
}
export function hasRevealPath(
  effect: RevealEffect,
): effect is Extract<RevealEffect, { kind: 'path' | 'outline' }> {
  return effect.kind === 'path' || effect.kind === 'outline';
}

export function outlineStages(
  project: Project,
  clip: RevealClip,
  tempo = new TempoMap(project.timing),
) {
  const draw = nominalClipRange(project, clip, tempo);
  if (clip.effect.kind !== 'outline') return null;
  const e = clip.effect;
  const origin =
    clip.progress.kind === 'elapsed'
      ? draw.start
      : tempo.resolve(project.notes[clip.progress.noteId].at);
  const duration =
    clip.progress.kind === 'elapsed'
      ? draw.duration
      : endUs(project.notes[clip.progress.noteId], tempo) - origin;
  const layerStart = Math.max(
      draw.start,
      origin + duration * outlineThresholdProgress(e.layer.threshold, clip.easing),
    ),
    layerDuration = e.layer.kind === 'instant' ? 0 : e.layer.durationUs;
  return {
    drawStart: draw.start,
    drawEnd: draw.end,
    layerStart,
    layerEnd: layerStart + layerDuration,
    totalEnd: Math.max(
      draw.end,
      layerStart + layerDuration,
      layerStart + (e.lineAfter.kind === 'fade' ? e.lineAfter.durationUs : 0),
    ),
  };
}
export function sliderRevealPath(
  project: Project,
  noteId: string,
  linked: boolean,
  poses: LayerPoses = {},
): { path: BezierPath; instance: PathInstance } {
  const note = project.notes[noteId];
  if (note?.kind !== 'slider') throw new Error('请选择一条 Slider');
  const instance = resolveRevealPath(
    project,
    {
      kind: 'path',
      path: note.path,
      linkedSliderId: noteId,
      maskWidth: 1,
      completion: 'keep-mask',
    },
    poses,
  );
  if (linked) return { path: project.paths[instance.pathId], instance };
  const path = structuredClone(project.paths[instance.pathId]);
  path.id = crypto.randomUUID();
  path.name += ' · 显现副本';
  path.nodes.forEach((n) => {
    n.id = crypto.randomUUID();
  });
  return { path, instance: { ...instance, pathId: path.id } };
}

export type RevealMask =
  | {
      kind: 'path';
      arc: ArcPath;
      reversed: boolean;
      width: number;
      progress: number;
      transform?: Affine;
    }
  | { kind: 'directional'; direction: Vec2; region?: Rect; progress: number }
  | {
      kind: 'fan';
      center: Vec2;
      startAngleRad: number;
      sweepAngleRad: number;
      progress: number;
    };
export interface RevealState {
  layerId: string;
  clipId: string | null;
  started: boolean;
  rawProgress: number;
  progress: number;
  alpha: number;
  scale: number;
  offset: Vec2;
  mask: RevealMask | null;
  outline?: DrawRanges & {
    transform?: Affine;
    arc: ArcPath;
    reversed: boolean;
    stroke: OutlineReveal['stroke'];
    opacity: number;
    layerProgress: number;
    transitionUs: number | null;
    phase: 'drawing' | 'revealing' | 'complete';
  };
}
export interface RevealEvaluation {
  mode: 'edit' | 'preview' | 'playtest';
  take?: PlaybackTake;
  override?: { clipId: string; progress: number } | null;
}

/** Immutable compiled document + random-access time evaluation. No renderers or PSD mutations. */
export class RevealEvaluator {
  private bindings: PathBindings;
  private tempo: TempoMap;
  private arcs = new Map<string, { arc: ArcPath; reversed: boolean }>();
  private groups = new Map<string, RevealClip[]>();
  private thresholds = new Map<string, number>();
  constructor(readonly project: Project) {
    this.bindings = new PathBindings(project);
    this.tempo = new TempoMap(project.timing);
    const sharedArcs = new Map<string, ArcPath>();
    for (const layer of Object.values(project.layers))
      if (layer.initialReveal === 0) this.groups.set(layer.id, []);
    for (const clip of Object.values(project.reveals)) {
      if (clip.effect.kind === 'outline')
        this.thresholds.set(
          clip.id,
          outlineThresholdProgress(clip.effect.layer.threshold, clip.easing),
        );
      const group = this.groups.get(clip.layerId) ?? [];
      group.push(clip);
      this.groups.set(clip.layerId, group);
      if (hasRevealPath(clip.effect)) {
        const use = resolveRevealPath(project, clip.effect, {}, false);
        const key = JSON.stringify([use.pathId, use.transform]);
        let arc = sharedArcs.get(key);
        if (!arc) {
          arc = new ArcPath(project.paths[use.pathId], use.transform, 0.25);
          sharedArcs.set(key, arc);
        }
        this.arcs.set(clip.id, {
          arc,
          reversed: !!use.reversed,
        });
      }
    }
  }
  evaluate(timeUs: number, options: RevealEvaluation): Record<string, RevealState> {
    const result = this.evaluateLayers(timeUs, options);
    for (const state of Object.values(result)) {
      const effect = state.clipId ? this.project.reveals[state.clipId].effect : null;
      if (!effect || !hasRevealPath(effect) || !effect.linkedSliderId) continue;
      const note = this.project.notes[effect.linkedSliderId];
      if (note?.kind !== 'slider' || !note.binding) continue;
      const transform = this.bindings.artworkDelta(note, result);
      if (state.mask?.kind === 'path') state.mask.transform = transform;
      if (state.outline) state.outline.transform = transform;
    }
    return result;
  }
  /** Input queries need ancestor poses, without artwork-only linked-path transforms. */
  poses(timeUs: number, options: RevealEvaluation, layerIds?: Iterable<string>): LayerPoses {
    return this.evaluateLayers(timeUs, options, layerIds);
  }
  private evaluateLayers(
    timeUs: number,
    options: RevealEvaluation,
    layerIds: Iterable<string> = this.groups.keys(),
  ): Record<string, RevealState> {
    const result: Record<string, RevealState> = {};
    const followed = new Map<string, number>();
    for (const layerId of layerIds) {
      const clips = this.groups.get(layerId);
      if (!clips) continue;
      const overrideLayer =
        !!options.override && clips.some((c) => c.id === options.override!.clipId);
      const base: RevealState = {
        layerId,
        clipId: null,
        started: false,
        rawProgress: 0,
        progress: 0,
        alpha: this.project.layers[layerId].initialReveal,
        scale: 1,
        offset: { x: 0, y: 0 },
        mask: null,
      };
      let winner: {
        clip: RevealClip;
        start: number;
        raw: number;
        now: number;
        transition: number | null;
      } | null = null;
      for (const clip of clips) {
        const forced = options.override?.clipId === clip.id;
        if (!forced && overrideLayer) continue;
        if (
          !forced &&
          options.mode !== 'playtest' &&
          clip.trigger.kind === 'note' &&
          (clip.trigger.event === 'miss' || clip.trigger.event.endsWith('-fail'))
        )
          continue;
        const trigger =
          clip.trigger.kind === 'timeline' || options.mode !== 'playtest'
            ? nominalTriggerTime(this.project, clip.trigger, this.tempo)
            : (options.take?.triggerTime(clip.trigger) ?? null);
        if (!forced && trigger === null) continue;
        const start =
          (trigger ?? nominalTriggerTime(this.project, clip.trigger, this.tempo)) +
          (clip.delayUs ?? 0);
        if (!forced && timeUs < start) continue;
        let raw: number,
          now = timeUs,
          transition: number | null = null;
        if (forced) raw = clamp01(options.override!.progress);
        else if (clip.progress.kind === 'elapsed') {
          const duration = spanUs(
            clip.progress.duration,
            { basis: 'time', timeUs: start },
            this.tempo,
          );
          raw = duration ? clamp01((timeUs - start) / duration) : 1;
        } else {
          const note = this.project.notes[clip.progress.noteId],
            noteStart = this.tempo.resolve(note.at),
            duration = endUs(note, this.tempo) - noteStart;
          if (clip.progress.kind === 'slider-follow' && options.mode === 'playtest') {
            if (!followed.has(note.id))
              followed.set(
                note.id,
                options.take?.follow(note.id, timeUs, noteStart, duration) ?? 0,
              );
            raw = followed.get(note.id)!;
          } else raw = clamp01((timeUs - noteStart) / Math.max(1, duration));
        }
        if (clip.effect.kind === 'outline') {
          const e = clip.effect,
            threshold = this.thresholds.get(clip.id)!;
          if (forced) {
            const duration = nominalClipRange(this.project, clip, this.tempo).duration;
            const layerDuration = e.layer.kind === 'instant' ? 0 : e.layer.durationUs;
            const total = Math.max(
              duration,
              duration * threshold + layerDuration,
              duration * threshold + (e.lineAfter.kind === 'fade' ? e.lineAfter.durationUs : 0),
            );
            now = start + options.override!.progress * total;
            raw = duration ? clamp01((now - start) / duration) : 1;
            transition = start + duration * threshold;
          } else if (clip.progress.kind === 'elapsed') {
            transition =
              start +
              spanUs(clip.progress.duration, { basis: 'time', timeUs: start }, this.tempo) *
                threshold;
          } else {
            const note = this.project.notes[clip.progress.noteId],
              origin = this.tempo.resolve(note.at),
              duration = endUs(note, this.tempo) - origin;
            transition =
              clip.progress.kind === 'slider-follow' && options.mode === 'playtest'
                ? (options.take?.timeAtFollow(note.id, origin, duration, threshold) ?? null)
                : origin + duration * threshold;
            if (transition !== null) transition = Math.max(start, transition);
          }
          if (
            clip.after === 'restore' &&
            transition !== null &&
            now >=
              transition +
                Math.max(
                  e.layer.kind === 'instant' ? 0 : e.layer.durationUs,
                  e.lineAfter.kind === 'fade' ? e.lineAfter.durationUs : 0,
                ) &&
            !forced
          )
            continue;
        } else if (clip.after === 'restore' && raw >= 1 && !forced) continue;
        // A later trigger wins; simultaneous clips resolve by priority, then stable ID.
        if (
          !winner ||
          forced ||
          start > winner.start ||
          (start === winner.start &&
            (clip.priority > winner.clip.priority ||
              (clip.priority === winner.clip.priority && clip.id > winner.clip.id)))
        )
          winner = { clip, start, raw, now, transition };
      }
      if (winner) {
        const { clip, raw } = winner,
          p =
            clip.effect.kind === 'outline'
              ? outlineDrawProgress(raw, clip.easing)
              : easeProgress(raw, clip.easing),
          e = clip.effect;
        base.clipId = clip.id;
        base.started = true;
        base.rawProgress = raw;
        base.progress = p;
        base.alpha = 1;
        if (e.kind === 'fade') base.alpha = p;
        if (e.kind === 'slide-in') {
          base.offset = { x: e.offset.x * (1 - p), y: e.offset.y * (1 - p) };
          base.alpha = p;
        }
        if (e.kind === 'pop') {
          base.scale = e.fromScale + (1 - e.fromScale) * p + e.overshoot * Math.sin(Math.PI * p);
          base.alpha = p;
        }
        if (e.kind === 'directional' && raw < 1) {
          base.mask = {
            kind: 'directional',
            direction: e.direction,
            region: e.region,
            progress: p,
          };
          if (p === 0) base.alpha = 0;
        }
        if (e.kind === 'fan') {
          const sector = fanSector(e, p);
          if (sector.sweepAngleRad <= 1e-10) base.alpha = 0;
          if (sector.sweepAngleRad < Math.PI * 2 - 1e-10)
            base.mask = { kind: 'fan', ...sector, progress: p };
        }
        if (e.kind === 'path' && !(raw >= 1 - 1e-9 && e.completion === 'show-full-layer')) {
          base.mask = { kind: 'path', ...this.arcs.get(clip.id)!, width: e.maskWidth, progress: p };
          if (p === 0) base.alpha = 0;
        }
        if (e.kind === 'outline') {
          const { arc, reversed } = this.arcs.get(clip.id)!;
          const elapsed = winner.transition === null ? -1 : winner.now - winner.transition;
          const reached = elapsed >= -1e-7;
          const layerRaw = reached
            ? e.layer.kind === 'instant' || e.layer.durationUs === 0
              ? 1
              : clamp01(Math.max(0, elapsed) / e.layer.durationUs)
            : 0;
          const layerP = easeProgress(layerRaw, clip.easing);
          base.alpha = reached ? (e.layer.kind === 'instant' ? 1 : layerP) : 0;
          if (e.layer.kind === 'pop')
            base.scale =
              e.layer.fromScale +
              (1 - e.layer.fromScale) * layerP +
              e.layer.overshoot * Math.sin(Math.PI * layerP);
          const opacity =
            !reached || e.lineAfter.kind === 'keep'
              ? 1
              : e.lineAfter.kind === 'hide'
                ? 0
                : e.lineAfter.durationUs === 0
                  ? 0
                  : 1 - clamp01(Math.max(0, elapsed) / e.lineAfter.durationUs);
          base.outline = {
            arc,
            reversed,
            stroke: e.stroke,
            opacity,
            ...outlineRanges(p, arc.path.closed, reversed, e.drawing),
            layerProgress: layerRaw,
            transitionUs: reached ? winner.transition : null,
            phase: !reached ? 'drawing' : layerRaw < 1 ? 'revealing' : 'complete',
          };
        }
      }
      result[layerId] = base;
    }
    return result;
  }
}

/** Clip a rectangle against a moving projection plane. Works for every direction/angle. */
export function directionalPolygon(region: Rect, direction: Vec2, progress: number): Vec2[] {
  const { x, y, width: w, height: h } = region,
    poly = [
      { x, y },
      { x: x + w, y },
      { x: x + w, y: y + h },
      { x, y: y + h },
    ];
  const dot = (p: Vec2) => p.x * direction.x + p.y * direction.y,
    values = poly.map(dot);
  const cut = Math.min(...values) + (Math.max(...values) - Math.min(...values)) * clamp01(progress);
  const output: Vec2[] = [];
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i],
      b = poly[(i + 1) % poly.length],
      da = dot(a) - cut,
      db = dot(b) - cut;
    if (da <= 0) output.push(a);
    if (da <= 0 !== db <= 0) {
      const t = da / (da - db);
      output.push({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
    }
  }
  return output;
}

export { layerBounds, revealMatrix } from './layer-pose';
