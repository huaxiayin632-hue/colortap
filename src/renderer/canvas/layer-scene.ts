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
import { equalData, sameProjectParts } from '../../core/project';
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
  filterKey?: string;
  clippingStack?: {
    container: Container;
    filter: CompositeFilter;
    parentWorld: Affine;
    mode: string;
  };
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
  private levelBias = 0;
  private desiredBytes = 0;
  private needsReconcile = false;
  private filters = 0;
  private documentFilter?: CompositeFilter;
  private disposed = false;
  private created = 0;
  private removed = 0;
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
  setTextureBudget(bytes: number): void {
    this.cache.setBudget(bytes);
    this.update();
  }
  setProject(project: Project): void {
    if (this.project === project) return;
    const unchanged = sameProjectParts(this.project, project, [
      'layers',
      'rootLayersBottomToTop',
      'pixelSources',
      'reveals',
      'paths',
    ]);
    if (this.project && this.project.id !== project.id) this.clear();
    const previous = this.project;
    this.project = project;
    if (unchanged) {
      this.update();
      return;
    }
    const topology = (p: Project | null) =>
      p && [
        p.rootLayersBottomToTop,
        Object.values(p.layers).map((l) => [
          l.id,
          l.kind,
          l.clippingBaseId,
          l.kind === 'group' ? l.childrenBottomToTop : null,
        ]),
      ];
    const restructure = !equalData(topology(previous), topology(project));
    // Detach before reparenting: even a parent/child reversal must never form a transient cycle.
    if (restructure)
      for (const e of this.entries.values()) {
        e.container.removeFromParent();
        e.clippingStack?.container.removeFromParent();
      }
    const needsBackdrop = Object.values(project.layers).some(
      (l) => supportedBlend(l.blendMode) !== 'normal',
    );
    if (needsBackdrop && !this.documentFilter) this.documentFilter = new CompositeFilter('normal');
    if (!needsBackdrop && this.documentFilter) {
      this.root.filters = [];
      this.documentFilter.destroy();
      this.documentFilter = undefined;
    }
    this.root.filters = this.documentFilter ? [this.documentFilter] : [];
    const next = new Map<string, SceneLayer>();
    const visit = (
      ids: string[],
      parent: Container,
      parentWorld: Affine,
      visible: boolean,
      parentId: string | null = null,
    ) => {
      let stack: SceneLayer['clippingStack'];
      for (let index = 0; index < ids.length; index++) {
        const id = ids[index],
          l = project.layers[id],
          local = matrix(l.transform),
          world = multiply(parentWorld, local);
        let e = this.entries.get(id);
        if (e && e.layer.kind !== l.kind) {
          this.destroyEntry(e);
          e = undefined;
        }
        if (!e) {
          const container = new Container(),
            composite = new Container(),
            reveal = new Container(),
            content = new Container();
          container.addChild(composite);
          composite.addChild(reveal);
          reveal.addChild(content);
          e = {
            container,
            composite,
            reveal,
            content,
            layer: l,
            local,
            world,
            baseWorld: world,
            renderLocal: local,
            parentId,
            bounds: layerBounds(project, id),
            visible: false,
            sprites: new Map(),
          };
          this.created++;
        }
        const old = e.layer;
        if (
          old.kind !== 'group' &&
          l.kind !== 'group' &&
          (old.pixelSourceId !== l.pixelSourceId ||
            previous?.pixelSources[old.pixelSourceId] !== project.pixelSources[l.pixelSourceId])
        )
          this.clearSprites(e.sprites);
        if (
          old !== l ||
          previous?.layers !== project.layers ||
          previous?.pixelSources !== project.pixelSources ||
          previous?.reveals !== project.reveals ||
          previous?.paths !== project.paths
        ) {
          e.bounds = layerBounds(project, id);
          e.maskProgress = undefined;
        }
        e.layer = l;
        e.local = local;
        e.renderLocal = local;
        e.world = world;
        e.baseWorld = world;
        e.parentId = parentId;
        e.container.setFromMatrix(
          new Matrix(local.a, local.b, local.c, local.d, local.tx, local.ty),
        );
        e.container.visible = l.enabled && l.opacity > 0;
        e.visible = visible && e.container.visible;
        if (!l.clippingBaseId) stack = undefined;
        const deferred = !l.clippingBaseId && project.layers[ids[index + 1]]?.clippingBaseId === id;
        if (deferred) {
          if (!e.clippingStack)
            e.clippingStack = {
              container: new Container(),
              filter: new CompositeFilter(l.blendMode),
              parentWorld,
              mode: l.blendMode,
            };
          stack = e.clippingStack;
          if (stack.mode !== l.blendMode) {
            stack.filter.destroy();
            stack.filter = new CompositeFilter(l.blendMode);
            stack.mode = l.blendMode;
          }
          stack.filter.alpha = l.opacity;
          stack.parentWorld = parentWorld;
          stack.container.filters = [stack.filter];
          stack.container.visible = e.visible;
          if (stack.container.parent !== parent) parent.addChild(stack.container);
        } else if (e.clippingStack) {
          e.container.removeFromParent();
          e.clippingStack.container.removeChildren();
          e.clippingStack.filter.destroy();
          e.clippingStack.container.destroy();
          e.clippingStack = undefined;
        }
        const mode = deferred ? 'normal' : supportedBlend(l.blendMode);
        const needsFilter =
          l.clippingBaseId ||
          mode !== 'normal' ||
          l.rasterMask?.enabled ||
          (l.kind === 'group' &&
            (l.opacity !== 1 ||
              l.isolation === 'isolated' ||
              Object.values(project.reveals).some((c) => c.layerId === id)));
        const filterKey = needsFilter ? `${mode}:${!!l.clippingBaseId}` : undefined;
        if (e.filterKey !== filterKey) {
          e.composite.filters = [];
          e.filter?.destroy();
          e.filter = filterKey ? new CompositeFilter(mode, !!l.clippingBaseId) : undefined;
          e.filterKey = filterKey;
        }
        e.composite.filters = e.filter ? [e.filter] : [];
        e.container.alpha = e.filter || deferred ? 1 : l.opacity;
        if (e.filter) e.filter.alpha = deferred ? 1 : l.opacity;
        if (l.rasterMask?.enabled) {
          if (!e.maskView) {
            const root = new Container(),
              background = new Graphics();
            root.addChild(background);
            e.reveal.addChild(root);
            const effect = new AlphaMask({ mask: root });
            e.content.addEffect(effect);
            e.maskView = { root, background, sprites: new Map(), effect };
          } else if (
            old.rasterMask?.sourceId !== l.rasterMask.sourceId ||
            (l.rasterMask.sourceId &&
              previous?.pixelSources[l.rasterMask.sourceId] !==
                project.pixelSources[l.rasterMask.sourceId])
          )
            this.clearSprites(e.maskView.sprites);
        } else if (e.maskView) {
          e.content.removeEffect(e.maskView.effect);
          e.maskView.effect.destroy();
          e.maskView.root.destroy({ children: true, context: true });
          e.maskView = undefined;
        }
        const destination = stack?.container ?? parent;
        if (e.container.parent !== destination) destination.addChild(e.container);
        next.set(id, e);
        if (l.kind === 'group') visit(l.childrenBottomToTop, e.content, world, e.visible, id);
      }
    };
    visit(project.rootLayersBottomToTop, this.root, matrix(identityTransform()), true);
    for (const [id, entry] of this.entries) if (!next.has(id)) this.destroyEntry(entry);
    this.entries = next;
    this.filters =
      Number(!!this.documentFilter) +
      [...next.values()].reduce((n, e) => n + Number(!!e.filter) + Number(!!e.clippingStack), 0);
    this.update();
  }
  private clearSprites(sprites: Map<string, Sprite>): void {
    for (const sprite of sprites.values()) sprite.destroy();
    sprites.clear();
  }
  private destroyEntry(e: SceneLayer): void {
    e.filter?.destroy();
    e.clippingStack?.filter.destroy();
    if (e.maskView) {
      e.content.removeEffect(e.maskView.effect);
      e.maskView.effect.destroy();
    }
    e.container.destroy({ children: true, context: true });
    e.clippingStack?.container.destroy();
    this.removed++;
  }
  select(id: string | null): void {
    if (this.selected === id) return;
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
    if (visibilityChanged || moved) this.update();
  }
  update(): void {
    if (this.disposed || !this.project) return;
    this.needsReconcile = true;
    this.changed();
  }
  flush(): void {
    if (!this.needsReconcile) return;
    this.needsReconcile = false;
    this.reconcile();
  }
  private reconcile(): void {
    if (this.disposed || !this.project) return;
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
      this.levelBias = bias;
      this.desiredBytes = bytes;
      if (bytes <= this.cache.budgetBytes) break;
    }
    const wantedByPlane = new Map<Map<string, Sprite>, Set<string>>();
    for (const w of wanted) {
      if (!wantedByPlane.has(w.sprites)) wantedByPlane.set(w.sprites, new Set());
      wantedByPlane.get(w.sprites)!.add(w.tile.assetId);
    }
    this.desired = wanted.length;
    const byPlane = new Map<Map<string, Sprite>, Wanted[]>();
    for (const w of wanted) {
      if (!byPlane.has(w.sprites)) byPlane.set(w.sprites, []);
      byPlane.get(w.sprites)!.push(w);
    }
    const requests: Wanted[] = [];
    for (const entry of this.entries.values()) {
      for (const sprites of [entry.sprites, ...(entry.maskView ? [entry.maskView.sprites] : [])]) {
        const target = byPlane.get(sprites) ?? [];
        const failedReplacement =
          sprites.size > 0 && target.some((w) => this.cache.hasFailed(w.tile.assetId));
        // A failed replacement must not pin a partial new LOD forever alongside the fallback.
        if (!failedReplacement) requests.push(...target);
        // Retain one complete representation until the replacement is ready: drawing both
        // LODs together would double the alpha of translucent artwork and masks.
        const ready = target.every((w) => !!this.cache.get(w.tile.assetId));
        if (!failedReplacement && (ready || sprites.size === 0)) {
          for (const [id, sprite] of sprites)
            if (!wantedByPlane.get(sprites)?.has(id)) {
              sprite.destroy();
              sprites.delete(id);
            }
          for (const w of target) {
            const texture = this.cache.get(w.tile.assetId);
            if (texture && !sprites.has(w.tile.assetId)) {
              const sprite = new Sprite(texture);
              w.parent.addChild(sprite);
              sprites.set(w.tile.assetId, sprite);
            }
          }
        }
        // Mask position/density edits also apply to retained tiles.
        for (const [id, sprite] of sprites) {
          const isMask = sprites === entry.maskView?.sprites;
          const sourceId = isMask
            ? entry.layer.rasterMask?.sourceId
            : entry.layer.kind !== 'group'
              ? entry.layer.pixelSourceId
              : undefined;
          const tile = sourceId
            ? this.project.pixelSources[sourceId].levels
                .flatMap((l) => l.tiles)
                .find((t) => t.assetId === id)
            : undefined;
          if (!tile) continue;
          const offset = isMask ? entry.layer.rasterMask!.position : { x: 0, y: 0 };
          sprite.position.set(tile.sourceRect.x + offset.x, tile.sourceRect.y + offset.y);
          sprite.width = tile.sourceRect.width;
          sprite.height = tile.sourceRect.height;
          if (isMask) sprite.alpha = entry.layer.rasterMask!.density;
        }
      }
      if (entry.maskView) {
        const mask = entry.layer.rasterMask!,
          view = entry.maskView,
          area = view.root.boundsArea;
        if (area) {
          const gray = Math.round((1 - mask.density + mask.density * mask.defaultValue) * 255);
          const g = view.background;
          g.clear()
            .rect(area.x, area.y, area.width, area.height)
            .fill((gray << 16) | (gray << 8) | gray);
          if (mask.sourceId) {
            const source = this.project.pixelSources[mask.sourceId];
            // Unknown mask pixels remain black, even when panning exposes a new region.
            g.rect(
              mask.position.x,
              mask.position.y,
              source.originalBounds.width,
              source.originalBounds.height,
            ).fill(0);
            for (const sprite of view.sprites.values())
              g.rect(sprite.x, sprite.y, sprite.width, sprite.height).fill(0xffffff);
          }
        }
      }
    }
    const retained = [...this.entries.values()].flatMap((e) => [
      ...e.sprites.keys(),
      ...(e.maskView?.sprites.keys() ?? []),
    ]);
    // Selection first, then the amount of visible artwork each tile contributes.
    // Sorting only changes loading order; compositing order remains unchanged.
    const coverage = (w: Wanted) => {
      const r = transformed(
        {
          ...w.tile.sourceRect,
          x: w.tile.sourceRect.x + w.offset.x,
          y: w.tile.sourceRect.y + w.offset.y,
        },
        w.entry.world,
      );
      return (
        Math.max(0, Math.min(r.x + r.width, visible.x + visible.width) - Math.max(r.x, visible.x)) *
        Math.max(0, Math.min(r.y + r.height, visible.y + visible.height) - Math.max(r.y, visible.y))
      );
    };
    requests.sort(
      (a, b) =>
        Number(b.entry.layer.id === this.selected) - Number(a.entry.layer.id === this.selected) ||
        coverage(b) - coverage(a),
    );
    this.cache.request(
      requests.map(({ tile }) => ({
        asset: this.project!.assets[tile.assetId],
        frame: tile.pixelRect,
      })),
      retained,
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
      desiredRgbaBytesEstimate: this.desiredBytes,
      levelBias: this.levelBias,
      sceneLayersCreated: this.created,
      sceneLayersRemoved: this.removed,
      displayedTiles: [...this.entries.values()].reduce((n, e) => n + e.sprites.size, 0),
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
    for (const e of this.entries.values()) e.container.removeFromParent();
    for (const e of this.entries.values()) this.destroyEntry(e);
    this.root.removeChildren();
    this.entries.clear();
    this.filters = 0;
  }
  dispose(): void {
    this.disposed = true;
    this.needsReconcile = false;
    this.clear();
    this.cache.dispose();
    this.root.destroy();
    this.selection.destroy();
  }
}
