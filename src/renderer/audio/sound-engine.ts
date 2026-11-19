import type { Asset, Project, SoundCue, AudioBus } from '../../shared/models';
import { defaultMixer } from '../../shared/models';
import { SoundPlanner, soundBus, type PlaybackMode } from '../../core/sound';
import type { PlaybackTake } from '../../core/playback';
import { sameProjectParts } from '../../core/project';
import type { ResourceLease } from '../../core/resources';
import { unwrap } from '../../shared/ipc';
import type { AudioTransport } from './transport';

/** All nodes share the music AudioContext. Every voice owns exactly one source/gain/panner. */
export class SoundEngine {
  private project: Project | null = null;
  private handle = '';
  private planner: SoundPlanner | null = null;
  private buffers = new Map<string, ResourceLease<AudioBuffer>>();
  private pending = new Map<string, Promise<void>>();
  private voices = new Set<{
    source: AudioBufferSourceNode;
    gain: GainNode;
    pan: StereoPannerNode;
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
  }[] = [];
  revision = 0;
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
          const id = assets[i++];
          await this.load(this.project!.assets[id]);
        }
      }),
    );
  }
  reset(at: number): void {
    this.epoch++;
    this.stopAll();
    this.position = at;
    this.wasPlaying = false;
    this.planner?.reset(at);
  }
  pause(at: number): void {
    this.epoch++;
    this.stopAll();
    this.position = at;
    this.wasPlaying = false;
    this.planner?.pause(at);
  }
  update(at: number, playing: boolean, mode: PlaybackMode): void {
    if (!playing) {
      if (this.wasPlaying) this.pause(at);
      return;
    }
    this.wasPlaying = true;
    this.position = at;
    const horizon =
      at + Math.max(100000, ((this.transport.sharedContext.outputLatency ?? 0.02) + 0.05) * 1e6);
    for (const event of this.planner?.collect(at, mode, this.take, horizon) ?? []) {
      const cue = this.project!.sounds[event.cueId],
        buffer = this.buffers.get(cue.assetId)?.value;
      if (buffer)
        this.voice(
          cue,
          buffer,
          Math.max(
            this.transport.sharedContext.currentTime,
            this.transport.contextTimeAt(event.timeUs),
          ),
          event.timeUs,
          false,
        );
      else this.notify('音效尚未准备好，请暂停后重新播放');
    }
  }
  private voice(
    cue: SoundCue,
    buffer: AudioBuffer,
    when: number,
    atUs: number,
    audition: boolean,
  ): void {
    const context = this.transport.sharedContext,
      source = context.createBufferSource(),
      gain = context.createGain(),
      pan = context.createStereoPanner();
    source.buffer = buffer;
    gain.gain.value = cue.gain;
    pan.pan.value = cue.pan;
    source.connect(gain);
    gain.connect(pan);
    pan.connect(this.bus(soundBus(cue)));
    const voice = { source, gain, pan };
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
    this.log.push({
      cueId: cue.id,
      assetId: cue.assetId,
      atUs,
      when,
      audition,
      bus: soundBus(cue),
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
  stopAll(): void {
    for (const v of [...this.voices]) {
      v.source.onended = null;
      try {
        v.source.stop();
      } catch {
        /* Already ended. */
      }
      v.source.disconnect();
      v.gain.disconnect();
      v.pan.disconnect();
    }
    this.voices.clear();
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
    this.epoch++;
    this.stopAll();
    this.clearBuffers();
    for (const node of this.buses.values()) node.disconnect();
    this.buses.clear();
  }
}
