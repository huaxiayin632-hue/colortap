import { describe, expect, it } from 'vitest';
import { AnchoredClock, formatTime, TempoMap } from '../src/core/timing';
import { createProject } from '../src/shared/models';

describe('TempoMap', () => {
  it('converts quarter-note ticks and preserves the beat-zero offset', () => {
    const timing = createProject().timing;
    timing.beatZeroUs = 250000;
    const tempo = new TempoMap(timing);
    expect(tempo.tickToTime(0)).toBe(250000);
    expect(tempo.tickToTime(960)).toBe(750000);
    expect(tempo.timeToTick(0)).toBe(-480);
  });
  it('integrates BPM changes instead of using the current BPM for earlier beats', () => {
    const timing = createProject().timing;
    timing.points.push({ id: crypto.randomUUID(), tick: 3840, bpm: 240, meter: [4, 4] });
    const tempo = new TempoMap(timing);
    expect(tempo.tickToTime(3840)).toBe(2000000);
    expect(tempo.tickToTime(4800)).toBe(2250000);
    expect(tempo.timeToTick(2250000)).toBe(4800);
  });
  it('does not accumulate rounded beat durations on long fractional-BPM songs', () => {
    const timing = createProject().timing;
    timing.points[0].bpm = 137.3;
    const tempo = new TempoMap(timing);
    const tick = 960 * 137.3 * 60;
    expect(Math.abs(tempo.tickToTime(tick) - 3600000000)).toBeLessThanOrEqual(1);
    expect(tempo.timeToTick(tempo.tickToTime(tick))).toBeCloseTo(tick, 3);
  });
  it('snaps in beat space, including at a tempo boundary', () => {
    const timing = createProject().timing;
    timing.points.push({ id: crypto.randomUUID(), tick: 3840, bpm: 240, meter: [4, 4] });
    const tempo = new TempoMap(timing);
    expect(tempo.snap(132000, 4)).toBe(125000);
    expect(tempo.snap(2070000, 4)).toBe(2062500);
  });
  it('resolves absolute-time anchors independently of BPM', () => {
    expect(new TempoMap(createProject().timing).resolve({ basis: 'time', timeUs: 3456789 })).toBe(
      3456789,
    );
  });
  it.each([0, -20, NaN, Infinity])('rejects invalid BPM %s', (bpm) => {
    const timing = createProject().timing;
    timing.points[0].bpm = bpm;
    expect(() => new TempoMap(timing)).toThrow();
  });
  it('rejects duplicate tempo ticks and unsupported subdivisions', () => {
    const timing = createProject().timing;
    timing.points.push({ ...timing.points[0], id: crypto.randomUUID() });
    expect(() => new TempoMap(timing)).toThrow();
    expect(() => new TempoMap(createProject().timing).snap(0, 7)).toThrow();
  });
});

describe('meter-aware timeline navigation', () => {
  function map(meter: [number, number] = [4, 4], offset = 0, bpm = 120) {
    const timing = createProject().timing;
    timing.beatZeroUs = offset;
    Object.assign(timing.points[0], { meter, bpm });
    return timing;
  }
  it.each([
    [3, 4, 2880],
    [6, 8, 2880],
    [7, 8, 3360],
    [5, 16, 1200],
  ])('uses numerator and denominator for %s/%s measure boundaries', (n, d, length) => {
    const tempo = new TempoMap(map([n, d]));
    expect(tempo.barBeat(tempo.tickToTime(3840 / d))).toEqual({ bar: 1, beat: 2 });
    expect(tempo.barBeat(tempo.tickToTime(length))).toEqual({ bar: 2, beat: 1 });
    expect(tempo.nextBar(0, 1)).toBe(tempo.tickToTime(length));
    expect(tempo.nextBar(tempo.tickToTime(length), -1)).toBe(0);
    expect(
      tempo
        .grid(0, tempo.tickToTime(length * 2), 3, 0)
        .filter((l) => l.major)
        .map((l) => l.tick),
    ).toEqual([0, length, length * 2]);
  });
  it('extends the first meter before beat zero, including bar zero and negative bars', () => {
    const tempo = new TempoMap(map([3, 4], 2000000));
    expect(tempo.barBeat(0)).toEqual({ bar: -1, beat: 3 });
    expect(tempo.barBeat(500000)).toEqual({ bar: 0, beat: 1 });
    expect(tempo.barBeat(2000000)).toEqual({ bar: 1, beat: 1 });
    expect(tempo.nextBar(0, 1)).toBe(500000);
    expect(tempo.grid(0, 1500000, 3, 0).some((l) => l.tick === -2880 && l.major)).toBe(true);
    expect(tempo.barMarks(0, 1500000, 0).map((l) => `${l.bar}:${l.beat}`)).toEqual([
      '-1:3',
      '0:1',
      '0:2',
      '0:3',
    ]);
  });
  it('keeps bars through BPM-only changes and starts a new bar at a meter change', () => {
    const timing = map();
    timing.points.push(
      { id: 'tempo', tick: 960, bpm: 137.3, meter: [4, 4] },
      { id: 'meter', tick: 4800, bpm: 137.3, meter: [6, 8] },
      { id: 'tempo2', tick: 5760, bpm: 190, meter: [6, 8] },
    );
    const tempo = new TempoMap(timing),
      changed = tempo.tickToTime(4800);
    expect(tempo.barBeat(tempo.tickToTime(3840))).toEqual({ bar: 2, beat: 1 });
    expect(tempo.barBeat(changed)).toEqual({ bar: 3, beat: 1 });
    expect(tempo.nextBar(changed, -1)).toBe(tempo.tickToTime(3840));
    expect(tempo.nextBar(tempo.tickToTime(3840), 1)).toBe(changed);
    expect(tempo.nextBar(changed, 1)).toBe(tempo.tickToTime(7680));
    expect(tempo.barBeat(tempo.tickToTime(5760))).toEqual({ bar: 3, beat: 3 });
  });
  it.each([3, 6, 12])(
    'steps on and off the 1/%s grid without sticking after microsecond rounding',
    (divisions) => {
      const timing = map([4, 4], -123456, 137.3);
      timing.points.push({ id: 'tempo', tick: 3840, bpm: 193.7, meter: [4, 4] });
      const tempo = new TempoMap(timing),
        q = 960 / divisions;
      for (const index of [-10, 0, 1, 2, 47, 48, 49, 100, 40000]) {
        const here = tempo.tickToTime(index * q),
          previous = tempo.tickToTime((index - 1) * q),
          next = tempo.tickToTime((index + 1) * q);
        expect(tempo.nextGrid(here, divisions, -1)).toBe(previous);
        expect(tempo.nextGrid(here, divisions, 1)).toBe(next);
        expect(tempo.nextGrid(here + 1, divisions, -1)).toBe(here);
        expect(tempo.nextGrid(here - 1, divisions, 1)).toBe(here);
        expect(tempo.snap(here, divisions)).toBe(here);
      }
    },
  );
  it('treats rounded bar boundaries as exact in both labels and navigation', () => {
    const tempo = new TempoMap(map([7, 8], 321987, 137.3));
    for (const i of [-20, -1, 0, 1, 17, 10000]) {
      const time = tempo.tickToTime(i * 3360);
      expect(tempo.barBeat(time)).toEqual({ bar: i + 1, beat: 1 });
      expect(tempo.nextBar(time, 1)).toBe(tempo.tickToTime((i + 1) * 3360));
      expect(tempo.nextBar(time, -1)).toBe(tempo.tickToTime((i - 1) * 3360));
      expect(tempo.nextBar(time + 1, -1)).toBe(time);
      expect(tempo.nextBar(time - 1, 1)).toBe(time);
    }
  });
  it('counts non-binary meter denominators without floating point phantom bars', () => {
    const timing = map([1, 13]);
    timing.points.push({ id: 'change', tick: 3840, bpm: 120, meter: [4, 4] });
    const tempo = new TempoMap(timing);
    expect(tempo.barBeat(2000000)).toEqual({ bar: 14, beat: 1 });
    expect(tempo.nextBar(2000000, -1)).toBe(1846154);
  });
  it.each([123.45, 137.3])(
    'keeps rounded measure marks at both inclusive viewport edges at %s BPM',
    (bpm) => {
      const tempo = new TempoMap(map([4, 4], 250000, bpm));
      const boundary = tempo.tickToTime(3840);
      for (const [start, end] of [
        [boundary, boundary],
        [boundary, boundary + 1],
        [boundary - 1, boundary],
      ]) {
        expect(tempo.barMarks(start, end, 0).map((line) => line.tick)).toEqual([3840]);
        expect(tempo.grid(start, end, 12, 0).map((line) => line.tick)).toEqual([3840]);
      }
    },
  );
  it('bounds visual grid generation at wide zoom without changing snap positions', () => {
    const tempo = new TempoMap(map([6, 8], 250000, 137.3));
    expect(tempo.grid(0, 3600e6, 12, 1e6).length).toBeLessThan(8000);
    expect(tempo.barMarks(0, 3600e6, 10e6).length).toBeLessThan(400);
    expect(tempo.snap(400000, 12)).toBe(tempo.tickToTime(320));
  });
});

describe('AnchoredClock', () => {
  it('derives position directly from the audio clock, without frame stepping', () => {
    const clock = new AnchoredClock();
    clock.reset(30000000);
    clock.start(5);
    expect(clock.positionAt(4.9)).toBe(0);
    expect(clock.positionAt(7.125)).toBe(2125000);
    expect(clock.positionAt(50)).toBe(30000000);
  });
  it('freezes on pause and resumes from precisely that position', () => {
    const clock = new AnchoredClock();
    clock.reset(30000000);
    clock.start(1);
    clock.pause(2.5);
    expect(clock.positionAt(200)).toBe(1500000);
    clock.start(300);
    expect(clock.positionAt(301)).toBe(2500000);
  });
  it('seeks without carrying over elapsed time from the old anchor', () => {
    const clock = new AnchoredClock();
    clock.reset(10000000);
    clock.start(0);
    clock.seek(4000000, 20);
    expect(clock.positionAt(20.5)).toBe(4500000);
    clock.pause(20.5);
    clock.seek(-1, 21);
    expect(clock.positionAt(999)).toBe(0);
    clock.seek(99000000, 21);
    expect(clock.positionAt(999)).toBe(10000000);
  });
  it('reset removes the previous song and playing state', () => {
    const clock = new AnchoredClock();
    clock.reset(10000000);
    clock.start(0);
    clock.reset();
    expect(clock.playing).toBe(false);
    expect(clock.positionAt(100)).toBe(0);
  });
  it('formats time without rounding the cursor into the next second', () => {
    expect(formatTime(59999999)).toBe('00:59.999');
    expect(formatTime(60000000)).toBe('01:00.000');
  });
});
