import type {
  AnalysisParameters,
  AnalysisProgress,
  AudioAnalysis,
} from '../../core/audio-analysis';

export interface AnalysisSource {
  assetId: string;
  sha256: string;
}
export interface AnalysisResult {
  source: AnalysisSource;
  analysis: AudioAnalysis;
}
export type AnalysisRequest =
  | {
      type: 'start';
      sampleRate: number;
      channels: number;
      length: number;
      options: Partial<AnalysisParameters>;
    }
  | { type: 'chunk'; channel: number; offset: number; samples: Float32Array }
  | { type: 'analyze' };
export type AnalysisResponse =
  | { type: 'progress'; value: AnalysisProgress }
  | { type: 'done'; analysis: AudioAnalysis }
  | { type: 'error'; message: string };

const chunkSamples = 262_144; // At most 1 MiB is copied on the UI thread between yields.
export type AnalysisWorker = Pick<Worker, 'postMessage' | 'onmessage' | 'onerror' | 'terminate'>;

/** Each job owns its Worker; settled callbacks ignore any late messages from that Worker.
 * One optional job, no pool or cache. The editor will own cancel() on music/project changes.
 * Results carry the source identity; they never apply BPM, Offset or note edits themselves. */
export class AudioAnalysisTask {
  private active: { cancel(): void } | null = null;
  constructor(
    private readonly createWorker: () => AnalysisWorker = () =>
      new Worker(new URL('./audio-analysis.worker.ts', import.meta.url), { type: 'module' }),
  ) {}

  get running(): boolean {
    return this.active !== null;
  }

  analyze(
    buffer: AudioBuffer,
    source: AnalysisSource,
    options: Partial<AnalysisParameters> = {},
    onProgress?: (progress: AnalysisProgress) => void,
  ): Promise<AnalysisResult> {
    this.cancel();
    const identity = { ...source };
    return new Promise((resolve, reject) => {
      const worker = this.createWorker();
      let settled = false,
        lastProgress = -Infinity,
        lastPhase: AnalysisProgress['phase'] | null = null;
      const report = (value: AnalysisProgress) => {
        const now = performance.now();
        if (value.phase !== lastPhase || value.fraction === 1 || now - lastProgress >= 50) {
          lastProgress = now;
          lastPhase = value.phase;
          onProgress?.(value);
        }
      };
      const finish = (error?: Error, analysis?: AudioAnalysis) => {
        if (settled) return;
        settled = true;
        worker.terminate();
        if (this.active === job) this.active = null;
        if (error) reject(error);
        else resolve({ source: identity, analysis: analysis! });
      };
      const job = { cancel: () => finish(new DOMException('已取消音频分析', 'AbortError')) };
      this.active = job;
      worker.onmessage = (event: MessageEvent<AnalysisResponse>) => {
        if (settled) return;
        const response = event.data;
        if (response.type === 'done') finish(undefined, response.analysis);
        else if (response.type === 'error') finish(Error(response.message));
        else report(response.value);
      };
      worker.onerror = (event) => finish(Error(event.message || '音频分析 Worker 执行失败'));
      const post = (message: AnalysisRequest, transfer: Transferable[] = []) =>
        worker.postMessage(message, transfer);
      const copy = async () => {
        post({
          type: 'start',
          sampleRate: buffer.sampleRate,
          channels: buffer.numberOfChannels,
          length: buffer.length,
          options,
        });
        report({ phase: 'copy', fraction: 0 });
        for (let channel = 0; channel < buffer.numberOfChannels; channel++)
          for (let offset = 0; offset < buffer.length; offset += chunkSamples) {
            if (settled) return;
            const samples = new Float32Array(Math.min(chunkSamples, buffer.length - offset));
            buffer.copyFromChannel(samples, channel, offset);
            post({ type: 'chunk', channel, offset, samples }, [samples.buffer]);
            report({
              phase: 'copy',
              fraction:
                (channel + Math.min(1, (offset + chunkSamples) / buffer.length)) /
                buffer.numberOfChannels,
            });
            await new Promise<void>((resume) => setTimeout(resume, 0));
          }
        if (!settled) post({ type: 'analyze' });
      };
      void copy().catch((error: Error) => finish(error));
    });
  }
  cancel(): void {
    this.active?.cancel();
  }
}
