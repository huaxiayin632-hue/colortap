import { ImageSource, Rectangle, Texture } from 'pixi.js';
import type { Asset, Rect } from '../../shared/models';
import { unwrap } from '../../shared/ipc';

interface Cached {
  texture: Texture;
  bitmap: ImageBitmap;
  bytes: number;
  used: number;
}
/** Bounded decoded-image/GPU cache. Original file bytes are never modified. */
export class TileTextureCache {
  budgetBytes = 192 * 1024 * 1024;
  private entries = new Map<string, Cached>();
  private pending = new Set<string>();
  private wanted = new Set<string>();
  private retained = new Set<string>();
  private queue: { asset: Asset; frame: Rect }[] = [];
  private active = 0;
  private clock = 0;
  private failures = new Set<string>();
  private live = true;
  private idleTrim: ReturnType<typeof setTimeout> | undefined;
  loaded = 0;
  evicted = 0;
  peakBytes = 0;
  constructor(
    private readonly handle: string,
    private readonly maxTextureSize: number,
    private readonly changed: () => void,
    private readonly failed: (error: string) => void,
  ) {}
  get(id: string): Texture | undefined {
    const entry = this.entries.get(id);
    if (entry) entry.used = ++this.clock;
    return entry?.texture;
  }
  hasFailed(id: string): boolean {
    return this.failures.has(id);
  }
  setBudget(bytes: number): void {
    this.budgetBytes = bytes;
    this.trim();
  }
  request(tiles: { asset: Asset; frame: Rect }[], retained: string[] = []): void {
    this.retained = new Set(retained);
    tiles = [...new Map(tiles.map((t) => [t.asset.id, t])).values()];
    this.wanted = new Set(tiles.map((t) => t.asset.id));
    this.queue = tiles.filter(
      (t) =>
        !this.entries.has(t.asset.id) &&
        !this.pending.has(t.asset.id) &&
        !this.failures.has(t.asset.id),
    );
    this.trim();
    this.pump();
    this.scheduleIdleTrim();
  }
  private get bytes(): number {
    let n = 0;
    for (const e of this.entries.values()) n += e.bytes;
    return n;
  }
  private trim(incoming = 0, limit = this.budgetBytes): void {
    const candidates = [...this.entries]
      .filter(([id]) => !this.wanted.has(id) && !this.retained.has(id))
      .sort((a, b) => a[1].used - b[1].used);
    let bytes = this.bytes;
    for (const [id, entry] of candidates) {
      if (bytes + incoming <= limit && this.entries.size < 1024) break;
      entry.texture.destroy(true);
      entry.bitmap.close();
      this.entries.delete(id);
      bytes -= entry.bytes;
      this.evicted++;
    }
  }
  private scheduleIdleTrim(): void {
    clearTimeout(this.idleTrim);
    this.idleTrim = setTimeout(() => {
      if (!this.live || this.active || this.queue.length) return;
      const pinned = [...this.entries].reduce(
        (sum, [id, e]) => sum + (this.wanted.has(id) || this.retained.has(id) ? e.bytes : 0),
        0,
      );
      // Keep a small warm cache for reversing a pan; release obsolete high LODs at rest.
      this.trim(
        0,
        pinned
          ? Math.min(this.budgetBytes, pinned + Math.min(48 * 1024 * 1024, this.budgetBytes / 4))
          : 0,
      );
    }, 2000);
  }
  private pump(): void {
    while (this.live && this.active < 4 && this.queue.length) {
      const tile = this.queue.shift()!,
        id = tile.asset.id;
      this.active++;
      this.pending.add(id);
      void this.load(tile).finally(() => {
        this.active--;
        this.pending.delete(id);
        this.pump();
        if (this.live) this.changed();
        this.scheduleIdleTrim();
      });
    }
  }
  private async load(tile: { asset: Asset; frame: Rect }): Promise<void> {
    try {
      const bytes = unwrap(
        await window.desktop.readAsset({ handle: this.handle, assetId: tile.asset.id }),
      );
      if (!this.live || !this.wanted.has(tile.asset.id)) return;
      const bitmap = await createImageBitmap(new Blob([bytes], { type: 'image/png' }), {
        premultiplyAlpha: 'premultiply',
        colorSpaceConversion: 'none',
      });
      if (!this.live || !this.wanted.has(tile.asset.id)) {
        bitmap.close();
        return;
      }
      if (bitmap.width > this.maxTextureSize || bitmap.height > this.maxTextureSize) {
        bitmap.close();
        throw new Error('分块超过 GPU 纹理上限，请在此设备重新导入素材');
      }
      const footprint = bitmap.width * bitmap.height * 4;
      this.trim(footprint);
      const source = new ImageSource({
        resource: bitmap,
        alphaMode: 'premultiplied-alpha',
        autoGenerateMipmaps: false,
        scaleMode: 'linear',
        addressMode: 'clamp-to-edge',
      });
      const f = tile.frame;
      const texture = new Texture({ source, frame: new Rectangle(f.x, f.y, f.width, f.height) });
      this.entries.set(tile.asset.id, { texture, bitmap, bytes: footprint, used: ++this.clock });
      this.loaded++;
      this.peakBytes = Math.max(this.peakBytes, this.bytes);
      this.changed();
    } catch (error) {
      if (this.live && this.wanted.has(tile.asset.id)) {
        this.failures.add(tile.asset.id);
        this.failed(error instanceof Error ? error.message : '图层分块读取失败');
        this.changed();
      }
    }
  }
  stats() {
    return {
      residentTextures: this.entries.size,
      rgbaBytesEstimate: this.bytes,
      decodedImageBytesEstimate: this.bytes,
      peakRgbaBytesEstimate: this.peakBytes,
      budgetBytes: this.budgetBytes,
      retainedTextures: this.retained.size,
      loading: this.active,
      queued: this.queue.length,
      loaded: this.loaded,
      evicted: this.evicted,
      failed: this.failures.size,
    };
  }
  dispose(): void {
    this.live = false;
    clearTimeout(this.idleTrim);
    this.queue = [];
    this.wanted.clear();
    this.retained.clear();
    this.failures.clear();
    for (const entry of this.entries.values()) {
      entry.texture.destroy(true);
      entry.bitmap.close();
    }
    this.entries.clear();
  }
}
