import { describe, expect, it, vi } from 'vitest';
import { ResourcePool, type LoadedResource } from '../src/core/resources';
import { FrameRecorder } from '../src/core/performance';

describe('resource ownership', () => {
  it('shares loading work and releases only when the final consumer is done', async () => {
    const pool = new ResourcePool();
    const dispose = vi.fn();
    const load = vi.fn(async () => ({ value: { audio: true }, bytes: 1234, dispose }));
    const [a, b] = await Promise.all([
      pool.acquire('song', 'decoded-audio', load),
      pool.acquire('song', 'decoded-audio', load),
    ]);
    expect(load).toHaveBeenCalledTimes(1);
    expect(a.value).toBe(b.value);
    expect(pool.stats().bytes['decoded-audio']).toBe(1234);
    a.release();
    a.release();
    expect(dispose).not.toHaveBeenCalled();
    b.release();
    expect(dispose).toHaveBeenCalledTimes(1);
    expect(pool.stats().count).toBe(0);
  });
  it('cleans failed loads so retrying works', async () => {
    const pool = new ResourcePool();
    await expect(
      pool.acquire('image', 'decoded-image', async () => {
        throw new Error('decode failed');
      }),
    ).rejects.toThrow();
    expect(pool.stats().count).toBe(0);
    const resource = await pool.acquire('image', 'decoded-image', async () => ({
      value: 3,
      bytes: 4,
    }));
    expect(resource.value).toBe(3);
    resource.release();
  });
  it('disposes a late completion after its project resources were closed', async () => {
    const pool = new ResourcePool(),
      dispose = vi.fn();
    let complete!: (value: { value: number; bytes: number; dispose: () => void }) => void;
    const pending = pool.acquire(
      'late',
      'gpu-texture',
      () =>
        new Promise<LoadedResource<number>>((resolve) => {
          complete = resolve;
        }),
    );
    await Promise.resolve();
    pool.dispose();
    complete({ value: 1, bytes: 400, dispose });
    await expect(pending).rejects.toThrow(/取消/);
    expect(dispose).toHaveBeenCalledTimes(1);
    expect(pool.stats().bytes['gpu-texture']).toBe(0);
  });
});

describe('bounded frame statistics', () => {
  it('records frame-time tails rather than reporting only average FPS', () => {
    const recorder = new FrameRecorder(4);
    [0, 10, 20, 30, 130].forEach((time) => recorder.frame(time));
    expect(recorder.snapshot()).toMatchObject({
      samples: 4,
      meanMs: 32.5,
      p95Ms: 100,
      p99Ms: 100,
      maxMs: 100,
    });
    recorder.frame(140);
    expect(recorder.snapshot().samples).toBe(4);
  });
});
