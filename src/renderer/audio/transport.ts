import { AnchoredClock } from '../../core/timing';
import type { Asset } from '../../shared/models';
import { ResourcePool, type ResourceLease } from '../../core/resources';

export interface PreparedMusic {
  assetId: string;
  lease: ResourceLease<AudioBuffer>;
  metadata: { durationUs: number; sampleRate: number; channels: number };
}

export class AudioTransport {
  private context: AudioContext | null = null;
  private gain: GainNode | null = null;
  private source: AudioBufferSourceNode | null = null;
  private music: PreparedMusic | null = null;
  private readonly clock = new AnchoredClock();
  private level = 0.8;
  private generation = 0;
  private anchor = { contextSeconds: 0, musicUs: 0 };
  constructor(private readonly resources: ResourcePool) {}
  get buffer(): AudioBuffer | null {
    return this.music?.lease.value ?? null;
  }
  get assetId(): string | null {
    return this.music?.assetId ?? null;
  }
  get ready(): boolean {
    return this.music !== null;
  }
  private audioContext(): AudioContext {
    if (!this.context) {
      this.context = new AudioContext({ latencyHint: 'interactive' });
      this.gain = this.context.createGain();
      this.gain.gain.value = this.level;
      this.gain.connect(this.context.destination);
    }
    return this.context;
  }
  get sharedContext(): AudioContext {
    return this.audioContext();
  }
  contextTimeAt(musicUs: number): number {
    return this.anchor.contextSeconds + (musicUs - this.anchor.musicUs) / 1_000_000;
  }
  async decode(asset: Asset, bytes: ArrayBuffer): Promise<ResourceLease<AudioBuffer>> {
    const context = this.audioContext();
    return this.resources.acquire(
      `audio:${asset.id}:${asset.sha256}`,
      'decoded-audio',
      async () => {
        const buffer = await context.decodeAudioData(bytes);
        return { value: buffer, bytes: buffer.length * buffer.numberOfChannels * 4 };
      },
    );
  }
  // Convert the output device clock into the same AudioContext time domain as source.start().
  private outputSeconds(): number {
    const context = this.context;
    if (!context) return 0;
    const stamp = context.getOutputTimestamp?.();
    if (
      context.state === 'running' &&
      stamp &&
      typeof stamp.performanceTime === 'number' &&
      stamp.performanceTime > 0 &&
      typeof stamp.contextTime === 'number'
    ) {
      return Math.min(
        context.currentTime,
        stamp.contextTime + Math.max(0, performance.now() - stamp.performanceTime) / 1000,
      );
    }
    return context.currentTime;
  }
  async prepare(asset: Asset, bytes: ArrayBuffer): Promise<PreparedMusic> {
    const context = this.audioContext();
    let lease: ResourceLease<AudioBuffer>;
    try {
      lease = await this.resources.acquire(
        `audio:${asset.id}:${asset.sha256}`,
        'decoded-audio',
        async () => {
          const buffer = await context.decodeAudioData(bytes);
          return {
            value: buffer,
            bytes: buffer.length * buffer.numberOfChannels * Float32Array.BYTES_PER_ELEMENT,
          };
        },
      );
    } catch {
      throw new Error(
        `无法解码「${asset.originalName}」。请选择有效的 WAV、MP3、OGG，或先转换为 WAV。原有工程和音乐已保留。`,
      );
    }
    const buffer = lease.value;
    return {
      assetId: asset.id,
      lease,
      metadata: {
        durationUs: Math.round(buffer.duration * 1_000_000),
        sampleRate: buffer.sampleRate,
        channels: buffer.numberOfChannels,
      },
    };
  }
  adopt(prepared: PreparedMusic): void {
    this.unload();
    this.music = prepared;
    this.clock.reset(prepared.metadata.durationUs);
  }
  setGain(value: number): void {
    this.level = Math.max(0, Math.min(1, value));
    if (this.gain && this.context)
      this.gain.gain.setTargetAtTime(this.level, this.context.currentTime, 0.01);
  }
  async play(): Promise<void> {
    if (!this.music || this.clock.playing) return;
    const generation = this.generation;
    const context = this.audioContext();
    await context.resume();
    if (generation !== this.generation || !this.music || this.clock.playing) return;
    if (this.clock.positionAt(this.outputSeconds()) >= this.clock.durationUs)
      this.clock.seek(0, context.currentTime);
    this.startSource();
  }
  private startSource(): void {
    if (!this.music || !this.context || !this.gain) return;
    const positionUs = this.clock.positionAt(this.outputSeconds());
    this.stopSource();
    const startsAt = this.context.currentTime + 0.02;
    this.anchor = { contextSeconds: startsAt, musicUs: positionUs };
    const source = this.context.createBufferSource();
    source.buffer = this.music.lease.value;
    source.connect(this.gain);
    this.clock.seek(positionUs, startsAt);
    this.clock.start(startsAt);
    source.start(startsAt, positionUs / 1_000_000);
    this.source = source;
  }
  private stopSource(): void {
    if (this.source) {
      try {
        this.source.stop();
      } catch {
        /* Source may already have reached its end. */
      }
      this.source.disconnect();
      this.source = null;
    }
  }
  pause(): void {
    this.generation++;
    this.clock.pause(this.outputSeconds());
    this.stopSource();
  }
  seek(timeUs: number): void {
    const wasPlaying = this.clock.playing;
    this.pause();
    this.clock.seek(timeUs, this.context?.currentTime ?? 0);
    if (wasPlaying && this.music && timeUs < this.clock.durationUs) this.startSource();
  }
  snapshot() {
    const timeUs = this.clock.positionAt(this.outputSeconds());
    if (this.clock.playing && timeUs >= this.clock.durationUs) {
      this.pause();
      this.clock.seek(this.clock.durationUs, this.context?.currentTime ?? 0);
    }
    return {
      timeUs,
      durationUs: this.clock.durationUs,
      playing: this.clock.playing,
      ready: this.ready,
      contextState: this.context?.state ?? 'not-created',
      outputLatencyMs: this.context ? (this.context.outputLatency ?? 0) * 1000 : null,
    };
  }
  unload(): void {
    this.pause();
    this.music?.lease.release();
    this.music = null;
    this.clock.reset();
  }
  async dispose(): Promise<void> {
    this.unload();
    await this.context?.close();
    this.context = null;
  }
}
