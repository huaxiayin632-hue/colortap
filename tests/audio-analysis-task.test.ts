import { describe, expect, it } from 'vitest';
import { analyzeAudio } from '../src/core/audio-analysis';
import {
  AudioAnalysisTask,
  type AnalysisRequest,
  type AnalysisResponse,
  type AnalysisWorker,
} from '../src/renderer/audio/audio-analysis-task';

class TestWorker implements AnalysisWorker {
  onmessage: AnalysisWorker['onmessage'] = null;
  onerror: AnalysisWorker['onerror'] = null;
  requests: AnalysisRequest[] = [];
  terminations = 0;
  postMessage(message: AnalysisRequest, options: Transferable[] | StructuredSerializeOptions = []) {
    const transfer = Array.isArray(options) ? options : (options.transfer ?? []);
    this.requests.push(structuredClone(message, { transfer }));
  }
  terminate() {
    this.terminations++;
  }
  respond(message: AnalysisResponse) {
    this.onmessage?.call(this as unknown as Worker, { data: message } as MessageEvent);
  }
}
const source = { assetId: 'music', sha256: 'source-hash' };
const empty = analyzeAudio({ sampleRate: 48000, channels: [new Float32Array(0)] });
function buffer(length = 8, channels = 2) {
  const data = Array.from({ length: channels }, () =>
    Float32Array.from({ length }, (_, i) => i / length),
  );
  return {
    data,
    audio: {
      sampleRate: 48000,
      length,
      numberOfChannels: channels,
      copyFromChannel: (target: Float32Array, channel: number, offset: number) =>
        target.set(data[channel].subarray(offset, offset + target.length)),
    } as AudioBuffer,
  };
}
async function copied(worker: TestWorker) {
  while (!worker.requests.some((r) => r.type === 'analyze'))
    await new Promise((resolve) => setTimeout(resolve, 1));
}
describe('one audio analysis job owns copied PCM and its Worker', () => {
  it('copies and transfers bounded chunks, retains the source buffer, and yields between chunks', async () => {
    const worker = new TestWorker(),
      task = new AudioAnalysisTask(() => worker),
      { audio, data } = buffer(262_144 * 2 + 13),
      pending = task.analyze(audio, source);
    expect(worker.requests.filter((r) => r.type === 'chunk')).toHaveLength(1);
    await copied(worker);
    const chunks = worker.requests.filter((r) => r.type === 'chunk');
    expect(chunks).toHaveLength(6);
    expect(chunks.every((r) => r.samples.byteLength <= 1024 * 1024)).toBe(true);
    expect(chunks[2].type === 'chunk' && chunks[2].samples).toEqual(data[0].slice(262_144 * 2));
    expect(data[0].byteLength).toBe(audio.length * 4);
    expect(data[0][99]).toBeCloseTo(99 / audio.length);
    worker.respond({ type: 'done', analysis: empty });
    expect((await pending).source).toEqual(source);
    expect(worker.terminations).toBe(1);
    expect(task.running).toBe(false);
  });
  it('terminates on cancel, stops further copies and rejects with AbortError', async () => {
    const worker = new TestWorker(),
      task = new AudioAnalysisTask(() => worker),
      pending = task.analyze(buffer(262_145).audio, source).catch((error: Error) => error);
    task.cancel();
    expect(((await pending) as Error).name).toBe('AbortError');
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(worker.requests.filter((r) => r.type === 'chunk')).toHaveLength(1);
    expect(worker.requests.some((r) => r.type === 'analyze')).toBe(false);
    task.cancel();
    expect(worker.terminations).toBe(1);
  });
  it('supersedes the previous source and ignores its late messages without retrying', async () => {
    const workers: TestWorker[] = [],
      task = new AudioAnalysisTask(() => {
        const worker = new TestWorker();
        workers.push(worker);
        return worker;
      }),
      first = task.analyze(buffer().audio, source).catch((error: Error) => error),
      nextSource = { assetId: 'other', sha256: 'other-hash' },
      second = task.analyze(buffer().audio, nextSource);
    nextSource.sha256 = 'mutated-by-caller';
    workers[0].respond({ type: 'done', analysis: empty });
    expect(task.running).toBe(true);
    await copied(workers[1]);
    workers[1].respond({ type: 'done', analysis: empty });
    expect(((await first) as Error).name).toBe('AbortError');
    expect((await second).source).toEqual({ assetId: 'other', sha256: 'other-hash' });
    expect(workers.map((w) => w.terminations)).toEqual([1, 1]);
  });
  it('releases a failed Worker and allows another explicit analysis', async () => {
    const workers: TestWorker[] = [],
      task = new AudioAnalysisTask(() => {
        const worker = new TestWorker();
        workers.push(worker);
        return worker;
      }),
      pending = task.analyze(buffer().audio, source).catch((error: Error) => error);
    workers[0].respond({ type: 'error', message: 'invalid PCM' });
    expect(((await pending) as Error).message).toBe('invalid PCM');
    expect(task.running).toBe(false);
    expect(workers).toHaveLength(1);
    const next = task.analyze(buffer().audio, source);
    await copied(workers[1]);
    workers[1].respond({ type: 'done', analysis: empty });
    await next;
    expect(workers.map((w) => w.terminations)).toEqual([1, 1]);
  });
});
