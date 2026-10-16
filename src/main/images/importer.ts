import { readPsd, getLayerImageData, initializeCanvas, type Layer as PsdLayer } from 'ag-psd';
import { PNG } from 'pngjs';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { identityTransform } from '../../core/layers';
import type { Asset, Layer, PixelSource, Rect } from '../../shared/models';
import type { ImageImport, ImageWorkerRequest } from '../../shared/images';
import { alphaBounds, extract, half, type Pixels } from './pixels';

initializeCanvas(
  () => {
    throw new Error('该 PSD 需要不支持的 Canvas 转换，请从 Photoshop 导出 PNG 图层');
  },
  (width, height) =>
    ({
      width,
      height,
      data: new Uint8ClampedArray(width * height * 4),
      colorSpace: 'srgb',
    }) as ImageData,
);

export async function importImage(
  request: ImageWorkerRequest,
  progress: (phase: string, completed: number, total: number) => void = () => {},
): Promise<ImageImport> {
  const started = performance.now();
  const { sourceFile, stagingRoot, importId } = request;
  const prefix = `assets/images/${importId}`;
  const folder = path.join(stagingRoot, prefix);
  await fs.mkdir(folder, { recursive: true });
  let peakRss = 0,
    peakExternal = 0;
  const sample = () => {
    const m = process.memoryUsage();
    peakRss = Math.max(peakRss, m.rss);
    peakExternal = Math.max(peakExternal, m.external);
  };
  const result: ImageImport = {
    id: importId,
    name: path.basename(sourceFile),
    size: { width: 1, height: 1 },
    assets: {},
    pixelSources: {},
    layers: {},
    rootLayersBottomToTop: [],
    sourceDocuments: {},
    warnings: [],
    metrics: {
      elapsedMs: 0,
      peakWorkerRssBytes: 0,
      peakWorkerExternalBytes: 0,
      originalBytes: 0,
      derivedBytes: 0,
      rasterLayers: 0,
      groups: 0,
      tiles: 0,
    },
  };
  const warn = (s: string) => {
    if (!result.warnings.includes(s)) result.warnings.push(s);
  };
  const extension = path.extname(sourceFile).toLowerCase();
  if (!['.psd', '.png'].includes(extension)) throw new Error('请选择 PSD 或 PNG 文件');
  progress('复制原始素材', 0, 0);
  const originalPath = path.join(folder, `original${extension}`);
  await fs.copyFile(sourceFile, originalPath);
  const bytes = await fs.readFile(originalPath);
  const original: Asset = {
    id: randomUUID(),
    kind: extension === '.psd' ? 'psd' : 'png',
    relativePath: `${prefix}/original${extension}`,
    originalName: path.basename(sourceFile),
    sha256: createHash('sha256').update(bytes).digest('hex'),
    byteLength: bytes.length,
  };
  result.assets[original.id] = original;
  result.metrics.originalBytes = bytes.length;
  sample();
  const tileSize = Math.max(64, Math.min(1024, Math.floor(request.tileSize)));
  const gutter = 2,
    edge = tileSize - gutter * 2;
  async function pixelSource(
    pixels: Pixels | undefined,
    bounds: Rect,
    psdLayerId?: number,
  ): Promise<string> {
    const id = randomUUID();
    const crop = pixels ? alphaBounds(pixels) : null;
    const source: PixelSource = {
      id,
      sourceAssetId: original.id,
      originalBounds: bounds,
      cropRect: crop ?? { x: 0, y: 0, width: 1, height: 1 },
      levels: [],
      ...(psdLayerId !== undefined ? { psdLayerId } : {}),
    };
    result.pixelSources[id] = source;
    // Empty layers remain addressable and editable but allocate no textures.
    if (!pixels || !crop) return id;
    let current =
        crop.x === 0 && crop.y === 0 && crop.width === pixels.width && crop.height === pixels.height
          ? pixels
          : extract(pixels, crop),
      level = 0;
    while (true) {
      const scale = 2 ** -level;
      const metadata = {
        level,
        scale,
        pixelSize: { width: current.width, height: current.height },
        tileSize,
        gutter,
        tiles: [] as PixelSource['levels'][number]['tiles'],
      };
      for (let y = 0; y < current.height; y += edge)
        for (let x = 0; x < current.width; x += edge) {
          const width = Math.min(edge, current.width - x),
            height = Math.min(edge, current.height - y);
          const x0 = Math.max(0, x - gutter),
            y0 = Math.max(0, y - gutter);
          const x1 = Math.min(current.width, x + width + gutter),
            y1 = Math.min(current.height, y + height + gutter);
          const tile = extract(current, { x: x0, y: y0, width: x1 - x0, height: y1 - y0 });
          const encoded = PNG.sync.write(
            { width: tile.width, height: tile.height, data: Buffer.from(tile.data) } as PNG,
            { colorType: 6, filterType: 0, deflateLevel: 3, deflateStrategy: 0 },
          );
          const assetId = randomUUID(),
            relativePath = `${prefix}/${assetId}.png`;
          await fs.writeFile(path.join(stagingRoot, relativePath), encoded, { flag: 'wx' });
          result.assets[assetId] = {
            id: assetId,
            kind: 'png',
            relativePath,
            originalName: `${result.name} · L${level} 分块`,
            sha256: createHash('sha256').update(encoded).digest('hex'),
            byteLength: encoded.length,
            pixelSize: { width: tile.width, height: tile.height },
          };
          metadata.tiles.push({
            assetId,
            sourceRect: {
              x: crop.x + x / scale,
              y: crop.y + y / scale,
              width: Math.min(width / scale, crop.width - x / scale),
              height: Math.min(height / scale, crop.height - y / scale),
            },
            pixelRect: { x: x - x0, y: y - y0, width, height },
          });
          result.metrics.derivedBytes += encoded.length;
          result.metrics.tiles++;
          sample();
        }
      source.levels.push(metadata);
      if (Math.max(current.width, current.height) <= 128) break;
      current = half(current);
      level++;
    }
    return id;
  }
  if (extension === '.png') {
    progress('解码 PNG 并建立分级预览', 0, 1);
    const pixels = PNG.sync.read(bytes, { skipRescale: false });
    sample();
    result.size = { width: pixels.width, height: pixels.height };
    const pixelSourceId = await pixelSource(pixels, { x: 0, y: 0, ...result.size });
    const id = randomUUID();
    result.layers[id] = {
      id,
      name: result.name,
      kind: 'raster',
      pixelSourceId,
      transform: identityTransform(),
      opacity: 1,
      enabled: true,
      locked: false,
      initialReveal: 1,
      blendMode: 'normal',
    };
    result.rootLayersBottomToTop = [id];
    result.metrics.rasterLayers = 1;
  } else {
    // Validate the file header before the library allocates pixel data.
    if (bytes.length < 26 || bytes.toString('ascii', 0, 4) !== '8BPS')
      throw new Error('文件不是有效的 PSD');
    if (bytes.readUInt16BE(4) !== 1)
      throw new Error('本阶段支持标准 PSD；PSB 请另存为 PSD 或分层 PNG');
    if (bytes.readUInt16BE(22) !== 8 || bytes.readUInt16BE(24) !== 3)
      throw new Error(
        '本阶段支持 8 位 RGB PSD。请在 Photoshop 中转为 8 位 RGB 副本，或导出 PNG 图层；原文件不会修改',
      );
    progress('读取 PSD 结构', 0, 0);
    const psd = readPsd(bytes, {
      useRawData: true,
      useRawThumbnail: true,
      skipCompositeImageData: true,
      skipThumbnail: true,
      skipLinkedFilesData: true,
      logMissingFeatures: true,
      log: (...details: unknown[]) =>
        warn(
          `PSD 解析提示：${details.map(String).join(' ').slice(0, 400)}；如外观不符请导出 PNG。`,
        ),
    });
    result.size = { width: psd.width, height: psd.height };
    const docId = randomUUID();
    result.sourceDocuments[docId] = {
      id: docId,
      assetId: original.id,
      pixelSize: result.size,
      bitsPerChannel: 8,
      colorMode: 'RGB',
    };
    let total = 0,
      completed = 0;
    const count = (ls: PsdLayer[]) => {
      for (const l of ls) {
        total++;
        if (l.children) count(l.children);
      }
    };
    count(psd.children ?? []);
    async function convert(input: PsdLayer[]): Promise<string[]> {
      const ids: string[] = [];
      // ag-psd children follow the PSD file's bottom-to-top stacking order.
      for (const l of input) {
        const id = randomUUID(),
          name = l.name || '未命名图层';
        progress(`处理图层：${name}`, completed, total);
        const blend = l.blendMode ?? 'normal';
        const base = {
          id,
          name,
          opacity: l.opacity ?? 1,
          enabled: !l.hidden,
          locked: Boolean(
            l.transparencyProtected ||
            l.protected?.position ||
            l.protected?.composite ||
            l.protected?.transparency,
          ),
          initialReveal: 1 as const,
          blendMode: blend,
          transform: identityTransform(),
        };
        if (!['normal', 'pass through'].includes(blend))
          warn(
            `「${name}」使用 ${blend} 混合模式，预览暂按普通模式显示；需要精确外观时请导出 PNG。`,
          );
        if (l.mask || l.realMask || l.vectorMask)
          warn(`「${name}」含蒙版，当前预览未应用 PSD 蒙版；请导出已应用蒙版的 PNG。`);
        if (l.effects)
          warn(
            `「${name}」含图层效果，当前预览使用原像素，未重建 Photoshop 效果；可导出 PNG 保留外观。`,
          );
        if (l.clipping)
          warn(`「${name}」含剪贴关系，当前预览未重建剪贴关系；可合并相关图层后导出 PNG。`);
        if (l.adjustment)
          warn(`「${name}」是调整图层，当前预览不执行颜色调整；请导出处理后的 PNG。`);
        if (l.fillOpacity !== undefined && l.fillOpacity !== 1)
          warn(
            `「${name}」含独立填充透明度，当前预览仅应用图层不透明度；请导出 PNG 保留完整外观。`,
          );
        if (l.knockout)
          warn(`「${name}」含高级混合选项，当前预览未重建；请导出 PNG 保留完整外观。`);
        if (l.text || l.placedLayer)
          warn(`「${name}」按 PSD 内的像素副本显示，不能编辑文字或智能对象内容。`);
        if (l.children) {
          const childrenBottomToTop = await convert(l.children);
          result.layers[id] = {
            ...base,
            kind: 'group',
            childrenBottomToTop,
            expanded: l.opened ?? true,
            isolation: blend === 'pass through' ? 'pass-through' : 'isolated',
          };
          if (blend === 'pass through' && base.opacity !== 1)
            warn(`「${name}」的穿透分组透明度暂按隔离分组计算，复杂混合效果可能不同。`);
          result.metrics.groups++;
        } else {
          const width = Math.max(1, (l.right ?? 0) - (l.left ?? 0)),
            height = Math.max(1, (l.bottom ?? 0) - (l.top ?? 0));
          if (!Number.isSafeInteger(width * height * 4))
            throw new Error(`「${name}」尺寸无法安全解码`);
          const pixels = getLayerImageData(l);
          sample();
          base.transform.position = { x: l.left ?? 0, y: l.top ?? 0 };
          const pixelSourceId = await pixelSource(
            pixels as Pixels | undefined,
            { x: l.left ?? 0, y: l.top ?? 0, width, height },
            l.id,
          );
          result.layers[id] = { ...base, kind: 'raster', pixelSourceId };
          result.metrics.rasterLayers++;
          // The original PSD on disk is authoritative. Release processed channel views/metadata.
          delete l.rawData;
          delete l.imageData;
        }
        ids.push(id);
        completed++;
        sample();
      }
      return ids;
    }
    result.rootLayersBottomToTop = await convert(psd.children ?? []);
    result.sourceDocuments[docId].warnings = [...result.warnings];
    if (!result.metrics.rasterLayers) throw new Error('PSD 没有可渲染的像素图层，请导出 PNG 图层');
  }
  original.pixelSize = { ...result.size };
  sample();
  result.metrics.elapsedMs = Math.round(performance.now() - started);
  result.metrics.peakWorkerRssBytes = peakRss;
  result.metrics.peakWorkerExternalBytes = peakExternal;
  progress('导入完成', 1, 1);
  return result;
}
