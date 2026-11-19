import type { Note, Project, Vec2 } from '../shared/models';
import { TempoMap } from './timing';
import { ArcPath, distance, subtract } from './path';
import { endUs } from './chart';
import { inverse, point, type Affine } from './layers';
import { invertible, type Slider } from './path-binding';

export interface MovingNoteSpace {
  matrix(note: Slider, timeUs: number): Affine;
}
export const MOTION_STEP_US = 2000;

export type Grade = 'perfect' | 'good';
export type TrackReason = 'released' | 'outside' | 'late-head';
export interface TrackInterval {
  startUs: number;
  endUs: number;
  valid: boolean;
  reason?: TrackReason;
}
export interface NoteResult {
  status: 'pending' | 'active' | Grade | 'miss' | 'complete' | 'failed' | 'skipped';
  grade?: Grade;
  errorUs?: number;
  trackedUs: number;
  progress: number;
  timelineProgress: number;
  valid: boolean | null;
  intervals: TrackInterval[];
}
export type NoteEvent = {
  kind:
    | 'circle-hit'
    | 'circle-miss'
    | 'slider-start'
    | 'slider-progress'
    | 'slider-break'
    | 'slider-complete'
    | 'slider-fail'
    | 'hold-start'
    | 'hold-progress'
    | 'hold-break'
    | 'hold-complete'
    | 'hold-fail';
  noteId: string;
  runId: string;
  timeUs: number;
  grade?: Grade;
  errorUs?: number;
  progress?: number;
  timelineProgress?: number;
  reason?: TrackReason | 'head-miss' | 'insufficient-tracking';
};
export type ResetReason = 'seek' | 'restart' | 'mode' | 'document';
export type GameplayEvent =
  NoteEvent | { kind: 'session-reset'; runId: string; timeUs: number; reason?: ResetReason };
export function circleGrade(
  errorUs: number,
  windows: Project['rules']['hitWindowsUs'],
): Grade | null {
  const error = Math.abs(errorUs);
  return error <= windows.perfect ? 'perfect' : error <= windows.good ? 'good' : null;
}
interface RuntimeNote {
  note: Note;
  startUs: number;
  endUs: number;
  path?: ArcPath;
  result: NoteResult;
  motion?: {
    cell: number;
    epoch: number;
    from: number;
    to: number;
    a: Affine | null;
    b: Affine | null;
    ballA: Vec2;
    ballB: Vec2;
  };
}

/** Exact time interval where a linearly travelling ball lies inside a stationary input circle. */
export function lineFollowInterval(
  a: Vec2,
  b: Vec2,
  fromUs: number,
  toUs: number,
  pointer: Vec2,
  radius: number,
): [number, number] | null {
  const delta = subtract(b, a),
    offset = subtract(a, pointer);
  const aa = delta.x ** 2 + delta.y ** 2,
    bb = 2 * (offset.x * delta.x + offset.y * delta.y),
    cc = offset.x ** 2 + offset.y ** 2 - radius ** 2;
  if (aa < 1e-18) return cc <= 0 ? [fromUs, toUs] : null;
  const discriminant = bb * bb - 4 * aa * cc;
  if (discriminant < 0) return null;
  const lo = Math.max(0, (-bb - Math.sqrt(discriminant)) / (2 * aa)),
    hi = Math.min(1, (-bb + Math.sqrt(discriminant)) / (2 * aa));
  return hi > lo ? [fromUs + (toUs - fromUs) * lo, fromUs + (toUs - fromUs) * hi] : null;
}

/** Pure timestamp-driven gameplay. No Vue, Pixi, device pixels, frame counters, or layer mutations. */
export class PlaySession {
  readonly runId = crypto.randomUUID();
  readonly notes: Map<string, RuntimeNote>;
  private pointer: Vec2 | null = null;
  private held = false;
  private cursorUs: number;
  private motionEpoch = 0;
  private moving = false;
  get timeUs(): number {
    return this.cursorUs;
  }
  constructor(
    readonly project: Project,
    startUs = 0,
    private readonly emit: (event: GameplayEvent) => void = () => {},
    private readonly space?: MovingNoteSpace,
    private readonly recordTrack?: (noteId: string, intervals: readonly TrackInterval[]) => void,
  ) {
    const tempo = new TempoMap(project.timing);
    this.cursorUs = startUs;
    this.notes = new Map(
      Object.values(project.notes)
        .sort((a, b) => tempo.resolve(a.at) - tempo.resolve(b.at))
        .map((note) => {
          const start = tempo.resolve(note.at);
          return [
            note.id,
            {
              note,
              startUs: start,
              endUs: endUs(note, tempo),
              path:
                note.kind === 'slider'
                  ? new ArcPath(project.paths[note.path.pathId], note.path.transform)
                  : undefined,
              result: {
                status: start + project.rules.hitWindowsUs.good < startUs ? 'skipped' : 'pending',
                trackedUs: 0,
                progress: 0,
                timelineProgress: 0,
                valid: null,
                intervals: [],
              },
            },
          ];
        }),
    );
    this.emit({ kind: 'session-reset', runId: this.runId, timeUs: startUs });
    this.moving =
      !!space && [...this.notes.values()].some((n) => n.note.kind === 'slider' && n.note.binding);
  }
  private event(
    kind: NoteEvent['kind'],
    n: RuntimeNote,
    timeUs: number,
    extra: Partial<NoteEvent> = {},
  ): void {
    if (!kind.endsWith('-progress') && !kind.endsWith('-break')) this.motionEpoch++;
    this.emit({ kind, noteId: n.note.id, runId: this.runId, timeUs: Math.round(timeUs), ...extra });
  }
  private record(
    n: RuntimeNote,
    from: number,
    to: number,
    valid: boolean,
    reason?: TrackReason,
  ): void {
    if (to <= from) return;
    const result = n.result,
      previous = result.intervals.at(-1);
    if (
      previous &&
      previous.valid === valid &&
      previous.reason === reason &&
      Math.abs(previous.endUs - from) < 0.01
    )
      previous.endUs = to;
    else result.intervals.push({ startUs: from, endUs: to, valid, ...(reason ? { reason } : {}) });
    if (valid) result.trackedUs += to - from;
    this.recordTrack?.(n.note.id, result.intervals);
    if (!valid && result.valid !== false) this.sustainedEvent(n, 'break', from, { reason });
    result.valid = valid;
  }
  private follow(n: RuntimeNote, start: number, end: number): void {
    if (n.note.kind === 'circle' || end <= start) return;
    const result = n.result,
      duration = n.endUs - n.startUs,
      before = result.trackedUs;
    if (n.note.kind === 'hold')
      this.record(n, start, end, this.held, this.held ? undefined : 'released');
    else if (!this.held || !this.pointer)
      this.record(n, start, end, false, this.held ? 'outside' : 'released');
    else if (n.note.binding && this.space) this.followMoving(n, start, end);
    else {
      const path = n.path!,
        samples = n.note.path.reversed ? [...path.samples].reverse() : path.samples;
      let covered = start;
      if (path.length < 1e-10) {
        const valid = distance(path.at(0), this.pointer) <= n.note.followRadius;
        this.record(n, start, end, valid, valid ? undefined : 'outside');
        covered = end;
      } else
        for (let i = 1; i < samples.length; i++) {
          const a = samples[i - 1],
            b = samples[i];
          const t0 =
            n.startUs +
            ((n.note.path.reversed ? path.length - a.distance : a.distance) / path.length) *
              duration;
          const t1 =
            n.startUs +
            ((n.note.path.reversed ? path.length - b.distance : b.distance) / path.length) *
              duration;
          if (t1 <= start || t0 >= end) continue;
          const interval = lineFollowInterval(
            a.point,
            b.point,
            t0,
            t1,
            this.pointer,
            n.note.followRadius,
          );
          if (!interval) continue;
          const from = Math.max(covered, start, interval[0]),
            to = Math.min(end, interval[1]);
          if (to <= from) continue;
          this.record(n, covered, from, false, 'outside');
          this.record(n, from, to, true);
          covered = to;
        }
      this.record(n, covered, end, false, 'outside');
    }
    result.progress = Math.min(1, result.trackedUs / duration);
    result.timelineProgress = Math.min(1, (end - n.startUs) / duration);
    if (result.trackedUs > before)
      this.sustainedEvent(n, 'progress', end, {
        progress: result.progress,
        timelineProgress: result.timelineProgress,
      });
  }
  private followMoving(n: RuntimeNote, start: number, end: number): void {
    const note = n.note as Slider,
      cell = Math.floor(start / MOTION_STEP_US),
      path = n.path!;
    let motion = n.motion;
    if (!motion || motion.cell !== cell || motion.epoch !== this.motionEpoch) {
      const from = Math.max(n.startUs, cell * MOTION_STEP_US),
        to = Math.min(n.endUs, (cell + 1) * MOTION_STEP_US);
      const a = this.space!.matrix(note, from),
        b = this.space!.matrix(note, to);
      motion = n.motion = {
        cell,
        epoch: this.motionEpoch,
        from,
        to,
        a: invertible(a) ? inverse(a) : null,
        b: invertible(b) ? inverse(b) : null,
        ballA: path.at((from - n.startUs) / (n.endUs - n.startUs), note.path.reversed),
        ballB: path.at((to - n.startUs) / (n.endUs - n.startUs), note.path.reversed),
      };
    }
    if (!motion.a || !motion.b) {
      this.record(n, start, end, false, 'outside');
      return;
    }
    const relativeA = subtract(motion.ballA, point(motion.a, this.pointer!)),
      relativeB = subtract(motion.ballB, point(motion.b, this.pointer!));
    const interval = lineFollowInterval(
      relativeA,
      relativeB,
      motion.from,
      motion.to,
      { x: 0, y: 0 },
      note.followRadius,
    );
    const from = interval ? Math.max(start, interval[0]) : end,
      to = interval ? Math.min(end, interval[1]) : end;
    if (to <= from) {
      this.record(n, start, end, false, 'outside');
      return;
    }
    this.record(n, start, from, false, 'outside');
    this.record(n, from, to, true);
    this.record(n, to, end, false, 'outside');
  }
  private sustainedEvent(
    n: RuntimeNote,
    phase: 'start' | 'progress' | 'break' | 'complete' | 'fail',
    timeUs: number,
    extra: Partial<NoteEvent> = {},
  ): void {
    this.event(`${n.note.kind === 'hold' ? 'hold' : 'slider'}-${phase}`, n, timeUs, extra);
  }
  advance(timeUs: number): void {
    if (timeUs < this.cursorUs) throw new Error('跳转或重播时请创建新的试玩会话');
    if (!this.moving) {
      this.advanceStep(timeUs);
      return;
    }
    while (this.cursorUs < timeUs)
      this.advanceStep(
        Math.min(timeUs, (Math.floor(this.cursorUs / MOTION_STEP_US) + 1) * MOTION_STEP_US),
      );
  }
  private advanceStep(timeUs: number): void {
    for (const n of this.notes.values()) {
      const r = n.result;
      const deadline =
        n.note.kind !== 'circle'
          ? Math.min(n.endUs, n.startUs + this.project.rules.hitWindowsUs.good)
          : n.startUs + this.project.rules.hitWindowsUs.good;
      if (r.status === 'pending' && timeUs > deadline) {
        r.status = n.note.kind === 'circle' ? 'miss' : 'failed';
        if (n.note.kind === 'circle') this.event('circle-miss', n, deadline);
        else this.sustainedEvent(n, 'fail', deadline, { reason: 'head-miss', progress: 0 });
      }
      if (r.status !== 'active') continue;
      this.follow(n, Math.max(this.cursorUs, n.startUs), Math.min(timeUs, n.endUs));
      if (timeUs >= n.endUs) {
        const threshold =
          n.note.kind === 'hold'
            ? (this.project.rules.holdCompleteRatio ?? 0.95)
            : this.project.rules.sliderCompleteRatio;
        const complete = r.progress + 1e-9 >= threshold;
        r.status = complete ? 'complete' : 'failed';
        this.sustainedEvent(n, complete ? 'complete' : 'fail', n.endUs, {
          progress: r.progress,
          timelineProgress: 1,
          ...(complete ? {} : { reason: 'insufficient-tracking' as const }),
        });
      }
    }
    this.cursorUs = timeUs;
  }
  input(timeUs: number, pointer: Vec2 | null, held: boolean, press = false): string | null {
    this.advance(timeUs);
    this.pointer = pointer ? { ...pointer } : null;
    this.held = held;
    if (!press || !pointer) return null;
    const candidates = [...this.notes.values()]
      .filter((n) => {
        if (
          n.result.status !== 'pending' ||
          !circleGrade(timeUs - n.startUs, this.project.rules.hitWindowsUs)
        )
          return false;
        if (n.note.kind !== 'circle' && timeUs > n.endUs) return false;
        let local = pointer;
        if (n.note.kind === 'slider' && n.note.binding && this.space) {
          const m = this.space.matrix(n.note, timeUs);
          if (!invertible(m)) return false;
          local = point(inverse(m), pointer);
        }
        return (
          distance(
            local,
            n.note.kind !== 'slider' ? n.note.position : n.path!.at(0, n.note.path.reversed),
          ) <= (n.note.kind !== 'slider' ? n.note.radius : n.note.headRadius)
        );
      })
      .sort(
        (a, b) =>
          Math.abs(timeUs - a.startUs) - Math.abs(timeUs - b.startUs) || a.startUs - b.startUs,
      );
    const n = candidates[0];
    if (!n) return null;
    const grade = circleGrade(timeUs - n.startUs, this.project.rules.hitWindowsUs)!;
    n.result.grade = grade;
    n.result.errorUs = timeUs - n.startUs;
    n.result.status = n.note.kind === 'circle' ? grade : 'active';
    if (n.note.kind !== 'circle' && timeUs > n.startUs) {
      n.result.intervals.push({
        startUs: n.startUs,
        endUs: timeUs,
        valid: false,
        reason: 'late-head',
      });
      this.recordTrack?.(n.note.id, n.result.intervals);
    }
    const extra = { grade, errorUs: n.result.errorUs };
    if (n.note.kind === 'circle') this.event('circle-hit', n, timeUs, extra);
    else this.sustainedEvent(n, 'start', timeUs, extra);
    return n.note.id;
  }
  snapshot() {
    const results = Object.fromEntries([...this.notes].map(([id, n]) => [id, n.result]));
    const counts = {
      perfect: 0,
      good: 0,
      miss: 0,
      complete: 0,
      failed: 0,
      skipped: 0,
      holdComplete: 0,
      holdFailed: 0,
    };
    for (const n of this.notes.values()) {
      if (n.note.kind === 'hold' && n.result.status === 'complete') counts.holdComplete++;
      else if (n.note.kind === 'hold' && n.result.status === 'failed') counts.holdFailed++;
      else if (n.result.status in counts) counts[n.result.status as keyof typeof counts]++;
    }
    return { runId: this.runId, timeUs: this.cursorUs, results, counts };
  }
}
