import { AlphaMask, Container, Graphics, Matrix, Rectangle, Sprite } from 'pixi.js';
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
import { directionalPolygon, layerBounds, revealMatrix, type RevealState } from '../../core/reveal';
import { PathVectorMask } from '../reveals/vector-mask';
import { cameraViewBounds } from '../../core/camera';
import { sameProjectParts } from '../../core/project';
import { fanPolygon } from '../../core/fan';
import { CompositeFilter } from './composite-filter';
import { supportedBlend } from '../../core/compositing';

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
  composite: Container;
  reveal: Container;
  content: Container;
  layer: Layer;
  world: Affine;
  baseWorld: Affine;
  local: Affine;
  renderLocal: Affine;
  parentId: string | null;
  bounds: Rect;
  visible: boolean;
  sprites: Map<string, Sprite>;
  filter?: CompositeFilter;
  clippingStack?: { container: Container; filter: CompositeFilter; parentWorld: Affine };
  maskView?: {
    root: Container;
    background: Graphics;
    sprites: Map<string, Sprite>;
    effect: AlphaMask;
  };
  pathMask?: PathVectorMask;
  directionMask?: Graphics;
  maskProgress?: number;
  maskClip?: string;
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
  private documentFilter?: CompositeFilter;
  private disposed = false;
  private lastReconcile = 0;
  constructor(
    readonly handle: string,
    private readonly viewport: Viewport,
    maxTextureSize: number,
    private readonly changed: () => void,
    failed: (error: string) => void,
    private readonly camera: () => Affine = () => ({ a: 1, b: 0, c: 0, d: 1, tx: 0, ty: 0 }),
  ) {
    this.cache = new TileTextureCache(handle, maxTextureSize, () => this.refreshSprites(), failed);
  }
  setProject(project: Project): void {
    if (this.project === project) return;
    const unchanged = sameProjectParts(this.project, project, [
      'layers',
      'rootLayersBottomToTop',
      'pixelSources',
      'reveals',
    ]);
    this.project = project;
    if (unchanged) {
      this.update();
      return;
    }
    this.clear();
    // Photoshop's transparent document backdrop is not the editor's gray board/grid.
    if (Object.values(project.layers).some((l) => supportedBlend(l.blendMode) !== 'normal')) {
      this.documentFilter = new CompositeFilter('normal');
      this.root.filters = [this.documentFilter];
      this.filters++;
    }
    const visit = (
      ids: string[],
      parent: Container,
      parentWorld: Affine,
      visible: boolean,
      parentId: string | null = null,
    ) => {
      let clippingStack: SceneLayer['clippingStack'];
      for (let index = 0; index < ids.length; index++) {
        const id = ids[index];
        const l = project.layers[id],
          container = new Container(),
          local = matrix(l.transform),
          world = multiply(parentWorld, local);
        container.setFromMatrix(new Matrix(local.a, local.b, local.c, local.d, local.tx, local.ty));
        container.visible = l.enabled && l.opacity > 0;
        if (!l.clippingBaseId) {
          clippingStack = undefined;
          if (project.layers[ids[index + 1]]?.clippingBaseId === id) {
            const stackContainer = new Container();
            const filter = new CompositeFilter(l.blendMode, false, l.opacity);
            stackContainer.filters = [filter];
            parent.addChild(stackContainer);
            clippingStack = { container: stackContainer, filter, parentWorld };
            this.filters++;
          }
        }
        const deferred = !l.clippingBaseId && !!clippingStack;
        const composite = new Container(),
          reveal = new Container(),
          content = new Container();
        container.addChild(composite);
        composite.addChild(reveal);
        reveal.addChild(content);
        const entry: SceneLayer = {
          container,
          composite,
          reveal,
          content,
          layer: l,
          world,
          baseWorld: world,
          local,
          renderLocal: local,
          parentId,
          bounds: layerBounds(project, id),
          visible: visible && container.visible,
          sprites: new Map(),
          ...(deferred ? { clippingStack } : {}),
        };
        // A group's opacity is applied after its children have composited. Clipping stacks
        // defer their base's mode/opacity until all source-atop children have been blended.
        const mode = deferred ? 'normal' : supportedBlend(l.blendMode);
        if (
          l.clippingBaseId ||
          mode !== 'normal' ||
          l.rasterMask?.enabled ||
          (l.kind === 'group' &&
            (l.opacity !== 1 ||
              l.isolation === 'isolated' ||
              Object.values(project.reveals).some((c) => c.layerId === id)))
        ) {
          entry.filter = new CompositeFilter(mode, !!l.clippingBaseId, deferred ? 1 : l.opacity);
          composite.filters = [entry.filter];
          this.filters++;
        } else container.alpha = deferred ? 1 : l.opacity;
        if (l.rasterMask?.enabled) {
          const root = new Container(),
            background = new Graphics();
          root.addChild(background);
          reveal.addChild(root);
          // Container masks default to stencil (binary coverage) in Pixi. Explicitly
          // use AlphaMask so grayscale/soft edges survive across all mask tiles.
          const effect = new AlphaMask({ mask: root });
          content.addEffect(effect);
          entry.maskView = { root, background, sprites: new Map(), effect };
        }
        (clippingStack?.container ?? parent).addChild(container);
        this.entries.set(id, entry);
        if (l.kind === 'group') visit(l.childrenBottomToTop, content, world, entry.visible, id);
      }
    };
    visit(project.rootLayersBottomToTop, this.root, matrix(identityTransform()), true);
    this.update();
  }
  select(id: string | null): void {
    this.selected = id;
    this.update();
  }
  animate(states: Record<string, RevealState>): void {
    if (!this.project || this.disposed) return;
    let visibilityChanged = false,
      moved = false;
    for (const [id, e] of this.entries) {
      const state = states[id],
        local = revealMatrix(e.local, e.bounds, state);
      if (
        (Object.keys(local) as (keyof Affine)[]).some(
          (k) => Math.abs(e.renderLocal[k] - local[k]) > 1e-9,
        )
      ) {
        e.container.setFromMatrix(
          new Matrix(local.a, local.b, local.c, local.d, local.tx, local.ty),
        );
        moved = true;
        e.renderLocal = local;
      }
      const parent = e.parentId ? this.entries.get(e.parentId) : undefined;
      e.world = parent ? multiply(parent.world, local) : local;
      const alpha = e.layer.opacity * (state?.alpha ?? 1);
      e.container.visible = e.layer.enabled && alpha > 0;
      const baseVisible = e.layer.clippingBaseId
        ? this.entries.get(e.layer.clippingBaseId)?.visible
        : true;
      const visible = (parent?.visible ?? true) && e.container.visible && !!baseVisible;
      if (visible !== e.visible) {
        visibilityChanged = true;
        e.visible = visible;
      }
      if (e.clippingStack) {
        e.clippingStack.filter.alpha = alpha;
        e.clippingStack.container.visible = visible;
        e.clippingStack.parentWorld = parent?.world ?? matrix(identityTransform());
      } else if (e.filter) e.filter.alpha = alpha;
      else e.container.alpha = alpha;
      const mask = state?.mask;
      if (mask?.kind === 'path') {
        if (
          !e.pathMask ||
          e.pathMask.arc !== mask.arc ||
          e.pathMask.width !== mask.width ||
          e.pathMask.reversed !== mask.reversed
        ) {
          e.reveal.mask = null;
          e.pathMask?.dispose();
          e.pathMask = new PathVectorMask(mask.arc, mask.width, mask.reversed);
          try {
            const m = inverse(e.baseWorld);
            e.pathMask.root.setFromMatrix(new Matrix(m.a, m.b, m.c, m.d, m.tx, m.ty));
          } catch {
            e.container.visible = false;
          }
          e.reveal.addChild(e.pathMask.root);
        }
        if (e.directionMask) e.directionMask.visible = false;
        if (mask.transform) {
          try {
            const m = multiply(inverse(e.world), mask.transform);
            e.pathMask.root.setFromMatrix(new Matrix(m.a, m.b, m.c, m.d, m.tx, m.ty));
          } catch {
            e.container.visible = false;
          }
        } else {
          try {
            const m = inverse(e.baseWorld);
            e.pathMask.root.setFromMatrix(new Matrix(m.a, m.b, m.c, m.d, m.tx, m.ty));
          } catch {
            e.container.visible = false;
          }
        }
        e.pathMask.root.visible = true;
        e.pathMask.setProgress(mask.progress);
        if (e.reveal.mask !== e.pathMask.root) e.reveal.mask = e.pathMask.root;
      } else if (mask?.kind === 'directional' || mask?.kind === 'fan') {
        if (e.pathMask) e.pathMask.root.visible = false;
        if (!e.directionMask) {
          e.directionMask = new Graphics();
          e.reveal.addChild(e.directionMask);
        }
        e.directionMask.visible = true;
        if (e.maskProgress !== mask.progress || e.maskClip !== state!.clipId) {
          const poly =
            mask.kind === 'fan'
              ? fanPolygon(e.bounds, mask.center, mask.startAngleRad, mask.sweepAngleRad)
              : directionalPolygon(mask.region ?? e.bounds, mask.direction, mask.progress);
          e.directionMask.clear();
          if (poly.length >= 3)
            e.directionMask
              .poly(
                poly.flatMap((p) => [p.x, p.y]),
                true,
              )
              .fill(0xffffff);
          e.maskProgress = mask.progress;
          e.maskClip = state!.clipId!;
        }
        if (e.reveal.mask !== e.directionMask) e.reveal.mask = e.directionMask;
      } else {
        if (e.reveal.mask) e.reveal.mask = null;
        if (e.pathMask) e.pathMask.root.visible = false;
        if (e.directionMask) e.directionMask.visible = false;
      }
    }
    // Texture requests are driven by visibility/viewport changes, not every opacity tick.
    if (visibilityChanged || (moved && performance.now() - this.lastReconcile > 80)) this.update();
  }
  update(): void {
    if (this.disposed || !this.project) return;
    cancelAnimationFrame(this.raf);
    this.raf = requestAnimationFrame(() => this.reconcile());
  }
  private reconcile(): void {
    if (this.disposed || !this.project) return;
    this.lastReconcile = performance.now();
    const { zoom, screen } = this.viewport;
    this.selectedLOD = null;
    const topLeft = this.viewport.toWorld({ x: 0, y: 0 });
    const destination = { ...topLeft, width: screen.width / zoom, height: screen.height / zoom };
    const viewport: Rect = cameraViewBounds(this.camera(), destination);
    if (this.documentFilter)
      this.root.filterArea = new Rectangle(viewport.x, viewport.y, viewport.width, viewport.height);
    const artwork = this.project.stage.artworkSize;
    // The artboard clips camera output. Source pixels outside the old board can move
    // into view after a pan; cull in inverse-camera source space, not board space.
    const x = Math.max(0, destination.x),
      y = Math.max(0, destination.y);
    const visible: Rect = cameraViewBounds(this.camera(), {
      x,
      y,
      width: Math.max(0, Math.min(artwork.width, destination.x + destination.width) - x),
      height: Math.max(0, Math.min(artwork.height, destination.y + destination.height) - y),
    });
    for (const entry of this.entries.values()) {
      if (entry.filter || entry.maskView) {
        // Pixi 8.22 transforms filterArea from container-local coordinates into screen space.
        // Invert the layer transform so large/rotated groups are clipped to the visible viewport.
        try {
          const local = transformed(viewport, inverse(entry.world));
          const area = new Rectangle(local.x, local.y, local.width, local.height);
          if (entry.filter) entry.composite.filterArea = area;
          if (entry.maskView) {
            entry.content.filterArea = area;
            entry.maskView.root.boundsArea = area;
            const mask = entry.layer.rasterMask!;
            const value = 1 - mask.density + mask.density * mask.defaultValue;
            const gray = Math.round(value * 255);
            const g = entry.maskView.background;
            g.clear()
              .rect(area.x, area.y, area.width, area.height)
              .fill((gray << 16) | (gray << 8) | gray);
            if (mask.sourceId) {
              const source = this.project.pixelSources[mask.sourceId];
              const left = Math.max(local.x, mask.position.x);
              const top = Math.max(local.y, mask.position.y);
              const right = Math.min(
                local.x + local.width,
                mask.position.x + source.originalBounds.width,
              );
              const bottom = Math.min(
                local.y + local.height,
                mask.position.y + source.originalBounds.height,
              );
              if (right > left && bottom > top)
                g.rect(left, top, right - left, bottom - top).fill(0xffffff);
            }
          }
        } catch {
          entry.container.visible = false;
        }
      }
      if (entry.clippingStack) {
        const stack = entry.clippingStack;
        try {
          const area = transformed(viewport, inverse(stack.parentWorld));
          stack.container.filterArea = new Rectangle(area.x, area.y, area.width, area.height);
        } catch {
          stack.container.visible = false;
        }
      }
    }
    type Wanted = {
      entry: SceneLayer;
      sprites: Map<string, Sprite>;
      parent: Container;
      offset: Vec2;
      isMask: boolean;
      tile: Project['pixelSources'][string]['levels'][number]['tiles'][number];
    };
    let wanted: Wanted[] = [];
    for (let bias = 0; bias < 24; bias++) {
      wanted = [];
      let bytes = 0;
      for (const [id, entry] of this.entries) {
        if (!entry.visible) continue;
        const planes = [];
        if (entry.layer.kind !== 'group')
          planes.push({
            sourceId: entry.layer.pixelSourceId,
            sprites: entry.sprites,
            parent: entry.content,
            offset: { x: 0, y: 0 },
            isMask: false,
          });
        if (entry.maskView && entry.layer.rasterMask?.sourceId)
          planes.push({
            sourceId: entry.layer.rasterMask.sourceId,
            sprites: entry.maskView.sprites,
            parent: entry.maskView.root,
            offset: entry.layer.rasterMask.position,
            isMask: true,
          });
        for (const plane of planes) {
          const source = this.project.pixelSources[plane.sourceId];
          const inLayer = (rect: Rect): Rect => ({
            ...rect,
            x: rect.x + plane.offset.x,
            y: rect.y + plane.offset.y,
          });
          if (
            !source.levels.length ||
            !intersects(transformed(inLayer(source.cropRect), entry.world), visible)
          )
            continue;
          const worldScale =
            Math.hypot(this.camera().a, this.camera().b) *
            Math.max(
              Math.hypot(entry.world.a, entry.world.b),
              Math.hypot(entry.world.c, entry.world.d),
            );
          const ideal = Math.max(
            0,
            Math.floor(Math.log2(1 / (zoom * worldScale * (window.devicePixelRatio || 1)))),
          );
          const level = source.levels.reduce(
            (best, l) =>
              l.level <= ideal + (id === this.selected ? 0 : bias) && l.level > best.level
                ? l
                : best,
            source.levels[0],
          );
          if (id === this.selected && !plane.isMask) this.selectedLOD = level.level;
          for (const tile of level.tiles)
            if (intersects(transformed(inLayer(tile.sourceRect), entry.world), visible)) {
              wanted.push({ entry, tile, ...plane });
              const size = this.project.assets[tile.assetId].pixelSize!;
              bytes += size.width * size.height * 4;
            }
        }
      }
      if (bytes <= this.cache.budgetBytes) break;
    }
    const wantedByPlane = new Map<Map<string, Sprite>, Set<string>>();
    for (const w of wanted) {
      if (!wantedByPlane.has(w.sprites)) wantedByPlane.set(w.sprites, new Set());
      wantedByPlane.get(w.sprites)!.add(w.tile.assetId);
    }
    this.desired = wanted.length;
    for (const entry of this.entries.values())
      for (const sprites of [entry.sprites, ...(entry.maskView ? [entry.maskView.sprites] : [])])
        for (const [id, sprite] of sprites)
          if (!wantedByPlane.get(sprites)?.has(id)) {
            sprite.destroy();
            sprites.delete(id);
          }
    this.cache.request(
      wanted.map(({ tile }) => ({
        asset: this.project!.assets[tile.assetId],
        frame: tile.pixelRect,
      })),
    );
    for (const { entry, tile, sprites, parent, offset, isMask } of wanted) {
      const texture = this.cache.get(tile.assetId);
      if (texture && !sprites.has(tile.assetId)) {
        const sprite = new Sprite(texture);
        sprite.position.set(tile.sourceRect.x + offset.x, tile.sourceRect.y + offset.y);
        sprite.width = tile.sourceRect.width;
        sprite.height = tile.sourceRect.height;
        if (isMask) sprite.alpha = entry.layer.rasterMask!.density;
        parent.addChild(sprite);
        sprites.set(tile.assetId, sprite);
      }
    }
    // Never display unmasked pixels while the mask's visible tiles are still loading.
    for (const entry of this.entries.values())
      if (entry.maskView)
        entry.composite.renderable = [...(wantedByPlane.get(entry.maskView.sprites) ?? [])].every(
          (id) => entry.maskView!.sprites.has(id),
        );
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
      isolatedGroups: [...this.entries.values()].filter((e) => e.layer.kind === 'group' && e.filter)
        .length,
      compositeFilters: this.filters,
      vectorMasks: [...this.entries.values()].filter((e) => !!e.reveal.mask).length,
      rasterMasks: [...this.entries.values()].filter((e) => !!e.maskView).length,
      clippingStacks: [...this.entries.values()].filter((e) => !!e.clippingStack).length,
      pathMaskChunks: [...this.entries.values()].reduce(
        (n, e) => n + (e.pathMask?.stats().chunks ?? 0),
        0,
      ),
      pathMaskBoundaryUpdates: [...this.entries.values()].reduce(
        (n, e) => n + (e.pathMask?.stats().boundaryUpdates ?? 0),
        0,
      ),
      maskBitmapBytes: [...this.entries.values()].reduce(
        (sum, e) =>
          sum +
          [...(e.maskView?.sprites.values() ?? [])].reduce(
            (n, s) => n + s.texture.source.pixelWidth * s.texture.source.pixelHeight * 4,
            0,
          ),
        0,
      ),
      filterViewportRgbaBytesEstimate:
        this.filters *
        this.viewport.screen.width *
        this.viewport.screen.height *
        4 *
        (window.devicePixelRatio || 1) ** 2,
    };
  }
  private clear(): void {
    this.root.filters = [];
    this.documentFilter?.destroy();
    this.documentFilter = undefined;
    for (const e of this.entries.values()) {
      e.filter?.destroy();
      e.clippingStack?.filter.destroy();
      if (e.maskView) {
        e.content.removeEffect(e.maskView.effect);
        e.maskView.effect.destroy();
      }
    }
    this.root.removeChildren().forEach((c) => c.destroy({ children: true, context: true }));
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
