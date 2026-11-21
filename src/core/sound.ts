import type { Project, RevealClip, SoundCue } from '../shared/models';
import { TempoMap } from './timing';
import { endUs, nominalTriggerTime, spanUs } from './chart';
import { nominalClipRange, outlineStages } from './reveal';
import type { PlaybackTake } from './playback';
import { outlineThresholdProgress } from './easing';
import { parents } from './layers';

export type PlaybackMode = 'edit' | 'preview' | 'playtest';
export interface SoundOccurrence {
  token: string;
  cueId: string;
  timeUs: number;
}
export const soundBus = (cue: SoundCue) =>
  cue.bus ?? ('noteId' in cue.trigger ? 'hit' : 'animation');

/** Exact music-time milestones. Follow milestones only exist after valid tracking crosses them. */
export function revealSoundTimes(
  p: Project,
  clip: RevealClip,
  mode: PlaybackMode,
  take: PlaybackTake,
  tempo = new TempoMap(p.timing),
) {
  if (
    mode !== 'playtest' &&
    clip.trigger.kind === 'note' &&
    (clip.trigger.event === 'miss' || clip.trigger.event.endsWith('-fail'))
  )
    return null;
  const trigger =
    clip.trigger.kind === 'timeline' || mode !== 'playtest'
      ? nominalTriggerTime(p, clip.trigger, tempo)
      : take.triggerTime(clip.trigger);
  if (trigger === null) return null;
  const start = trigger + (clip.delayUs ?? 0);
  const note = clip.progress.kind !== 'elapsed' ? p.notes[clip.progress.noteId] : null;
  const origin = note ? tempo.resolve(note.at) : start;
  const duration = note
    ? endUs(note, tempo) - origin
    : spanUs(
        (clip.progress as Extract<RevealClip['progress'], { kind: 'elapsed' }>).duration,
        { basis: 'time', timeUs: start },
        tempo,
      );
  const at = (progress: number): number | null => {
    const time =
      note && clip.progress.kind === 'slider-follow' && mode === 'playtest'
        ? take.timeAtFollow(note.id, origin, duration, progress)
        : origin + duration * progress;
    return time === null ? null : Math.max(start, time);
  };
  const complete = at(1);
  if (clip.effect.kind === 'outline') {
    const threshold = at(outlineThresholdProgress(clip.effect.layer.threshold, clip.easing));
    return {
      start,
      complete,
      layer:
        threshold === null
          ? null
          : threshold + (clip.effect.layer.kind === 'instant' ? 0 : clip.effect.layer.durationUs),
    };
  }
  return { start, complete, layer: clip.effect.kind === 'instant' ? start : complete };
}

/** Timeline placement only; no playback state, event history or layer index is needed. */
export function nominalSoundTime(
  project: Project,
  cue: SoundCue,
  tempo = new TempoMap(project.timing),
): number {
  const t = cue.trigger;
  if (t.kind === 'timeline' || t.kind === 'note')
    return nominalTriggerTime(project, t, tempo) + cue.delayUs;
  if (t.kind === 'slider-tick') return tempo.resolve(project.notes[t.noteId].at) + cue.delayUs;
  const clip = project.reveals[t.revealId];
  let time: number;
  if (clip.effect.kind === 'outline') {
    const stages = outlineStages(project, clip, tempo)!;
    time =
      t.kind === 'layer-reveal'
        ? stages.layerEnd
        : t.kind === 'outline-complete'
          ? stages.drawEnd
          : stages.drawStart;
  } else {
    const range = nominalClipRange(project, clip, tempo);
    time =
      t.kind === 'outline-complete' || (t.kind === 'layer-reveal' && clip.effect.kind !== 'instant')
        ? range.end
        : range.start;
  }
  return time + cue.delayUs;
}

/** One epoch per seek/replay. No audio objects or timers; pending future sounds can be re-armed. */
export class SoundPlanner {
  readonly tempo: TempoMap;
  private seen = new Map<string, number>();
  private floor = 0;
  private parent: Map<string, string | null>;
  private cues: SoundCue[];
  private ticks = new Map<string, number>();
  constructor(readonly project: Project) {
    this.tempo = new TempoMap(project.timing);
    this.parent = parents(project);
    this.cues = Object.values(project.sounds).filter((cue) => cue.enabled !== false);
  }
  reset(timeUs: number, includeAt = timeUs === 0): void {
    this.seen.clear();
    this.ticks.clear();
    this.floor = timeUs - (includeAt ? 1 : 0);
  }
  pause(timeUs: number, includeAt = false): void {
    const cutoff = timeUs - (includeAt ? 1 : 0);
    this.floor = Math.max(this.floor, cutoff);
    this.cancelAfter(cutoff);
  }
  cancelAfter(timeUs: number): void {
    this.ticks.clear();
    for (const [key, at] of this.seen) if (at > timeUs) this.seen.delete(key);
  }

  collect(
    timeUs: number,
    mode: PlaybackMode,
    take: PlaybackTake,
    horizonUs = timeUs,
  ): SoundOccurrence[] {
    const result: SoundOccurrence[] = [];
    const revealTimes = new Map<string, ReturnType<typeof revealSoundTimes>>();
    const add = (cue: SoundCue, origin: number | null, suffix = '') => {
      if (origin === null) return;
      const at = Math.round(origin + cue.delayUs),
        token = cue.id + suffix;
      if (at <= this.floor || at > horizonUs || this.seen.has(token)) return;
      this.seen.set(token, at);
      result.push({ token, cueId: cue.id, timeUs: at });
    };
    for (const cue of this.cues) {
      const trigger = cue.trigger;
      if (trigger.kind !== 'slider-tick' && this.seen.has(cue.id)) continue;
      if (trigger.kind === 'timeline') add(cue, this.tempo.resolve(trigger.at));
      else if (trigger.kind === 'note') {
        if (mode === 'playtest') {
          add(cue, take.triggerTime(trigger));
        } else if (trigger.event !== 'miss' && !trigger.event.endsWith('-fail')) {
          add(cue, nominalTriggerTime(this.project, trigger, this.tempo));
        }
      } else if (trigger.kind === 'slider-tick') {
        const note = this.project.notes[trigger.noteId],
          start = this.tempo.resolve(note.at),
          end = endUs(note, this.tempo);
        if (end + cue.delayUs <= this.floor || start > (mode === 'playtest' ? timeUs : horizonUs))
          continue;
        const tick = this.tempo.timeToTick(start);
        const first = Math.max(
          1,
          this.ticks.get(cue.id) ?? 1,
          Math.ceil(
            (this.tempo.timeToTick(this.floor - cue.delayUs) - tick) / trigger.intervalTicks,
          ),
        );
        const last = Math.floor(
          (this.tempo.timeToTick(
            Math.min(end - 1, mode === 'playtest' ? timeUs : Infinity, horizonUs - cue.delayUs),
          ) -
            tick) /
            trigger.intervalTicks,
        );
        for (let i = first; i <= last; i++) {
          const at = this.tempo.tickToTime(tick + i * trigger.intervalTicks);
          if (at >= end) break;
          if (
            mode !== 'playtest' ||
            (take.tracks.get(note.id) ?? []).some(
              (v) => v.valid && v.startUs <= at && v.endUs >= at,
            )
          )
            add(cue, at, `:${i}`);
        }
        // Judgement intervals up to timeUs are final. Revisit only on seek/pause,
        // when future scheduled voices are cancelled and must be re-armed.
        this.ticks.set(cue.id, Math.max(first, last + 1));
      } else {
        const clip = this.project.reveals[trigger.revealId];
        let enabled = true;
        for (
          let layer: string | null | undefined = clip.layerId;
          layer;
          layer = this.parent.get(layer)
        )
          if (!this.project.layers[layer].enabled) enabled = false;
        if (
          !enabled ||
          ((trigger.kind === 'outline-start' || trigger.kind === 'outline-complete') &&
            clip.effect.kind !== 'outline')
        )
          continue;
        if (!revealTimes.has(clip.id))
          revealTimes.set(clip.id, revealSoundTimes(this.project, clip, mode, take, this.tempo));
        const times = revealTimes.get(clip.id);
        if (times)
          add(
            cue,
            trigger.kind === 'layer-reveal'
              ? times.layer
              : trigger.kind === 'outline-complete'
                ? times.complete
                : times.start,
          );
      }
    }
    return result.sort((a, b) => a.timeUs - b.timeUs || a.token.localeCompare(b.token));
  }
}
