import type { Moment, TimingMap, Us } from '../shared/models';

export class TempoMap {
  private readonly segments: { tick: number; timeUs: number; usPerTick: number }[];
  constructor(readonly map: TimingMap) {
    if (map.ppq !== 960 || !Number.isSafeInteger(map.beatZeroUs) || !map.points.length)
      throw new Error('节拍配置无效');
    this.segments = [];
    for (const point of map.points) {
      const prev = this.segments.at(-1);
      if (
        !Number.isSafeInteger(point.tick) ||
        point.tick < 0 ||
        !Number.isFinite(point.bpm) ||
        point.bpm <= 0 ||
        (!prev && point.tick !== 0) ||
        (prev && point.tick <= prev.tick)
      )
        throw new Error('BPM 点必须从零开始并按刻度递增');
      this.segments.push({
        tick: point.tick,
        timeUs: prev ? prev.timeUs + (point.tick - prev.tick) * prev.usPerTick : map.beatZeroUs,
        usPerTick: 60_000_000 / (point.bpm * map.ppq),
      });
    }
  }
  tickToTime(tick: number): Us {
    if (!Number.isFinite(tick)) throw new Error('无效刻度');
    const segment = this.find(tick, 'tick');
    return Math.round(segment.timeUs + (tick - segment.tick) * segment.usPerTick);
  }
  timeToTick(timeUs: Us): number {
    if (!Number.isFinite(timeUs)) throw new Error('无效时间');
    const segment = this.find(timeUs, 'timeUs');
    const tick = segment.tick + (timeUs - segment.timeUs) / segment.usPerTick;
    const nearest = Math.round(tick);
    // Stabilize exact beat boundaries without rounding legitimate fractional ticks.
    return Math.abs(tick - nearest) <= Number.EPSILON * Math.max(1, Math.abs(tick)) * 8
      ? nearest
      : tick;
  }
  resolve(moment: Moment): Us {
    return moment.basis === 'time' ? moment.timeUs : this.tickToTime(moment.tick);
  }
  snap(timeUs: Us, divisions: number): Us {
    if (!Number.isSafeInteger(divisions) || divisions <= 0 || 960 % divisions !== 0)
      throw new Error('无效吸附细分');
    const quantum = 960 / divisions;
    return this.tickToTime(Math.round(this.timeToTick(timeUs) / quantum) * quantum);
  }
  private find(value: number, field: 'tick' | 'timeUs') {
    let low = 0;
    let high = this.segments.length - 1;
    while (low < high) {
      const mid = Math.ceil((low + high) / 2);
      if (this.segments[mid][field] <= value) low = mid;
      else high = mid - 1;
    }
    return this.segments[low];
  }
}

// Projection of one audio clock. No animation-frame deltas or wall clock accumulation.
export class AnchoredClock {
  private anchorSeconds = 0;
  private anchorUs = 0;
  private running = false;
  durationUs = 0;
  get playing(): boolean {
    return this.running;
  }
  positionAt(contextSeconds: number): Us {
    const time =
      this.anchorUs +
      (this.running ? Math.max(0, contextSeconds - this.anchorSeconds) * 1_000_000 : 0);
    return Math.round(Math.max(0, Math.min(this.durationUs, time)));
  }
  start(contextSeconds: number): void {
    this.anchorSeconds = contextSeconds;
    this.running = true;
  }
  pause(contextSeconds: number): void {
    this.anchorUs = this.positionAt(contextSeconds);
    this.running = false;
  }
  seek(timeUs: Us, contextSeconds: number): void {
    if (!Number.isFinite(timeUs)) throw new Error('无效播放位置');
    this.anchorUs = Math.round(Math.max(0, Math.min(this.durationUs, timeUs)));
    this.anchorSeconds = contextSeconds;
  }
  reset(durationUs = 0): void {
    this.running = false;
    this.anchorUs = 0;
    this.anchorSeconds = 0;
    this.durationUs = durationUs;
  }
}

export function formatTime(timeUs: number): string {
  const milliseconds = Math.floor(Math.max(0, timeUs) / 1000);
  return `${Math.floor(milliseconds / 60000)
    .toString()
    .padStart(2, '0')}:${Math.floor((milliseconds / 1000) % 60)
    .toString()
    .padStart(2, '0')}.${(milliseconds % 1000).toString().padStart(3, '0')}`;
}
