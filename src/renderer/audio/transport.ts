import { AnchoredClock, type LoopRange } from '../../core/timing';
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
  get rate() {
    return this.clock.rate;
  }
  get loop() {
    return this.clock.loop;
  }
  contextTimeAt(musicUs: number, cycle?: number): number {
    return this.clock.contextTimeAt(musicUs, cycle ?? this.snapshot().cycle);
  }
  renderPosition(seconds = this.sharedContext.currentTime) {
    return this.clock.projection(seconds);
  }
  setRate(rate: number) {
    this.generation++;
    const at = this.context?.currentTime ?? 0;
    this.clock.setRate(rate, at);
    this.source?.playbackRate.setValueAtTime(rate, at);
  }
  setLoop(loop: LoopRange | null, destination?: number) {
    const wasPlaying = this.clock.playing;
    this.pause();
    const at = this.context?.currentTime ?? 0;
    this.clock.setLoop(null, at);
    if (destination !== undefined) this.clock.seek(destination, at);
    this.clock.setLoop(loop, at);
    if (wasPlaying) this.startSource(this.clock.positionAt(at));
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
    const position = this.clock.positionAt(context.currentTime);
    this.startSource(position >= this.clock.durationUs ? (this.loop?.startUs ?? 0) : position);
  }
  private startSource(positionUs: number): void {
    if (!this.music || !this.context || !this.gain) return;
    this.stopSource();
    const startsAt = this.context.currentTime + 0.02;

    const source = this.context.createBufferSource();
    source.buffer = this.music.lease.value;
    source.playbackRate.value = this.clock.rate;
    if (this.clock.loop) {
      source.loop = true;
      source.loopStart = this.clock.loop.startUs / 1e6;
      source.loopEnd = this.clock.loop.endUs / 1e6;
    }
    source.connect(this.gain);
    this.clock.seek(positionUs, this.context.currentTime);
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
    if (wasPlaying && this.music && timeUs < this.clock.durationUs)
      this.startSource(this.clock.positionAt(this.context!.currentTime));
  }
  snapshot() {
    const { timeUs, cycle } = this.clock.projection(this.outputSeconds());
    if (this.clock.playing && !this.clock.loop && timeUs >= this.clock.durationUs) {
      this.pause();
      this.clock.seek(this.clock.durationUs, this.context?.currentTime ?? 0);
    }
    return {
      timeUs,
      cycle,
      rate: this.clock.rate,
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
