import type { Moment, TimingMap, Us } from '../shared/models';

export class TempoMap {
  private readonly segments: { tick: number; timeUs: number; usPerTick: number }[];
  private readonly meters: {
    tick: number;
    timeUs: number;
    bar: number;
    beats: number;
    denominator: number;
    beatTicks: number;
    barTicks: number;
  }[] = [];
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
        !point.meter.every((n) => Number.isSafeInteger(n) && n > 0) ||
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
    for (const point of map.points) {
      const previous = this.meters.at(-1),
        beatTicks = (map.ppq * 4) / point.meter[1];
      // A BPM-only change keeps the measure. A meter change closes any partial bar.
      if (previous && previous.beats === point.meter[0] && previous.beatTicks === beatTicks)
        continue;
      this.meters.push({
        tick: point.tick,
        timeUs: this.tickToTime(point.tick),
        bar: previous
          ? previous.bar +
            this.measureCount(point.tick - previous.tick, previous.beats, previous.denominator)
          : 1,
        beats: point.meter[0],
        denominator: point.meter[1],
        beatTicks,
        barTicks: beatTicks * point.meter[0],
      });
    }
  }
  private measureCount(ticks: number, numerator: number, denominator: number) {
    const count = BigInt(ticks) * BigInt(denominator),
      length = 3840n * BigInt(numerator);
    return Number((count + length - 1n) / length);
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
    const quantum = this.quantum(divisions);
    return this.tickToTime(Math.round(this.timeToTick(timeUs) / quantum) * quantum);
  }
  private quantum(divisions: number) {
    if (!Number.isSafeInteger(divisions) || divisions <= 0 || 960 % divisions !== 0)
      throw new Error('无效吸附细分');
    return 960 / divisions;
  }
  // Compare rounded microseconds, not an epsilon in tick space. A rounded boundary
  // must have the same label and navigation behavior at every BPM.
  private indexAt(timeUs: number, origin: number, quantum: number) {
    let index = Math.floor((this.timeToTick(timeUs) - origin) / quantum);
    if (this.tickToTime(origin + (index + 1) * quantum) <= timeUs) index++;
    else if (this.tickToTime(origin + index * quantum) > timeUs) index--;
    return index;
  }
  private meterAt(timeUs: number) {
    let low = 0,
      high = this.meters.length - 1;
    while (low < high) {
      const mid = Math.ceil((low + high) / 2);
      if (this.meters[mid].timeUs <= timeUs) low = mid;
      else high = mid - 1;
    }
    return low;
  }
  barBeat(timeUs: number) {
    const meter = this.meters[this.meterAt(timeUs)];
    const index = this.indexAt(timeUs, meter.tick, meter.beatTicks);
    const offset = Math.floor(index / meter.beats);
    return { bar: meter.bar + offset, beat: index - offset * meter.beats + 1 };
  }
  nextGrid(timeUs: number, divisions: number, direction: -1 | 1): number {
    const quantum = this.quantum(divisions),
      index = this.indexAt(timeUs, 0, quantum);
    const exact = this.tickToTime(index * quantum) === timeUs;
    return this.tickToTime((index + (direction > 0 ? 1 : exact ? -1 : 0)) * quantum);
  }
  nextBar(timeUs: number, direction: -1 | 1): number {
    const i = this.meterAt(timeUs),
      meter = this.meters[i];
    const index = this.indexAt(timeUs, meter.tick, meter.barTicks);
    const start = this.tickToTime(meter.tick + index * meter.barTicks);
    if (direction > 0)
      return Math.min(
        this.tickToTime(meter.tick + (index + 1) * meter.barTicks),
        this.meters[i + 1]?.timeUs ?? Infinity,
      );
    if (start < timeUs) return start;
    if (index === 0 && i > 0) {
      const previous = this.meters[i - 1];
      const last =
        this.measureCount(meter.tick - previous.tick, previous.beats, previous.denominator) - 1;
      return this.tickToTime(previous.tick + last * previous.barTicks);
    }
    return this.tickToTime(meter.tick + (index - 1) * meter.barTicks);
  }
  /** Visible metrical beats; denominator defines the beat, independently of snap divisions. */
  barMarks(startUs: number, endUs: number, minGapUs: number) {
    const lines: { tick: number; timeUs: number; bar: number; beat: number; major: boolean }[] = [];
    for (let m = 0; m < this.meters.length; m++) {
      const meter = this.meters[m],
        nextMeter = this.meters[m + 1];
      if ((m > 0 && meter.timeUs > endUs) || (nextMeter && nextMeter.timeUs <= startUs)) continue;
      for (let s = 0; s < this.segments.length; s++) {
        const segment = this.segments[s],
          nextTempo = this.segments[s + 1];
        const low = Math.max(
          m ? meter.tick : -Infinity,
          s ? segment.tick : -Infinity,
          this.timeToTick(startUs - 0.5),
        );
        const high = Math.min(
          nextMeter?.tick ?? Infinity,
          nextTempo?.tick ?? Infinity,
          this.timeToTick(endUs + 0.5),
        );
        if (low > high) continue;
        const beatGap = meter.beatTicks * segment.usPerTick;
        const stride =
          minGapUs <= beatGap
            ? 1
            : meter.beats * Math.max(1, Math.ceil(minGapUs / (meter.barTicks * segment.usPerTick)));
        const first = Math.ceil((low - meter.tick) / meter.beatTicks / stride) * stride;
        for (let n = first; ; n += stride) {
          const tick = meter.tick + n * meter.beatTicks;
          if (
            tick > high ||
            (nextMeter && tick >= nextMeter.tick) ||
            (nextTempo && tick >= nextTempo.tick)
          )
            break;
          const barOffset = Math.floor(n / meter.beats),
            beat = n - barOffset * meter.beats + 1;
          const timeUs = this.tickToTime(tick);
          if (timeUs < startUs || timeUs > endUs) continue;
          lines.push({
            tick,
            timeUs,
            bar: meter.bar + barOffset,
            beat,
            major: beat === 1,
          });
        }
      }
    }
    return lines.sort((a, b) => a.tick - b.tick);
  }
  /** Decimate only the drawn grid, preserving the exact snap lattice. */
  grid(startUs: number, endUs: number, divisions: number, minGapUs: number) {
    const quantum = this.quantum(divisions);
    const lines = new Map<
      number,
      { tick: number; timeUs: number; major: boolean; subdivision: boolean }
    >();
    for (let i = 0; i < this.segments.length; i++) {
      const segment = this.segments[i],
        next = this.segments[i + 1];
      if ((i > 0 && Math.round(segment.timeUs) > endUs) || (next && next.timeUs <= startUs))
        continue;
      const step =
        quantum * 2 ** Math.max(0, Math.ceil(Math.log2(minGapUs / (quantum * segment.usPerTick))));
      const low = Math.max(i ? segment.tick : -Infinity, this.timeToTick(startUs - 0.5));
      const high = Math.min(next?.tick ?? Infinity, this.timeToTick(endUs + 0.5));
      for (
        let tick = Math.ceil(low / step) * step;
        tick <= high && (!next || tick < next.tick);
        tick += step
      ) {
        const timeUs = this.tickToTime(tick),
          meter = this.meters[this.meterAt(timeUs)];
        if (timeUs < startUs || timeUs > endUs) continue;
        const count = (tick - meter.tick) / meter.beatTicks;
        const subdivision = Math.abs(count - Math.round(count)) > 1e-8;
        lines.set(tick, {
          tick,
          timeUs,
          major: !subdivision && Math.round(count) % meter.beats === 0,
          subdivision,
        });
      }
    }
    // Bar boundaries remain visible even when a meter change is off the snap grid.
    for (const line of this.barMarks(startUs, endUs, minGapUs))
      if (line.major)
        lines.set(line.tick, {
          tick: line.tick,
          timeUs: line.timeUs,
          major: true,
          subdivision: false,
        });
    return [...lines.values()].sort((a, b) => a.tick - b.tick);
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
