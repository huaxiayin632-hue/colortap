import { AlphaFilter, Container, Graphics, Matrix, Rectangle, Sprite } from 'pixi.js';
import type { Layer, Project, Rect, Vec2 } from '../../shared/models';
import {
  identityTransform,
  inverse,
  matrix,
  multiply,
  point,
  type Affine,
} from '../../core/layers';
import type { Viewport } from '../../core/viewport';
import { TileTextureCache } from './texture-cache';

function intersects(a: Rect, b: Rect): boolean {
  return (
    a.width > 0 &&
    a.height > 0 &&
    a.x < b.x + b.width &&
    a.x + a.width > b.x &&
    a.y < b.y + b.height &&
    a.y + a.height > b.y
  );
}
function transformed(r: Rect, m: Affine): Rect {
  const p = [
    point(m, r),
    point(m, { x: r.x + r.width, y: r.y }),
    point(m, { x: r.x, y: r.y + r.height }),
    point(m, { x: r.x + r.width, y: r.y + r.height }),
  ];
  const x = Math.min(...p.map((v) => v.x)),
    y = Math.min(...p.map((v) => v.y));
  return {
    x,
    y,
    width: Math.max(...p.map((v) => v.x)) - x,
    height: Math.max(...p.map((v) => v.y)) - y,
  };
}
interface SceneLayer {
  container: Container;
  layer: Layer;
  world: Affine;
  visible: boolean;
  sprites: Map<string, Sprite>;
  filter?: AlphaFilter;
}
export class LayerScene {
  readonly root = new Container();
  readonly selection = new Graphics();
  private entries = new Map<string, SceneLayer>();
  private project: Project | null = null;
  private cache: TileTextureCache;
  private selected: string | null = null;
  private selectedLOD: number | null = null;
  private desired = 0;
  private raf = 0;
  private filters = 0;
  private disposed = false;
  constructor(
    readonly handle: string,
    private readonly viewport: Viewport,
    maxTextureSize: number,
    private readonly changed: () => void,
    failed: (error: string) => void,
  ) {
    this.cache = new TileTextureCache(handle, maxTextureSize, () => this.refreshSprites(), failed);
  }
  setProject(project: Project): void {
    if (this.project === project) return;
    this.clear();
    this.project = project;
    const visit = (ids: string[], parent: Container, parentWorld: Affine, visible: boolean) => {
      for (const id of ids) {
        const l = project.layers[id],
          container = new Container(),
          local = matrix(l.transform),
          world = multiply(parentWorld, local);
        container.setFromMatrix(new Matrix(local.a, local.b, local.c, local.d, local.tx, local.ty));
        container.visible = l.enabled && l.opacity > 0;
        const entry: SceneLayer = {
          container,
          layer: l,
          world,
          visible: visible && container.visible,
          sprites: new Map(),
        };
        // AlphaFilter composites overlapping children first. A plain Container alpha would fade every child separately.
        if (l.kind === 'group' && (l.opacity !== 1 || l.isolation === 'isolated')) {
          entry.filter = new AlphaFilter({
            alpha: l.opacity,
            antialias: false,
            resolution: window.devicePixelRatio || 1,
          });
          container.filters = [entry.filter];
          this.filters++;
        } else container.alpha = l.opacity;
        parent.addChild(container);
        this.entries.set(id, entry);
        if (l.kind === 'group') visit(l.childrenBottomToTop, container, world, entry.visible);
      }
    };
    visit(project.rootLayersBottomToTop, this.root, matrix(identityTransform()), true);
    this.update();
  }
  select(id: string | null): void {
    this.selected = id;
    this.update();
  }
  update(): void {
    if (this.disposed || !this.project) return;
    cancelAnimationFrame(this.raf);
    this.raf = requestAnimationFrame(() => this.reconcile());
  }
  private reconcile(): void {
    if (this.disposed || !this.project) return;
    const { zoom, screen } = this.viewport;
    this.selectedLOD = null;
    const topLeft = this.viewport.toWorld({ x: 0, y: 0 });
    const viewport: Rect = { ...topLeft, width: screen.width / zoom, height: screen.height / zoom };
    const artwork = this.project.stage.artworkSize;
    const visible: Rect = {
      x: Math.max(0, viewport.x),
      y: Math.max(0, viewport.y),
      width: 0,
      height: 0,
    };
    visible.width = Math.max(0, Math.min(artwork.width, viewport.x + viewport.width) - visible.x);
    visible.height = Math.max(
      0,
      Math.min(artwork.height, viewport.y + viewport.height) - visible.y,
    );
    for (const entry of this.entries.values())
      if (entry.filter) {
        // Pixi 8.22 transforms filterArea from container-local coordinates into screen space.
        // Invert the layer transform so large/rotated groups are clipped to the visible viewport.
        try {
          const local = transformed(viewport, inverse(entry.world));
          entry.container.filterArea = new Rectangle(local.x, local.y, local.width, local.height);
        } catch {
          entry.container.visible = false;
        }
      }
    type Wanted = {
      entry: SceneLayer;
      tile: Project['pixelSources'][string]['levels'][number]['tiles'][number];
    };
    let wanted: Wanted[] = [];
    for (let bias = 0; bias < 24; bias++) {
      wanted = [];
      let bytes = 0;
      for (const [id, entry] of this.entries) {
        if (!entry.visible || entry.layer.kind === 'group') continue;
        const source = this.project.pixelSources[entry.layer.pixelSourceId];
        if (
          !source.levels.length ||
          !intersects(transformed(source.cropRect, entry.world), visible)
        )
          continue;
        const worldScale = Math.max(
          Math.hypot(entry.world.a, entry.world.b),
          Math.hypot(entry.world.c, entry.world.d),
        );
        const ideal = Math.max(
          0,
          Math.floor(Math.log2(1 / (zoom * worldScale * (window.devicePixelRatio || 1)))),
        );
        const level = source.levels.reduce(
          (best, l) =>
            l.level <= ideal + (id === this.selected ? 0 : bias) && l.level > best.level ? l : best,
          source.levels[0],
        );
        if (id === this.selected) this.selectedLOD = level.level;
        for (const tile of level.tiles)
          if (intersects(transformed(tile.sourceRect, entry.world), visible)) {
            wanted.push({ entry, tile });
            const size = this.project.assets[tile.assetId].pixelSize!;
            bytes += size.width * size.height * 4;
          }
      }
      if (bytes <= this.cache.budgetBytes) break;
    }
    const wantedIds = new Set(wanted.map((w) => w.tile.assetId));
    this.desired = wanted.length;
    for (const entry of this.entries.values())
      for (const [id, sprite] of entry.sprites)
        if (!wantedIds.has(id)) {
          sprite.destroy();
          entry.sprites.delete(id);
        }
    this.cache.request(
      wanted.map(({ tile }) => ({
        asset: this.project!.assets[tile.assetId],
        frame: tile.pixelRect,
      })),
    );
    for (const { entry, tile } of wanted) {
      const texture = this.cache.get(tile.assetId);
      if (texture && !entry.sprites.has(tile.assetId)) {
        const sprite = new Sprite(texture);
        sprite.position.set(tile.sourceRect.x, tile.sourceRect.y);
        sprite.width = tile.sourceRect.width;
        sprite.height = tile.sourceRect.height;
        entry.container.addChild(sprite);
        entry.sprites.set(tile.assetId, sprite);
      }
    }
    this.drawSelection();
    this.changed();
  }
  private refreshSprites(): void {
    this.update();
  }
  private drawSelection(): void {
    this.selection.clear();
    const entry = this.selected ? this.entries.get(this.selected) : null;
    if (!entry || !entry.visible || entry.layer.kind === 'group' || !this.project) return;
    const r = this.project.pixelSources[entry.layer.pixelSourceId].cropRect,
      m = entry.world;
    const corners = [
      point(m, r),
      point(m, { x: r.x + r.width, y: r.y }),
      point(m, { x: r.x + r.width, y: r.y + r.height }),
      point(m, { x: r.x, y: r.y + r.height }),
    ];
    this.selection
      .poly(
        corners.flatMap((v) => [v.x, v.y]),
        true,
      )
      .stroke({ color: 0x82c9d1, width: 1.5 / this.viewport.zoom });
  }
  hit(world: Vec2): string | null {
    if (!this.project) return null;
    const { width, height } = this.project.stage.artworkSize;
    if (world.x < 0 || world.y < 0 || world.x >= width || world.y >= height) return null;
    for (const [id, e] of [...this.entries].reverse()) {
      if (!e.visible || e.layer.kind === 'group') continue;
      try {
        const p = point(inverse(e.world), world),
          r = this.project.pixelSources[e.layer.pixelSourceId].cropRect;
        if (p.x >= r.x && p.x <= r.x + r.width && p.y >= r.y && p.y <= r.y + r.height) return id;
      } catch {
        /* A zero-scale layer cannot be hit. */
      }
    }
    return null;
  }
  stats() {
    return {
      ...this.cache.stats(),
      desiredTextures: this.desired,
      selectedLevel: this.selectedLOD,
      isolatedGroups: this.filters,
      filterViewportRgbaBytesEstimate:
        this.filters *
        this.viewport.screen.width *
        this.viewport.screen.height *
        4 *
        (window.devicePixelRatio || 1) ** 2,
    };
  }
  private clear(): void {
    for (const e of this.entries.values()) e.filter?.destroy();
    this.root.removeChildren().forEach((c) => c.destroy({ children: true }));
    this.entries.clear();
    this.filters = 0;
  }
  dispose(): void {
    this.disposed = true;
    cancelAnimationFrame(this.raf);
    this.clear();
    this.cache.dispose();
    this.root.destroy();
    this.selection.destroy();
  }
}
