import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { writePsdBuffer } from 'ag-psd';
import { PNG } from 'pngjs';
import { alphaBounds, extract, half, type Pixels } from '../src/main/images/pixels';
import { importImage } from '../src/main/images/importer';
import { createProject } from '../src/shared/models';
import { EditHistory } from '../src/application/history';
import { serializeProject, validateProject } from '../src/shared/schema';
import { ProjectRepository } from '../src/main/projects/repository';

let root: string;
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'rhythm-images-unit-'));
});
afterEach(async () => {
  if (
    path.dirname(path.resolve(root)) !== path.resolve(os.tmpdir()) ||
    !path.basename(root).startsWith('rhythm-images-unit-')
  )
    throw new Error('Unsafe cleanup');
  await fs.rm(root, { recursive: true, force: true });
});
function solid(width: number, height: number, color = [220, 45, 80, 255]): Pixels {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < data.length; i += 4) data.set(color, i);
  return { width, height, data };
}
describe('lossless source import and previews', () => {
  it('matches a brute-force alpha crop for sparse borders and opaque full-size bounds', () => {
    let seed = 12345;
    for (let test = 0; test < 40; test++) {
      const p = solid(31, 23, [80, 90, 100, 0]),
        xs: number[] = [],
        ys: number[] = [];
      for (let y = 0; y < p.height; y++)
        for (let x = 0; x < p.width; x++) {
          seed = (seed * 1664525 + 1013904223) >>> 0;
          if (seed % 200 < test) {
            p.data[(y * p.width + x) * 4 + 3] = 255;
            xs.push(x);
            ys.push(y);
          }
        }
      const expected = xs.length
        ? {
            x: Math.min(...xs),
            y: Math.min(...ys),
            width: Math.max(...xs) - Math.min(...xs) + 1,
            height: Math.max(...ys) - Math.min(...ys) + 1,
          }
        : null;
      expect(alphaBounds(p)).toEqual(expected);
    }
    expect(alphaBounds(solid(31, 23))).toEqual({ x: 0, y: 0, width: 31, height: 23 });
  });
  it('matches an independent alpha-weighted box reference for odd/even dimensions and varied alpha', () => {
    for (const [width, height] of [
      [8, 6],
      [7, 5],
      [1, 4],
      [4, 1],
    ]) {
      const p = solid(width, height, [0, 0, 0, 0]);
      for (let i = 0; i < p.data.length; i++) p.data[i] = (i * 79 + 23) % 256;
      const actual = half(p);
      for (let y = 0; y < actual.height; y++)
        for (let x = 0; x < actual.width; x++) {
          const pixels: number[][] = [];
          for (let yy = y * 2; yy < Math.min(height, y * 2 + 2); yy++)
            for (let xx = x * 2; xx < Math.min(width, x * 2 + 2); xx++)
              pixels.push([...p.data.slice((yy * width + xx) * 4, (yy * width + xx) * 4 + 4)]);
          const alpha = pixels.reduce((s, c) => s + c[3], 0),
            offset = (y * actual.width + x) * 4;
          expect(actual.data[offset + 3]).toBe(Math.round(alpha / pixels.length));
          for (let channel = 0; channel < 3; channel++)
            expect(actual.data[offset + channel]).toBe(
              alpha ? Math.round(pixels.reduce((s, c) => s + c[channel] * c[3], 0) / alpha) : 0,
            );
        }
    }
  });
  it('trims transparent borders, including the fully transparent case, without moving opaque pixels', () => {
    const p = solid(5, 4, [0, 0, 0, 0]);
    p.data.set([123, 45, 67, 150], (1 * 5 + 2) * 4);
    expect(alphaBounds(p)).toEqual({ x: 2, y: 1, width: 1, height: 1 });
    expect([...extract(p, alphaBounds(p)!).data]).toEqual([123, 45, 67, 150]);
    expect(alphaBounds(solid(5, 4, [0, 0, 0, 0]))).toBeNull();
  });
  it('uses alpha-weighted preview reduction, including odd image sizes', () => {
    const p = solid(3, 1, [0, 0, 0, 0]);
    p.data.set([255, 0, 0, 255], 0);
    const preview = half(p);
    expect(preview.width).toBe(2);
    expect([...preview.data.slice(0, 4)]).toEqual([255, 0, 0, 128]);
  });
  it('imports actual PSD bytes, nested groups, stacking, positions, opacity and hidden/locked states', async () => {
    const file = path.join(root, '多层.psd');
    const bytes = writePsdBuffer({
      width: 640,
      height: 480,
      children: [
        { name: '底层', left: -20, top: 30, imageData: solid(80, 70) as ImageData },
        {
          name: '外组',
          opacity: 0.5,
          children: [
            {
              name: '内组',
              opened: false,
              children: [
                {
                  name: '顶层',
                  left: 120,
                  top: 99,
                  opacity: 0.4,
                  hidden: true,
                  protected: { position: true },
                  imageData: solid(80, 60) as ImageData,
                },
              ],
            },
          ],
        },
      ],
    });
    await fs.writeFile(file, bytes);
    const result = await importImage({
      sourceFile: file,
      stagingRoot: root,
      importId: crypto.randomUUID(),
      tileSize: 64,
    });
    expect(result.metrics.rasterLayers).toBe(2);
    expect(result.metrics.groups).toBe(2);
    const layers = result.layers,
      find = (name: string) => Object.values(layers).find((l) => l.name === name)!;
    expect(result.rootLayersBottomToTop.map((id) => layers[id].name)).toEqual(['底层', '外组']);
    expect(find('底层').transform.position).toEqual({ x: -20, y: 30 });
    expect(find('顶层')).toMatchObject({
      opacity: 102 / 255,
      enabled: false,
      locked: true,
      transform: { position: { x: 120, y: 99 } },
    });
    expect(find('内组')).toMatchObject({ kind: 'group', expanded: false });
    expect(find('外组').opacity).toBeCloseTo(128 / 255);
    const h = new EditHistory(createProject());
    h.execute({ type: 'import-image', imported: result });
    const reopened = validateProject(JSON.parse(serializeProject(h.current)));
    expect(reopened.layers).toEqual(result.layers);
    expect(reopened.stage.artworkSize).toEqual({ width: 640, height: 480 });
    const original = Object.values(result.assets).find((a) => a.kind === 'psd')!;
    expect(await fs.readFile(path.join(root, original.relativePath))).toEqual(bytes);
  });
  it('keeps full-resolution pixels exactly in L0 tiles, trims offsets, generates LODs, and never exceeds requested tile size', async () => {
    const p = solid(180, 140, [0, 0, 0, 0]);
    for (let y = 3; y < 133; y++)
      for (let x = 7; x < 174; x++)
        p.data.set([x, y, 25, ((x + y) % 254) + 1], (y * p.width + x) * 4);
    const file = path.join(root, '独立.png');
    await fs.writeFile(
      file,
      PNG.sync.write({ width: p.width, height: p.height, data: Buffer.from(p.data) } as PNG),
    );
    const result = await importImage({
      sourceFile: file,
      stagingRoot: root,
      importId: crypto.randomUUID(),
      tileSize: 64,
    });
    const source = Object.values(result.pixelSources)[0];
    expect(source.cropRect).toEqual({ x: 7, y: 3, width: 167, height: 130 });
    expect(source.levels.length).toBeGreaterThan(1);
    for (const tile of source.levels[0].tiles) {
      const a = result.assets[tile.assetId];
      expect(a.pixelSize!.width).toBeLessThanOrEqual(64);
      expect(a.pixelSize!.height).toBeLessThanOrEqual(64);
      const decoded = PNG.sync.read(await fs.readFile(path.join(root, a.relativePath)));
      for (let y = 0; y < tile.sourceRect.height; y++)
        for (let x = 0; x < tile.sourceRect.width; x++) {
          const actual = (decoded.width * (tile.pixelRect.y + y) + tile.pixelRect.x + x) * 4;
          const expected = (p.width * (tile.sourceRect.y + y) + tile.sourceRect.x + x) * 4;
          expect([...decoded.data.subarray(actual, actual + 4)]).toEqual([
            ...p.data.subarray(expected, expected + 4),
          ]);
        }
    }
  });
  it('rejects non-RGB/high-bit-depth PSD and malformed files with actionable messages', async () => {
    const file = path.join(root, '损坏.psd');
    await fs.writeFile(file, 'not a psd');
    await expect(
      importImage({
        sourceFile: file,
        stagingRoot: root,
        importId: crypto.randomUUID(),
        tileSize: 64,
      }),
    ).rejects.toThrow('有效');
    const bytes = writePsdBuffer({ width: 2, height: 2, children: [] });
    bytes.writeUInt16BE(16, 22);
    await fs.writeFile(file, bytes);
    await expect(
      importImage({
        sourceFile: file,
        stagingRoot: root,
        importId: crypto.randomUUID(),
        tileSize: 64,
      }),
    ).rejects.toThrow('8 位 RGB');
  });
  it('round trips registered image assets and originals through save-as; failed batches are removed', async () => {
    const repository = new ProjectRepository(path.join(root, 'sessions')),
      p = createProject(),
      session = await repository.create(p);
    const file = path.join(root, '来源.png');
    await fs.writeFile(
      file,
      PNG.sync.write({ width: 2, height: 2, data: Buffer.from(solid(2, 2).data) } as PNG),
    );
    const imported = await repository.importImage(session.handle, file, 64, (request) =>
      importImage(request),
    );
    const h = new EditHistory(p);
    h.execute({ type: 'import-image', imported });
    const first = path.join(root, 'a', 'p.rcproj'),
      second = path.join(root, 'b', 'p.rcproj');
    await repository.save(session.handle, h.current, first);
    await repository.save(session.handle, h.current, second);
    await fs.unlink(file);
    const reopened = await repository.open(second);
    expect(reopened.warnings).toEqual([]);
    expect(reopened.project.layers).toEqual(h.current.layers);
    for (const a of Object.values(reopened.project.assets))
      expect((await repository.readAsset(reopened.handle, a.id)).byteLength).toBe(a.byteLength);
    await expect(
      repository.importImage(session.handle, file, 64, async (request) => {
        await fs.mkdir(path.join(request.stagingRoot, `assets/images/${request.importId}`), {
          recursive: true,
        });
        throw new Error('cancelled');
      }),
    ).rejects.toThrow('cancelled');
    await repository.closeAll();
  });
});
