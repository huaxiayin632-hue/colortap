import { afterEach, expect, it, vi } from 'vitest';
import { TileTextureCache } from '../src/renderer/canvas/texture-cache';
import type { Asset } from '../src/shared/models';

afterEach(() => vi.unstubAllGlobals());
it('pins displayed textures through a replacement and releases partial failed replacements under pressure', async () => {
  const bitmaps: { width: number; height: number; close: ReturnType<typeof vi.fn> }[] = [];
  vi.stubGlobal('window', {
    desktop: {
      readAsset: vi.fn(async ({ assetId }: { assetId: string }) => {
        if (assetId === 'failed') throw new Error('Missing tile');
        return { ok: true, value: new ArrayBuffer(4) };
      }),
    },
  });
  vi.stubGlobal(
    'createImageBitmap',
    vi.fn(async () => {
      const bitmap = { width: 4096, height: 4096, close: vi.fn() };
      bitmaps.push(bitmap);
      return bitmap;
    }),
  );
  const changed = vi.fn(),
    failed = vi.fn(),
    cache = new TileTextureCache('test', 4096, changed, failed);
  const tile = (id: string) => ({
    asset: {
      id,
      kind: 'png',
      relativePath: id,
      originalName: id,
      sha256: 'a'.repeat(64),
      byteLength: 4,
      pixelSize: { width: 4096, height: 4096 },
    } as Asset,
    frame: { x: 0, y: 0, width: 4096, height: 4096 },
  });
  cache.request(['old-a', 'old-b', 'old-c'].map(tile));
  await vi.waitFor(() => expect(cache.stats().loading).toBe(0));
  const original = cache.get('old-a');
  cache.request(['new-a', 'new-b', 'failed'].map(tile), ['old-a', 'old-b', 'old-c']);
  await vi.waitFor(() => expect(cache.stats().loading).toBe(0));
  expect(cache.hasFailed('failed')).toBe(true);
  expect(failed).toHaveBeenCalledTimes(1);
  expect(cache.get('old-a')).toBe(original);
  expect(original?.destroyed).toBe(false);
  // LayerScene cancels a failed replacement; only the displayed fallback stays pinned.
  cache.request([], ['old-a', 'old-b', 'old-c']);
  expect(cache.stats().rgbaBytesEstimate).toBeLessThanOrEqual(cache.budgetBytes);
  expect(cache.get('new-a')).toBeUndefined();
  expect(cache.get('new-b')).toBeUndefined();
  cache.dispose();
  for (const bitmap of bitmaps) expect(bitmap.close).toHaveBeenCalledTimes(1);
});
