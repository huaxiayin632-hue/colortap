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
