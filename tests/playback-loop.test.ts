import { afterEach, describe, expect, it, vi } from 'vitest';
import { AnchoredClock } from '../src/core/timing';
import { PlaySession } from '../src/core/judgement';
import { PlaybackTake } from '../src/core/playback';
import { createProject, type Asset, type SoundCue } from '../src/shared/models';
import { identityTransform } from '../src/core/layers';
import { AudioTransport } from '../src/renderer/audio/transport';
import { SoundEngine } from '../src/renderer/audio/sound-engine';
import { ResourcePool } from '../src/core/resources';
import { createChart } from '../src/renderer/chart/controller';

class Context {
  static current: Context;
  currentTime = 0;
  state = 'running';
  outputLatency = 0;
  getOutputTimestamp() {
    return {
      contextTime: this.currentTime - this.outputLatency,
      performanceTime: Math.max(1, performance.now()),
    };
  }
  destination = {};
  sources: any[] = [];
  constructor() {
    Context.current = this;
  }
  resume = async () => {};
  close = async () => {};
  createGain() {
    return { gain: { value: 1, setTargetAtTime: vi.fn() }, connect: vi.fn(), disconnect: vi.fn() };
  }
  createStereoPanner() {
    return { pan: { value: 0 }, connect: vi.fn(), disconnect: vi.fn() };
  }
  createBufferSource() {
    const s = {
      buffer: null,
      loop: false,
      loopStart: 0,
      loopEnd: 0,
      playbackRate: { value: 1, setValueAtTime: vi.fn() },
      connect: vi.fn(),
      disconnect: vi.fn(),
      start: vi.fn(),
      stop: vi.fn(),
      onended: null,
    };
    this.sources.push(s);
    return s;
  }
}
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
function transport() {
  vi.stubGlobal('AudioContext', Context);
  const t = new AudioTransport(new ResourcePool());
  t.adopt({
    assetId: 'music',
    metadata: { durationUs: 10e6, sampleRate: 48000, channels: 1 },
    lease: { value: { duration: 10 } as AudioBuffer, release: vi.fn() } as any,
  });
  return t;
}
describe('rate and native-loop audio clock', () => {
  it.each([0.25, 0.5, 0.75, 1])('%sx shares forward and inverse mappings', (rate) => {
    const c = new AnchoredClock();
    c.reset(100e6);
    c.seek(1e6, 10);
    c.setRate(rate, 10);
    c.start(10);
    expect(c.positionAt(12)).toBe(1e6 + 2e6 * rate);
    expect(c.contextTimeAt(1e6 + 2e6 * rate)).toBe(12);
    c.pause(12);
    c.setRate(1, 20);
    expect(c.positionAt(50)).toBe(1e6 + 2e6 * rate);
  });
  it('keeps the old output-delay projection while a new rate is already rendering', () => {
    const c = new AnchoredClock();
    c.reset(10e6);
    c.start(0);
    c.setRate(0.25, 1);
    expect(c.positionAt(0.98)).toBe(980000);
    expect(c.positionAt(1)).toBe(1000000);
    expect(c.positionAt(3)).toBe(1500000);
    expect(c.contextTimeAt(1500000)).toBe(3);
  });
  it('wraps from an inside start with overshoot, without accumulating frame drift', () => {
    const c = new AnchoredClock();
    c.reset(100e6);
    c.seek(1200000, 0);
    c.setLoop({ startUs: 1000000, endUs: 1300000 }, 0);
    c.setRate(0.75, 0);
    c.start(1);
    expect(c.projection(1 + 100000 / 750000)).toEqual({ timeUs: 1000000, cycle: 1 });
    const at = 1 + (100000 + 10000 * 300000 + 12345) / 750000;
    expect(c.projection(at)).toEqual({ timeUs: 1012345, cycle: 10001 });
    expect(c.contextTimeAt(1012345, 10001)).toBeCloseTo(at, 9);
    c.pause(at);
    c.start(at + 3);
    expect(c.projection(at + 3)).toEqual({ timeUs: 1012345, cycle: 10001 });
  });
  it('rejects zero, reversed, too-short and out-of-song loops', () => {
    const c = new AnchoredClock();
    c.reset(1000000);
    for (const loop of [
      { startUs: 0, endUs: 0 },
      { startUs: 100, endUs: 99 },
      { startUs: 0, endUs: 99999 },
      { startUs: -1, endUs: 200000 },
      { startUs: 0, endUs: 1000001 },
    ])
      expect(() => c.setLoop(loop, 0)).toThrow();
  });
  it('keeps the scheduled start when speed changes during pre-roll', async () => {
    const t = transport();
    t.seek(1e6);
    await t.play();
    Context.current.currentTime = 0.01;
    t.setRate(0.5);
    Context.current.currentTime = 0.02;
    expect(t.snapshot().timeUs).toBe(1e6);
    Context.current.currentTime = 0.22;
    expect(t.snapshot().timeUs).toBe(1.1e6);
    await t.dispose();
  });
  it('honours seek and loop destinations while output is 100ms behind rendering', async () => {
    const t = transport();
    await t.play();
    const ctx = Context.current;
    ctx.currentTime = 2;
    ctx.outputLatency = 0.1;
    t.seek(5e6);
    expect(ctx.sources.at(-1).start).toHaveBeenCalledWith(2.02, 5);
    expect(t.snapshot().timeUs).toBe(5e6);
    t.setLoop({ startUs: 1e6, endUs: 2e6 }, 1e6);
    expect(ctx.sources.at(-1).start).toHaveBeenCalledWith(2.02, 1);
    expect(t.snapshot().timeUs).toBe(1e6);
    await t.dispose();
  });
  it('programs native looping and rate changes on the same source, independent of UI updates', async () => {
    const t = transport();
    t.setLoop({ startUs: 1e6, endUs: 2e6 }, 1e6);
    await t.play();
    const ctx = Context.current,
      source = ctx.sources[0];
    expect(source.loop).toBe(true);
    expect(source.loopStart).toBe(1);
    expect(source.loopEnd).toBe(2);
    ctx.currentTime = 10.52;
    expect(t.snapshot().cycle).toBe(10);
    expect(t.snapshot().timeUs).toBe(1500000);
    t.setRate(0.5);
    expect(source.playbackRate.setValueAtTime).toHaveBeenCalledWith(0.5, 10.52);
    expect(ctx.sources).toHaveLength(1);
    ctx.currentTime = 11.02;
    expect(t.snapshot().timeUs).toBe(1750000);
    t.unload();
    expect(t.snapshot().rate).toBe(1);
    expect(t.loop).toBeNull();
    await t.dispose();
  });
});

describe('sound scheduling across rates and rounds', () => {
  async function setup() {
    vi.useFakeTimers();
    const t = transport();
    const p = createProject(),
      take = new PlaybackTake();
    const asset = {
      id: crypto.randomUUID(),
      kind: 'audio',
      sha256: 'a',
      originalName: 'tone.wav',
    } as Asset;
    p.assets[asset.id] = asset;
    for (const [id, timeUs] of [
      ['A', 1000000],
      ['inside', 1050000],
      ['B', 1100000],
    ] as const) {
      p.sounds[id] = {
        id,
        assetId: asset.id,
        trigger: { kind: 'timeline', at: { basis: 'time', timeUs } },
        delayUs: 0,
        gain: 1,
        pan: 0,
        bus: 'hit',
      } as SoundCue;
    }
    vi.stubGlobal('window', {
      desktop: { readAsset: async () => ({ ok: true, value: new ArrayBuffer(1) }) },
    });
    vi.spyOn(t, 'decode').mockResolvedValue({
      value: { duration: 1, length: 48000, numberOfChannels: 1 } as AudioBuffer,
      release: vi.fn(),
    } as any);
    const e = new SoundEngine(t, take, () => {});
    e.setProject(p, 'handle');
    await e.prepare();
    t.setLoop({ startUs: 1000000, endUs: 1100000 }, 1000000);
    e.reset(1000000, true);
    await t.play();
    return { t, e, take, asset };
  }
  it('schedules A once per audio round, excludes B and stops each tail exactly at B', async () => {
    const { t, e } = await setup();
    e.update(t.snapshot().timeUs, true, 'edit');
    const ctx = Context.current;
    expect(e.metrics().recent.filter((v) => v.cueId === 'A' && v.cycle === 0)).toHaveLength(1);
    expect(e.metrics().recent.some((v) => v.cueId === 'B')).toBe(false);
    const voice = ctx.sources[1];
    expect(voice.start).toHaveBeenCalledWith(0.02);
    expect(voice.stop.mock.calls[0][0]).toBeCloseTo(0.12, 9);
    ctx.currentTime = 0.095;
    e.update(t.snapshot().timeUs, true, 'edit');
    const next = e.metrics().recent.find((v) => v.cueId === 'A' && v.cycle === 1)!;
    expect(next.when).toBeCloseTo(0.12, 9);
    ctx.currentTime = 0.14;
    e.update(t.snapshot().timeUs, true, 'edit');
    expect(e.metrics().recent.filter((v) => v.cueId === 'A' && v.cycle === 1)).toHaveLength(1);
    e.dispose();
    await t.dispose();
  });
  it('re-arms future sounds at a new rate without replaying started events; audition stays original speed', async () => {
    const { t, e, asset } = await setup();
    e.update(t.snapshot().timeUs, true, 'edit');
    Context.current.currentTime = 0.04;
    e.retime(t.snapshot().timeUs);
    t.setRate(0.5);
    e.update(t.snapshot().timeUs, true, 'edit');
    const a = e.metrics().recent.filter((v) => v.cueId === 'A' && v.cycle === 0);
    expect(a).toHaveLength(1);
    const inside = e.metrics().recent.filter((v) => v.cueId === 'inside' && v.cycle === 0);
    expect(inside.at(-1)!.rate).toBe(0.5);
    expect(inside.at(-1)!.when).toBeCloseTo(0.1, 8);
    await e.audition(asset);
    expect(e.metrics().recent.at(-1)!.rate).toBe(1);
    e.dispose();
    await t.dispose();
  });
  it('does not catch up old rounds after a long main-thread stall', async () => {
    const { t, e } = await setup();
    e.update(t.snapshot().timeUs, true, 'edit');
    const count = e.metrics().recent.length;
    Context.current.currentTime = 5.04;
    e.update(t.snapshot().timeUs, true, 'edit');
    expect(
      e
        .metrics()
        .recent.slice(count)
        .every((v) => v.cycle >= 50),
    ).toBe(true);
    expect(e.metrics().recent.length - count).toBeLessThan(8);
    e.dispose();
    await t.dispose();
  });
  it.each(['rate', 'pause'])(
    're-arms unplayed A when %s interrupts the pre-roll',
    async (action) => {
      const { t, e } = await setup();
      e.update(t.snapshot().timeUs, true, 'edit');
      const ctx = Context.current,
        oldVoice = ctx.sources[1];
      ctx.currentTime = 0.01;
      if (action === 'rate') {
        e.retime(t.snapshot().timeUs);
        t.setRate(0.5);
      } else {
        t.pause();
        e.pause(t.snapshot().timeUs);
        ctx.currentTime = 0.5;
        await t.play();
      }
      e.update(t.snapshot().timeUs, true, 'edit');
      expect(oldVoice.stop).toHaveBeenLastCalledWith();
      const voices = e.metrics().recent.filter((v) => v.cueId === 'A' && v.cycle === 0);
      expect(voices).toHaveLength(2);
      expect(voices.at(-1)!.when).toBeCloseTo(action === 'rate' ? 0.02 : 0.52, 8);
      e.dispose();
      await t.dispose();
    },
  );
  it('keeps the current round planner when pausing before the scheduling timer observes a wrap', async () => {
    const { t, e } = await setup();
    e.update(t.snapshot().timeUs, true, 'edit');
    Context.current.currentTime = 0.09;
    e.update(t.snapshot().timeUs, true, 'edit');
    Context.current.currentTime = 0.14;
    t.pause();
    e.pause(t.snapshot().timeUs);
    Context.current.currentTime = 1;
    await t.play();
    e.update(t.snapshot().timeUs, true, 'edit');
    expect(e.metrics().recent.filter((v) => v.cueId === 'A' && v.cycle === 1)).toHaveLength(1);
    e.dispose();
    await t.dispose();
  });
  it('does not consume unplayed A on repeated pause, help or blur', async () => {
    const { t, e } = await setup();
    t.pause();
    e.pause(1e6);
    e.pause(1e6);
    await t.play();
    e.update(t.snapshot().timeUs, true, 'edit');
    const first = e.metrics().recent.filter((v) => v.cueId === 'A' && v.cycle === 0);
    expect(first).toHaveLength(1);
    Context.current.currentTime = 0.01;
    t.pause();
    e.pause(t.snapshot().timeUs);
    e.pause(t.snapshot().timeUs);
    Context.current.currentTime = 0.5;
    await t.play();
    e.update(t.snapshot().timeUs, true, 'edit');
    expect(e.metrics().recent.filter((v) => v.cueId === 'A' && v.cycle === 0)).toHaveLength(2);
    e.dispose();
    await t.dispose();
  });
  it('does not replay the next round A on retime when audio renders ahead of output', async () => {
    const { t, e } = await setup();
    const ctx = Context.current;
    ctx.outputLatency = 0.1;
    e.update(t.snapshot().timeUs, true, 'edit');
    ctx.currentTime = 0.13;
    e.update(t.snapshot().timeUs, true, 'edit');
    expect(t.snapshot().cycle).toBe(0);
    expect(t.renderPosition().cycle).toBe(1);
    const before = e.metrics().recent.filter((v) => v.cueId === 'A' && v.cycle === 1);
    expect(before).toHaveLength(1);
    e.retime(t.snapshot().timeUs);
    t.setRate(0.5);
    expect(t.contextTimeAt(1e6, 1)).toBeCloseTo(0.12, 8);
    e.update(t.snapshot().timeUs, true, 'edit');
    expect(e.metrics().recent.filter((v) => v.cueId === 'A' && v.cycle === 1)).toHaveLength(1);
    e.dispose();
    await t.dispose();
  });
  it('continues short-loop sounds when device latency spans more than four rounds', async () => {
    const { t, e } = await setup();
    Context.current.outputLatency = 0.5;
    for (let i = 0; i < 100; i++) {
      Context.current.currentTime = i * 0.02;
      e.update(t.snapshot().timeUs, true, 'edit');
    }
    const rounds = e
      .metrics()
      .recent.filter((v) => v.cueId === 'A')
      .map((v) => v.cycle);
    expect(rounds).toContain(19);
    expect(new Set(rounds).size).toBe(rounds.length);
    e.dispose();
    await t.dispose();
  });
  it('still sounds a new live hit on a high-latency output device', async () => {
    const { t, e, take, asset } = await setup();
    const p = createProject();
    p.assets[asset.id] = asset;
    p.notes.hit = {
      id: 'hit',
      kind: 'circle',
      at: { basis: 'time', timeUs: 1e6 },
      position: { x: 0, y: 0 },
      radius: 24,
    };
    p.sounds.hit = {
      id: 'hit',
      assetId: asset.id,
      trigger: { kind: 'note', noteId: 'hit', event: 'hit' },
      delayUs: 0,
      gain: 1,
      pan: 0,
    };
    t.setLoop(null, 0);
    e.setProject(p, 'handle');
    await e.prepare();
    e.reset(0, true);
    Context.current.currentTime = 1.13;
    Context.current.outputLatency = 0.1;
    const at = t.snapshot().timeUs;
    take.accept({ kind: 'session-reset', runId: 'new', timeUs: 0 });
    take.accept({ kind: 'circle-hit', runId: 'new', timeUs: at, noteId: 'hit', grade: 'perfect' });
    e.update(at, true, 'playtest');
    expect(e.metrics().recent.filter((v) => v.cueId === 'hit')).toHaveLength(1);
    e.dispose();
    await t.dispose();
  });
});

describe('loop judgement evidence', () => {
  it('updates pending range restrictions without deleting completed evidence', () => {
    const p = createProject();
    for (const [id, timeUs] of [
      ['inside', 1e6],
      ['outside', 3e6],
    ] as const)
      p.notes[id] = {
        id,
        kind: 'circle',
        at: { basis: 'time', timeUs },
        position: { x: 0, y: 0 },
        radius: 24,
      };
    const run = new PlaySession(p, 1e6, undefined, undefined, undefined, {
      startUs: 1e6,
      endUs: 2e6,
    });
    run.input(1e6, { x: 0, y: 0 }, true, true);
    expect(run.snapshot().results.outside.status).toBe('skipped');
    run.setRange();
    run.input(3e6, { x: 0, y: 0 }, true, true);
    expect(run.snapshot().counts.perfect).toBe(2);
  });
  it.each(['input', 'setPointer', 'release'] as const)(
    'synchronizes a boundary before %s accesses the session',
    (action) => {
      const p = createProject();
      p.notes.a = {
        id: 'a',
        kind: 'circle',
        at: { basis: 'time', timeUs: 1e6 },
        position: { x: 0, y: 0 },
        radius: 24,
      };
      let boundary = false;
      const chart = createChart({
        project: () => p,
        loop: () => ({ startUs: 1e6, endUs: 2e6 }),
        time: () => {
          if (boundary) {
            boundary = false;
            chart.update(2e6);
            chart.reset(1e6, 'loop');
          }
          return 1e6;
        },
        playing: () => true,
        pause() {},
        seek() {},
        async play() {},
        commit: () => false,
        selectLayer() {},
        notify() {},
      });
      chart.setMode('playtest');
      chart.setPointer({ x: 0, y: 0 });
      const old = chart.runtime.value!.runId;
      boundary = true;
      expect(() =>
        action === 'input'
          ? chart.input('KeyZ', true)
          : action === 'setPointer'
            ? chart.setPointer({ x: 0, y: 0 })
            : chart.release(),
      ).not.toThrow();
      expect(chart.runtime.value!.runId).not.toBe(old);
      if (action === 'input') expect(chart.runtime.value!.counts.perfect).toBe(1);
      chart.dispose();
    },
  );
  it('clears prior take and held state; excludes a head before A and allows exact-B completion only for a played head', () => {
    const p = createProject(),
      take = new PlaybackTake();
    for (const [id, start, duration] of [
      ['crossA', 0, 1500000],
      ['exact', 1000000, 1000000],
      ['crossB', 1000000, 1500000],
    ] as const) {
      const pathId = crypto.randomUUID();
      p.paths[pathId] = {
        id: pathId,
        name: id,
        closed: false,
        defaultWidth: 1,
        nodes: [
          {
            id: crypto.randomUUID(),
            point: { x: 0, y: 0 },
            handleIn: { x: 0, y: 0 },
            handleOut: { x: 0, y: 0 },
            mode: 'corner',
          },
          {
            id: crypto.randomUUID(),
            point: { x: 1, y: 0 },
            handleIn: { x: 0, y: 0 },
            handleOut: { x: 0, y: 0 },
            mode: 'corner',
          },
        ],
      };
      p.notes[id] = {
        id,
        kind: 'slider',
        at: { basis: 'time', timeUs: start },
        duration: { basis: 'time', durationUs: duration },
        path: { pathId, transform: identityTransform() },
        headRadius: 24,
        followRadius: 100,
      };
    }
    const run = () =>
      new PlaySession(p, 1e6, (e) => take.accept(e), undefined, take.recordTrack, {
        startUs: 1e6,
        endUs: 2e6,
      });
    const one = run();
    expect(one.snapshot().results.crossA.status).toBe('skipped');
    one.input(1e6, { x: 0, y: 0 }, true, true);
    one.advance(2e6);
    expect(one.snapshot().results.exact.status).toBe('complete');
    expect(one.snapshot().results.crossB.status).not.toBe('complete');
    expect(take.events.length).toBeGreaterThan(0);
    const two = run();
    expect(take.events).toHaveLength(0);
    two.advance(1100001);
    expect(two.snapshot().results.exact.status).toBe('failed');
  });
});
