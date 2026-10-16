import type { Rect, Size } from '../shared/models';

export interface RenderCapabilities {
  maxTextureSize: number;
  maxRenderbufferSize: number;
  maxViewport: Size;
}
export interface TileRequest {
  key: string;
  sourceId: string;
  level: number;
  sourceRect: Rect;
  gutter: number;
}
export interface TileRenderer<T> {
  upload(request: TileRequest, pixels: T): Promise<void>;
  release(key: string): void;
  dispose(): void;
}

// A pure, lazy tile planner. Calling it does not allocate textures or image-sized canvases.
export function* planTiles(
  size: Size,
  region: Rect,
  capabilities: RenderCapabilities,
  preferred = 2048,
  gutter = 2,
): Generator<Rect> {
  if (
    ![
      size.width,
      size.height,
      preferred,
      capabilities.maxTextureSize,
      capabilities.maxRenderbufferSize,
    ].every((value) => Number.isSafeInteger(value) && value > 0) ||
    ![region.x, region.y, region.width, region.height].every(Number.isFinite) ||
    region.width < 0 ||
    region.height < 0 ||
    !Number.isSafeInteger(gutter) ||
    gutter < 0
  )
    throw new Error('无效分块参数');
  const edge =
    Math.floor(Math.min(preferred, capabilities.maxTextureSize, capabilities.maxRenderbufferSize)) -
    gutter * 2;
  if (edge <= 0) throw new Error('当前图形设备无法分配所需分块');
  const left = Math.max(0, Math.floor(region.x / edge) * edge);
  const top = Math.max(0, Math.floor(region.y / edge) * edge);
  const right = Math.min(size.width, region.x + region.width);
  const bottom = Math.min(size.height, region.y + region.height);
  for (let y = top; y < bottom; y += edge)
    for (let x = left; x < right; x += edge) {
      yield {
        x,
        y,
        width: Math.min(edge, size.width - x),
        height: Math.min(edge, size.height - y),
      };
    }
}

export function chooseLevel(screenPixelsPerSourcePixel: number, availableLevels: number[]): number {
  if (
    !Number.isFinite(screenPixelsPerSourcePixel) ||
    screenPixelsPerSourcePixel <= 0 ||
    !availableLevels.length ||
    !availableLevels.every((level) => Number.isSafeInteger(level) && level >= 0)
  )
    throw new Error('无效预览比例');
  const desired = Math.max(0, Math.floor(Math.log2(1 / screenPixelsPerSourcePixel)));
  return (
    [...availableLevels]
      .sort((a, b) => a - b)
      .filter((level) => level <= desired)
      .at(-1) ?? Math.min(...availableLevels)
  );
}
