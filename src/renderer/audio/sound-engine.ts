import type { Asset, Project, SoundCue, AudioBus } from '../../shared/models';
import { defaultMixer } from '../../shared/models';
import { SoundPlanner, soundBus, type PlaybackMode } from '../../core/sound';
import { PlaybackTake } from '../../core/playback';
import { sameProjectParts } from '../../core/project';
import type { ResourceLease } from '../../core/resources';
import { unwrap } from '../../shared/ipc';
import type { AudioTransport } from './transport';

/** All nodes share the music AudioContext. Every voice owns exactly one source/gain/panner. */
export class SoundEngine {
  private project: Project | null = null;
  private handle = '';
  private planner: SoundPlanner | null = null;
  private future = new Map<number, SoundPlanner>();
  private cycle = 0;
  private emptyTake = new PlaybackTake();
  private timer: ReturnType<typeof setInterval> | undefined;
  private mode: PlaybackMode = 'edit';
  private buffers = new Map<string, ResourceLease<AudioBuffer>>();
  private pending = new Map<string, Promise<void>>();
  private voices = new Set<{
    source: AudioBufferSourceNode;
    gain: GainNode;
    pan: StereoPannerNode;
    token: string;
    when: number;
    atUs: number;
    cycle: number;
    audition: boolean;
  }>();
  private buses = new Map<AudioBus, GainNode>();
  private epoch = 0;
  private wasPlaying = false;
  private position = 0;
  private log: {
    cueId: string;
    assetId: string;
    atUs: number;
    when: number;
    audition: boolean;
    bus: string;
    rate: number;
    cycle: number;
  }[] = [];
  revision = 0;
  beforeSchedule: () => void = () => {};
  constructor(
    private transport: AudioTransport,
    private readonly take: PlaybackTake,
    private notify: (message: string) => void,
  ) {}
  setProject(p: Project, handle: string): void {
    if (p === this.project && handle === this.handle) return;
    const samePlan =
      this.handle === handle &&
      sameProjectParts(this.project, p, ['sounds', 'notes', 'reveals', 'timing', 'layers']);
    if (!samePlan) {
      this.stopAll();
      this.future.clear();
      this.cycle = this.transport.snapshot().cycle;
      this.planner = new SoundPlanner(p);
      this.planner.reset(this.position, this.position === 0);
    }
    if (handle !== this.handle) {
      this.epoch++;
      this.clearBuffers();
      this.position = 0;
      this.planner?.reset(0);
    }
    this.project = p;
    this.handle = handle;
    const wanted = new Set(Object.values(p.sounds).map((c) => c.assetId));
    for (const [id, lease] of this.buffers)
      if (!wanted.has(id)) {
        lease.release();
        this.buffers.delete(id);
      }
    const mix = p.mixer ?? defaultMixer();
    for (const bus of ['hit', 'animation'] as const) {
      const gain = this.buses.get(bus);
      if (gain)
        gain.gain.setTargetAtTime(
          mix[bus].muted ? 0 : mix[bus].gain,
          this.transport.sharedContext.currentTime,
          0.01,
        );
    }
  }
  private bus(id: AudioBus): GainNode {
    let node = this.buses.get(id);
    if (!node) {
      node = this.transport.sharedContext.createGain();
      const mix = (this.project?.mixer ?? defaultMixer())[id];
      node.gain.value = mix.muted ? 0 : mix.gain;
      node.connect(this.transport.sharedContext.destination);
      this.buses.set(id, node);
    }
    return node;
  }
  private clearBuffers(): void {
    for (const lease of this.buffers.values()) lease.release();
    this.buffers.clear();
  }
  async load(asset: Asset): Promise<void> {
    if (this.buffers.has(asset.id)) return;
    const existing = this.pending.get(asset.id);
    if (existing) {
      await existing;
      if (!this.buffers.has(asset.id)) return this.load(asset);
      return;
    }
    const epoch = this.epoch,
      handle = this.handle;
    const task = (async () => {
      const bytes = unwrap(await window.desktop.readAsset({ handle, assetId: asset.id }));
      const lease = await this.transport.decode(asset, bytes);
      if (epoch !== this.epoch || handle !== this.handle) lease.release();
      else {
        this.buffers.set(asset.id, lease);
        this.revision++;
      }
    })();
    this.pending.set(asset.id, task);
    try {
      await task;
    } finally {
      this.pending.delete(asset.id);
    }
  }
  async prepare(): Promise<void> {
    if (!this.project) return;
    const project = this.project,
      epoch = this.epoch;
    const assets = [
      ...new Set(
        Object.values(this.project.sounds)
          .filter((c) => c.enabled !== false)
          .map((c) => c.assetId),
      ),
    ];
    // Two decodes at a time avoid a burst of main-thread/PCM allocations for a large library.
    let i = 0;
    await Promise.all(
      Array.from({ length: Math.min(2, assets.length) }, async () => {
        while (i < assets.length) {
          if (epoch !== this.epoch || project !== this.project) return;
          const id = assets[i++];
          await this.load(project.assets[id]);
        }
      }),
    );
  }
  reset(at: number, includeAt = at === 0): void {
    this.epoch++;
    this.stopAll();
    this.position = at;
    this.wasPlaying = false;
    this.future.clear();
    this.cycle = this.transport.snapshot().cycle;
    this.planner?.reset(at, includeAt);
  }
  pause(at: number): void {
    this.epoch++;
    const advance = this.wasPlaying;
    this.syncPlanner();
    const includeAt = [...this.voices].some(
      (v) =>
        !v.audition &&
        v.cycle === this.cycle &&
        v.atUs === at &&
        v.when > this.transport.sharedContext.currentTime,
    );
    this.stopAll();
    this.position = at;
    this.wasPlaying = false;
    this.future.clear();
    if (advance) this.planner?.pause(at, includeAt);
  }
  retime(at: number): void {
    if (!this.transport.snapshot().playing) {
      this.position = at;
      return;
    }
    const rendered = this.transport.renderPosition();
    const cutoff =
      rendered.timeUs -
      (this.transport.contextTimeAt(rendered.timeUs, rendered.cycle) >
      this.transport.sharedContext.currentTime
        ? 1
        : 0);
    const rewind = (planner: SoundPlanner, cycle: number) =>
      planner.cancelAfter(
        cycle < rendered.cycle ? Infinity : cycle === rendered.cycle ? cutoff : -Infinity,
      );
    if (this.planner) rewind(this.planner, this.cycle);
    for (const [cycle, planner] of this.future) rewind(planner, cycle);
    this.stopPlayback();
    this.position = at;
  }
  update(at: number, playing: boolean, mode: PlaybackMode): void {
    this.mode = mode;
    if (!playing) {
      if (this.wasPlaying) this.pause(at);
      clearInterval(this.timer);
      this.timer = undefined;
      return;
    }
    this.wasPlaying = true;
    this.position = at;
    this.schedule();
    // Audio scheduling has its own bounded lookahead, independent of display refresh.
    this.timer ??= setInterval(() => this.schedule(), 20);
  }
  private syncPlanner(): void {
    const snapshot = this.transport.snapshot();
    if (!this.project) return;
    if (snapshot.cycle !== this.cycle) {
      this.cycle = snapshot.cycle;
      const planned = this.future.get(this.cycle);
      this.planner = planned ?? new SoundPlanner(this.project);
      if (!planned) this.planner.reset(this.transport.loop?.startUs ?? snapshot.timeUs, true);
      for (const cycle of this.future.keys()) if (cycle <= this.cycle) this.future.delete(cycle);
    }
  }
  private schedule(): void {
    this.beforeSchedule();
    const snapshot = this.transport.snapshot();
    if (!snapshot.playing || !this.planner || !this.project) return;
    const context = this.transport.sharedContext,
      loop = this.transport.loop;
    this.syncPlanner();
    const horizon = context.currentTime + 0.1;
    // Device latency can span several short loops: bound by render time, not audible cycle + N.
    const through = this.transport.renderPosition(horizon);
    for (let cycle = this.cycle; cycle <= through.cycle; cycle++) {
      const current = cycle === this.cycle;
      const start = loop?.startUs ?? snapshot.timeUs;
      const end = loop?.endUs ?? snapshot.durationUs + 1;
      if (loop && this.transport.contextTimeAt(end, cycle) <= context.currentTime) continue;
      if (!current && (!loop || this.transport.contextTimeAt(start, cycle) > horizon)) break;
      let planner = current ? this.planner : this.future.get(cycle);
      if (!planner) {
        planner = new SoundPlanner(this.project);
        planner.reset(start, true);
        this.future.set(cycle, planner);
      }
      const at = current ? snapshot.timeUs : start;
      const to = Math.min(end - 1, cycle < through.cycle ? end - 1 : through.timeUs);
      const take = current ? this.take : this.emptyTake;
      for (const event of planner.collect(at, this.mode, take, to)) {
        const when = this.transport.contextTimeAt(event.timeUs, cycle);
        const cue = this.project.sounds[event.cueId];
        // Judgement is timestamped in the audible clock; new live hits naturally lag render time.
        const deadline =
          this.mode === 'playtest' && cue.trigger.kind !== 'timeline'
            ? this.transport.contextTimeAt(snapshot.timeUs, snapshot.cycle)
            : context.currentTime;
        // A blocked UI/audio scheduling thread must not replay a burst of past events.
        if (when < deadline - 0.05) continue;
        const buffer = this.buffers.get(cue.assetId)?.value;
        if (buffer)
          this.voice(
            cue,
            buffer,
            Math.max(context.currentTime, when),
            event.timeUs,
            false,
            event.token,
            cycle,
            loop ? this.transport.contextTimeAt(end, cycle) : undefined,
          );
        else this.notify('音效尚未准备好，请暂停后重新播放');
      }
      if (!loop) break;
    }
  }
  private voice(
    cue: SoundCue,
    buffer: AudioBuffer,
    when: number,
    atUs: number,
    audition: boolean,
    token = cue.id,
    cycle = this.cycle,
    stopAt?: number,
  ): void {
    const context = this.transport.sharedContext,
      source = context.createBufferSource(),
      gain = context.createGain(),
      pan = context.createStereoPanner();
    source.buffer = buffer;
    source.playbackRate.value = audition ? 1 : this.transport.rate;
    gain.gain.value = cue.gain;
    pan.pan.value = cue.pan;
    source.connect(gain);
    gain.connect(pan);
    pan.connect(this.bus(soundBus(cue)));
    const voice = { source, gain, pan, token, cycle, when, atUs, audition };
    this.voices.add(voice);
    const done = () => {
      source.disconnect();
      gain.disconnect();
      pan.disconnect();
      this.voices.delete(voice);
      source.onended = null;
      this.revision++;
    };
    source.onended = done;
    source.start(when);
    if (stopAt !== undefined) source.stop(Math.max(when, stopAt));
    this.log.push({
      cueId: cue.id,
      assetId: cue.assetId,
      atUs,
      when,
      audition,
      bus: soundBus(cue),
      rate: source.playbackRate.value,
      cycle,
    });
    if (this.log.length > 256) this.log.shift();
    this.revision++;
  }
  async audition(asset: Asset, cue?: SoundCue): Promise<void> {
    const epoch = this.epoch;
    await this.load(asset);
    await this.transport.sharedContext.resume();
    if (epoch !== this.epoch) return;
    const buffer = this.buffers.get(asset.id)?.value;
    if (!buffer) return;
    this.voice(
      cue ?? {
        id: 'audition',
        assetId: asset.id,
        trigger: { kind: 'timeline', at: { basis: 'time', timeUs: 0 } },
        delayUs: 0,
        gain: 1,
        pan: 0,
        bus: 'hit',
      },
      buffer,
      this.transport.sharedContext.currentTime,
      this.position,
      true,
    );
  }
  private stopPlayback(): void {
    this.stopVoices(false);
  }
  stopAll(): void {
    this.stopVoices(true);
  }
  private stopVoices(includeAudition: boolean): void {
    for (const v of [...this.voices]) {
      if (!includeAudition && v.audition) continue;
      v.source.onended = null;
      try {
        v.source.stop();
      } catch {
        /* Already ended. */
      }
      v.source.disconnect();
      v.gain.disconnect();
      v.pan.disconnect();
      this.voices.delete(v);
    }
    this.revision++;
  }
  metrics() {
    return {
      voices: this.voices.size,
      buffers: this.buffers.size,
      pending: this.pending.size,
      decodedBytes: [...this.buffers.values()].reduce(
        (n, l) => n + l.value.length * l.value.numberOfChannels * 4,
        0,
      ),
      recent: [...this.log],
    };
  }
  dispose(): void {
    clearInterval(this.timer);
    this.epoch++;
    this.stopAll();
    this.clearBuffers();
    for (const node of this.buses.values()) node.disconnect();
    this.buses.clear();
  }
}
