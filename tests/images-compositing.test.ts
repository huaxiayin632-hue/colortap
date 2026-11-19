import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { writePsdBuffer, type Layer as PsdLayer } from 'ag-psd';
import { PNG } from 'pngjs';
import { importImage } from '../src/main/images/importer';
import { createProject } from '../src/shared/models';
import { EditHistory } from '../src/application/history';
import { serializeProject, validateProject } from '../src/shared/schema';
import { supportedBlendModes } from '../src/core/compositing';

let root: string;
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'rhythm-compositing-'));
});
afterEach(async () => {
  if (path.dirname(root) !== os.tmpdir() || !path.basename(root).startsWith('rhythm-compositing-'))
    throw new Error('Unsafe cleanup');
  await fs.rm(root, { recursive: true, force: true });
});
function solid(width: number, height: number, rgba: number[]): ImageData {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < data.length; i += 4) data.set(rgba, i);
  return { width, height, data, colorSpace: 'srgb' };
}
async function imported(children: PsdLayer[]) {
  const file = path.join(root, 'compositing.psd');
  await fs.writeFile(
    file,
    writePsdBuffer({ width: 120, height: 100, children }, { noBackground: true }),
  );
  return importImage({
    sourceFile: file,
    stagingRoot: root,
    importId: crypto.randomUUID(),
    tileSize: 64,
  });
}

describe('PSD compositing import', () => {
  it('keeps mask grayscale, offset, density and disabled state separately from untouched layer pixels', async () => {
    const result = await imported([
      {
        name: 'masked',
        left: 30,
        top: 20,
        imageData: solid(8, 6, [80, 120, 200, 180]),
        mask: {
          left: 32,
          top: 19,
          defaultColor: 255,
          disabled: true,
          userMaskDensity: 0.5,
          imageData: solid(4, 3, [64, 64, 64, 255]),
        },
      },
    ]);
    const layer = Object.values(result.layers)[0];
    expect(layer.rasterMask).toMatchObject({
      position: { x: 2, y: -1 },
      defaultValue: 1,
      enabled: false,
      density: 128 / 255,
      feather: 0,
    });
    const source = result.pixelSources[layer.rasterMask!.sourceId!];
    const tile = source.levels[0].tiles[0];
    const mask = PNG.sync.read(
      await fs.readFile(path.join(root, result.assets[tile.assetId].relativePath)),
    );
    expect([...mask.data.slice(0, 4)]).toEqual([64, 64, 64, 255]);
    if (layer.kind === 'group') throw new Error('Expected raster');
    const colorTile = result.pixelSources[layer.pixelSourceId].levels[0].tiles[0];
    const color = PNG.sync.read(
      await fs.readFile(path.join(root, result.assets[colorTile.assetId].relativePath)),
    );
    expect([...color.data.slice(0, 4)]).toEqual([80, 120, 200, 180]);
    expect(result.warnings).toEqual([]);
  });

  it('normalizes relative mask coordinates and retains constant masks without an image channel', async () => {
    const result = await imported([
      {
        name: 'relative',
        left: 30,
        top: 20,
        imageData: solid(8, 6, [30, 50, 80, 255]),
        mask: {
          left: -2,
          top: 3,
          positionRelativeToLayer: true,
          defaultColor: 0,
          imageData: solid(4, 3, [128, 128, 128, 255]),
        },
      },
      { name: 'constant', imageData: solid(8, 6, [30, 50, 80, 255]), mask: { defaultColor: 0 } },
    ]);
    const layers = Object.values(result.layers);
    expect(layers.find((l) => l.name === 'relative')!.rasterMask).toMatchObject({
      position: { x: -2, y: 3 },
      positionRelativeToLayer: true,
    });
    expect(layers.find((l) => l.name === 'constant')!.rasterMask).toMatchObject({
      defaultValue: 0,
      enabled: true,
    });
  });

  it('restores continuous clipping chains with independent bases inside nested groups and round trips them', async () => {
    const pixel = solid(8, 6, [30, 50, 80, 128]);
    const result = await imported([
      { name: 'base', opacity: 0.5, blendMode: 'multiply', imageData: pixel },
      { name: 'clip1', clipping: true, blendMode: 'screen', imageData: pixel },
      { name: 'clip2', clipping: true, imageData: pixel },
      {
        name: 'group',
        children: [
          { name: 'inner', imageData: pixel },
          { name: 'inner clip', clipping: true, imageData: pixel },
        ],
      },
    ]);
    const find = (name: string) => Object.values(result.layers).find((l) => l.name === name)!;
    expect(find('clip1').clippingBaseId).toBe(find('base').id);
    expect(find('clip2').clippingBaseId).toBe(find('base').id);
    expect(find('inner clip').clippingBaseId).toBe(find('inner').id);
    expect(result.warnings).toEqual([]);
    const h = new EditHistory(createProject());
    h.execute({ type: 'import-image', imported: result });
    expect(validateProject(JSON.parse(serializeProject(h.current))).layers).toEqual(result.layers);
    h.undo();
    expect(Object.keys(h.current.layers)).toHaveLength(0);
    h.redo();
    expect(h.current.layers).toEqual(result.layers);
    expect(() => h.execute({ type: 'delete-layer', id: find('base').id })).toThrow('剪贴');
    expect(h.current.layers).toEqual(result.layers);
    expect(() =>
      h.execute({ type: 'move-layer', id: find('clip1').id, parentId: find('group').id, index: 0 }),
    ).toThrow('剪贴');
    expect(h.current.layers).toEqual(result.layers);
  });

  it('accepts the supported modes while warning precisely about remaining Photoshop features', async () => {
    const result = await imported([
      ...supportedBlendModes.map((blendMode) => ({
        name: blendMode,
        blendMode,
        imageData: solid(2, 2, [80, 120, 200, 255]),
      })),
      { name: 'unsupported', blendMode: 'difference', imageData: solid(2, 2, [80, 120, 200, 255]) },
      {
        name: 'feather',
        imageData: solid(2, 2, [80, 120, 200, 255]),
        mask: { userMaskFeather: 4, imageData: solid(2, 2, [120, 120, 120, 255]) },
      },
    ]);
    expect(result.warnings).toHaveLength(2);
    expect(result.warnings.join('\n')).toContain('difference');
    expect(result.warnings.join('\n')).toContain('羽化');
  });

  it('uses the real user-mask channel separately from an unsupported vector-rendered mask', async () => {
    const result = await imported([
      {
        name: 'two masks',
        left: 10,
        top: 20,
        imageData: solid(8, 6, [80, 120, 200, 255]),
        mask: {
          left: 10,
          top: 20,
          fromVectorData: true,
          imageData: solid(8, 6, [200, 200, 200, 255]),
        },
        realMask: { left: 12, top: 21, imageData: solid(4, 3, [64, 64, 64, 255]) },
      },
    ]);
    const layer = Object.values(result.layers)[0];
    expect(layer.rasterMask!.position).toEqual({ x: 2, y: 1 });
    const tile = result.pixelSources[layer.rasterMask!.sourceId!].levels[0].tiles[0];
    const png = PNG.sync.read(
      await fs.readFile(path.join(root, result.assets[tile.assetId].relativePath)),
    );
    expect([...png.data.slice(0, 4)]).toEqual([64, 64, 64, 255]);
    expect(result.warnings.join('\n')).toContain('矢量蒙版');
  });

  it('suppresses orphan clipping and warns for advanced clipping/pass-through combinations', async () => {
    const pixel = solid(8, 6, [80, 120, 200, 255]);
    const result = await imported([
      { name: 'orphan', clipping: true, imageData: pixel },
      { name: 'base', blendClippendElements: false, imageData: pixel },
      { name: 'clip', clipping: true, imageData: pixel },
      {
        name: 'pass opacity',
        blendMode: 'pass through',
        opacity: 0.5,
        children: [{ name: 'child', imageData: pixel }],
      },
    ]);
    const orphan = Object.values(result.layers).find((l) => l.name === 'orphan')!;
    expect(orphan.enabled).toBe(false);
    expect(orphan.clippingBaseId).toBeUndefined();
    expect(result.warnings).toHaveLength(3);
    expect(result.warnings.join('\n')).toContain('找不到同组剪贴底层');
    expect(result.warnings.join('\n')).toContain('将剪贴图层混合成组');
    expect(result.warnings.join('\n')).toContain('穿透分组');
  });
});
