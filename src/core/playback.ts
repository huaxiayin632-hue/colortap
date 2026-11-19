import type { GameplayEvent, NoteEvent, TrackInterval } from './judgement';
import type { Trigger } from '../shared/models';

const clamp01 = (n: number) => Math.max(0, Math.min(1, n));

const triggerKinds: Record<Extract<Trigger, { kind: 'note' }>['event'], NoteEvent['kind'][]> = {
  hit: ['circle-hit', 'slider-start', 'hold-start'],
  miss: ['circle-miss'],
  'slider-start': ['slider-start'],
  'slider-complete': ['slider-complete'],
  'slider-fail': ['slider-fail'],
  'hold-complete': ['hold-complete'],
  'hold-fail': ['hold-fail'],
};

/** Per-take evidence only; never serialized into a project or inferred from a passing playhead. */
export class PlaybackTake {
  runId = '';
  readonly events: NoteEvent[] = [];
  readonly tracks = new Map<string, readonly TrackInterval[]>();
  private readonly firstEvents = new Map<string, NoteEvent>();
  // The session owns interval arrays; a seek keeps a truncated copy of their history.
  readonly recordTrack = (noteId: string, intervals: readonly TrackInterval[]): void => {
    this.tracks.set(noteId, intervals);
  };
  clear(): void {
    this.events.length = 0;
    this.tracks.clear();
    this.firstEvents.clear();
  }
  seek(timeUs: number): void {
    this.events.splice(0, this.events.length, ...this.events.filter((e) => e.timeUs <= timeUs));
    this.firstEvents.clear();
    for (const event of this.events) this.index(event);
    for (const [id, intervals] of this.tracks) {
      this.tracks.set(
        id,
        intervals
          .filter((i) => i.startUs < timeUs)
          .map((i) => ({ ...i, endUs: Math.min(i.endUs, timeUs) })),
      );
    }
  }
  accept(event: GameplayEvent): void {
    if (event.kind === 'session-reset') {
      if (event.reason === 'seek') this.seek(event.timeUs);
      else this.clear();
      this.runId = event.runId;
      return;
    }
    if (event.runId !== this.runId) return;
    // Progress is reconstructed from exact valid intervals, not a bounded UI event log.
    if (!event.kind.endsWith('-progress') && !event.kind.endsWith('-break')) {
      const copy = { ...event };
      this.events.push(copy);
      this.index(copy);
    }
  }
  private index(event: NoteEvent): void {
    const kinds = [
      event.kind,
      ...Object.entries(triggerKinds)
        .filter(([, events]) => events.includes(event.kind))
        .map(([kind]) => kind),
    ];
    for (const kind of kinds) {
      const key = `${event.noteId}:${kind}`;
      if (!this.firstEvents.has(key)) this.firstEvents.set(key, event);
    }
  }
  eventTime(noteId: string, kind: NoteEvent['kind']): number | null {
    return this.firstEvents.get(`${noteId}:${kind}`)?.timeUs ?? null;
  }
  triggerTime(trigger: Trigger): number | null {
    if (trigger.kind !== 'note') return null;
    return this.firstEvents.get(`${trigger.noteId}:${trigger.event}`)?.timeUs ?? null;
  }
  follow(noteId: string, timeUs: number, startUs: number, durationUs: number): number {
    const validUs = (this.tracks.get(noteId) ?? []).reduce(
      (total, i) =>
        total +
        (i.valid ? Math.max(0, Math.min(timeUs, i.endUs) - Math.max(startUs, i.startUs)) : 0),
      0,
    );
    return clamp01(validUs / Math.max(1, durationUs));
  }
  timeAtFollow(
    noteId: string,
    startUs: number,
    durationUs: number,
    threshold: number,
  ): number | null {
    const target = durationUs * threshold;
    if (target <= 0) return startUs;
    let accumulated = 0;
    for (const i of this.tracks.get(noteId) ?? []) {
      if (!i.valid) continue;
      const from = Math.max(startUs, i.startUs),
        to = Math.min(startUs + durationUs, i.endUs),
        length = Math.max(0, to - from);
      if (accumulated + length + 1e-7 >= target) return from + Math.max(0, target - accumulated);
      accumulated += length;
    }
    return null;
  }
}
