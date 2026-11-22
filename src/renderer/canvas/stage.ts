import type { CommandTarget } from '../commands/context';
// Pixi's static uniform adapters support the strict CSP without enabling string evaluation.
import 'pixi.js/unsafe-eval';
import './alpha-mask-pipe';
import { watch, type WatchStopHandle } from 'vue';
import { equalData } from '../../core/project';
import { RenderRequest } from '../../core/render-request';
import { Application, Container, Graphics, Matrix, type WebGLRenderer } from 'pixi.js';
import { Viewport } from '../../core/viewport';
import type { RenderCapabilities } from '../../core/tiles';
import type { Project, Size, Vec2 } from '../../shared/models';
import { LayerScene } from './layer-scene';
import { FrameRecorder } from '../../core/performance';
import { ChartScene } from '../chart/scene';
import type { ChartController } from '../chart/controller';
import type { RevealController } from '../reveals/controller';
import { RevealPathScene } from '../reveals/path-scene';
import { OutlineScene } from '../reveals/outline-scene';
import type { CameraController } from '../camera/controller';
import { cameraMatrix } from '../../core/camera';
import { inverse, point, type Affine } from '../../core/layers';
import { textureBudgetMiB } from './preferences';

export class EditorStage {
  readonly viewport = new Viewport();
  private readonly app = new Application();
  private readonly world = new Container();
  private readonly board = new Graphics();
  private readonly grid = new Graphics();
  private readonly artwork = new Container();
  private readonly illustration = new Container();
  private readonly cameraFrame = new Graphics();
  private camera: CameraController | null = null;
  private cameraTransform: Affine = { a: 1, b: 0, c: 0, d: 1, tx: 0, ty: 0 };
  private cameraDrag = false;

  private readonly artworkClip = new Graphics();
  private readonly bounds = new Graphics();
  private readonly renderFrames = new FrameRecorder();
  private readonly rendering = new RenderRequest((timestamp) => this.render(timestamp));
  private readonly watchers: WatchStopHandle[] = [];
  private renderCount = 0;
  private lastRender = 0;
  private gpu: {
    vendor: string;
    renderer: string;
    unmaskedVendor: string | null;
    unmaskedRenderer: string | null;
  } | null = null;
  private scene: LayerScene | null = null;
  private chartScene: ChartScene | null = null;
  private chartDrag = false;
  private revealDrag = false;
  private revealScene: RevealPathScene | null = null;
  private reveals: RevealController | null = null;
  private outlineScene: OutlineScene | null = null;
  private selected: string | null = null;
  private moveStart: Vec2 | null = null;
  onSelect: ((id: string | null) => void) | null = null;
  onMoveLayer: ((id: string, delta: Vec2, commit: boolean) => void) | null = null;
  onAssetError: ((error: string) => void) | null = null;
  private size: Size = { width: 6000, height: 6000 };
  private observer: ResizeObserver | null = null;
  private drag: { id: number; x: number; y: number } | null = null;
  private disposed = false;
  private initialized = false;
  capabilities: RenderCapabilities | null = null;
  onChange: (() => void) | null = null;
  onContextLost: (() => void) | null = null;
  constructor(private readonly host: HTMLElement) {
    this.watchers.push(
      watch(textureBudgetMiB, (value) => this.scene?.setTextureBudget(value * 1024 * 1024)),
    );
  }
  async initialize(): Promise<void> {
    await this.app.init({
      preference: 'webgl',
      powerPreference: 'high-performance',
      autoStart: false,
      sharedTicker: false,
      useBackBuffer: true,
      antialias: true,
      background: 0x202226,
      resolution: window.devicePixelRatio || 1,
      autoDensity: true,
      width: Math.max(1, this.host.clientWidth),
      height: Math.max(1, this.host.clientHeight),
    });
    if (this.disposed) {
      this.app.destroy(true);
      return;
    }
    this.initialized = true;
    const canvas = this.app.canvas;
    canvas.tabIndex = 0;
    canvas.setAttribute('aria-label', 'PixiJS 编辑画布，空白或中键拖动平移，滚轮缩放');
    canvas.setAttribute('data-testid', 'pixi-canvas');
    this.host.append(canvas);
    const gl = (this.app.renderer as WebGLRenderer).gl;
    const viewport = gl.getParameter(gl.MAX_VIEWPORT_DIMS) as Int32Array;
    const debug = gl.getExtension('WEBGL_debug_renderer_info');
    this.gpu = {
      vendor: gl.getParameter(gl.VENDOR),
      renderer: gl.getParameter(gl.RENDERER),
      unmaskedVendor: debug ? gl.getParameter(debug.UNMASKED_VENDOR_WEBGL) : null,
      unmaskedRenderer: debug ? gl.getParameter(debug.UNMASKED_RENDERER_WEBGL) : null,
    };
    this.capabilities = {
      maxTextureSize: gl.getParameter(gl.MAX_TEXTURE_SIZE),
      maxRenderbufferSize: gl.getParameter(gl.MAX_RENDERBUFFER_SIZE),
      maxViewport: { width: viewport[0], height: viewport[1] },
    };
    this.world.addChild(this.board, this.grid, this.artwork, this.artworkClip, this.bounds);
    this.artwork.addChild(this.illustration, this.cameraFrame);
    this.artwork.mask = this.artworkClip;
    this.updateArtworkClip();
    this.app.stage.addChild(this.world);
    canvas.addEventListener('wheel', this.onWheel, { passive: false });
    canvas.addEventListener('pointerdown', this.onDown);
    canvas.addEventListener('pointermove', this.onMove);
    canvas.addEventListener('pointerup', this.onUp);
    canvas.addEventListener('pointercancel', this.onUp);
    canvas.addEventListener('pointerleave', this.onLeave);
    canvas.addEventListener('dblclick', this.onDoubleClick);
    canvas.addEventListener('webglcontextlost', this.contextLost);
    canvas.addEventListener('webglcontextrestored', this.contextRestored);
    this.observer = new ResizeObserver(() => this.resize());
    this.observer.observe(this.host);
    this.resize();
    this.fit();
  }
  private render(timestamp: number): void {
    if (
      !this.initialized ||
      this.disposed ||
      (this.app.renderer as WebGLRenderer).gl.isContextLost()
    )
      return;
    if (timestamp - this.lastRender > 250) this.renderFrames.resume();
    this.lastRender = timestamp;
    if (document.hidden) this.renderFrames.resume();
    else this.renderFrames.frame(performance.now());
    this.grid.visible = this.chartScene?.chart.mode.value === 'edit';
    if (this.camera) {
      const m = cameraMatrix(this.camera.document.value, this.camera.pose.value);
      if (
        (Object.keys(m) as (keyof Affine)[]).some(
          (k) => Math.abs(m[k] - this.cameraTransform[k]) > 1e-8,
        )
      ) {
        this.cameraTransform = m;
        this.scene?.update();
        this.illustration.setFromMatrix(new Matrix(m.a, m.b, m.c, m.d, m.tx, m.ty));
      }
      this.cameraFrame.visible =
        this.camera.showFrame.value && this.chartScene?.chart.mode.value === 'edit';
      if (this.cameraFrame.visible) {
        const unit = 1 / this.viewport.zoom,
          p = this.camera.pose.value.pivot ?? { x: this.size.width / 2, y: this.size.height / 2 },
          q = point(m, p);
        this.cameraFrame
          .clear()
          .rect(0, 0, this.size.width, this.size.height)
          .stroke({ color: 0xe9b76f, width: unit * 1.5, alpha: 0.7 });
        if (this.camera.tool.value !== 'none')
          this.cameraFrame
            .moveTo(q.x - 8 * unit, q.y)
            .lineTo(q.x + 8 * unit, q.y)
            .moveTo(q.x, q.y - 8 * unit)
            .lineTo(q.x, q.y + 8 * unit)
            .stroke({ color: 0xe9b76f, width: unit * 2 });
      }
    }
    this.chartScene?.draw();
    this.scene?.animate(this.reveals?.states.value ?? {});
    if (this.reveals)
      this.outlineScene?.draw(this.reveals.states.value, this.reveals.document.value);
    if (this.scene) this.scene.selection.visible = this.chartScene?.chart.mode.value === 'edit';
    this.revealScene?.draw();
    this.scene?.flush();
    this.app.render();
    this.host.dataset.renderCount = String(++this.renderCount);
  }
  invalidate = (): void => {
    this.rendering.request();
  };
  private observe(sources: Parameters<typeof watch>[0]): void {
    this.watchers.push(
      watch(sources, (next, previous) => {
        if (!equalData(next, previous)) this.invalidate();
      }),
    );
  }

  private contextLost = (event: Event): void => {
    event.preventDefault();
    this.onContextLost?.();
  };
  private contextRestored = (): void => {
    this.draw();
  };
  private onWheel = (event: WheelEvent): void => {
    event.preventDefault();
    const rect = this.app.canvas.getBoundingClientRect();
    if (
      this.camera &&
      this.camera.tool.value !== 'none' &&
      this.chartScene?.chart.mode.value === 'edit' &&
      !event.altKey
    ) {
      this.camera.zoomAt(
        this.viewport.toWorld({ x: event.clientX - rect.left, y: event.clientY - rect.top }),
        event.shiftKey ? 1 : Math.exp(-event.deltaY * 0.0015),
        event.shiftKey ? -event.deltaY * 0.0005 : 0,
      );
      return;
    }
    this.viewport.zoomAt(
      { x: event.clientX - rect.left, y: event.clientY - rect.top },
      this.viewport.zoom * Math.exp(-event.deltaY * 0.0015),
    );
    this.draw();
  };
  private onDown = (event: PointerEvent): void => {
    if (event.button !== 0 && event.button !== 1) return;
    event.preventDefault();
    this.app.canvas.focus({ preventScroll: true });
    this.drag = { id: event.pointerId, x: event.clientX, y: event.clientY };
    const rect = this.app.canvas.getBoundingClientRect();
    const at = this.viewport.toWorld({ x: event.clientX - rect.left, y: event.clientY - rect.top });
    if (
      event.button === 0 &&
      !event.altKey &&
      this.camera?.tool.value !== 'none' &&
      this.camera &&
      this.chartScene?.chart.mode.value === 'edit'
    ) {
      this.cameraDrag = true;
      this.camera.down(this.camera.tool.value === 'pivot' ? this.artPoint(at) : at);
      this.app.canvas.setPointerCapture(event.pointerId);
      return;
    }
    if (event.button === 0 && !event.altKey && this.revealScene?.active()) {
      this.revealDrag = true;
      this.revealScene.down(this.artPoint(at));
      this.app.canvas.setPointerCapture(event.pointerId);
      return;
    }
    if (event.button === 0 && !event.altKey && this.chartActive()) {
      this.chartDrag = true;
      this.chartScene!.down(at, event.shiftKey);
      this.app.canvas.setPointerCapture(event.pointerId);
      return;
    }
    const hit = event.button === 0 && !event.altKey ? this.scene?.hit(this.artPoint(at)) : null;
    if (hit) {
      this.onSelect?.(hit);
      this.moveStart = this.artPoint(at);
    } else if (event.button === 0 && !event.altKey) this.onSelect?.(null);
    this.app.canvas.setPointerCapture(event.pointerId);
    this.app.canvas.style.cursor = 'grabbing';
  };
  private onMove = (event: PointerEvent): void => {
    if (this.cameraDrag && this.camera) {
      const at = this.eventWorld(event);
      this.camera.move(this.camera.tool.value === 'pivot' ? this.artPoint(at) : at);
      return;
    }
    if (this.revealScene?.active() && (this.revealDrag || !this.drag))
      this.revealScene.move(this.artPoint(this.eventWorld(event)));
    if (this.revealDrag) return;
    if (this.chartActive() && (this.chartDrag || !this.drag))
      this.chartScene!.move(this.eventWorld(event));
    if (this.chartDrag) return;
    if (!this.drag || this.drag.id !== event.pointerId) return;
    if (this.moveStart && this.selected) {
      const rect = this.app.canvas.getBoundingClientRect();
      const at = this.viewport.toWorld({
        x: event.clientX - rect.left,
        y: event.clientY - rect.top,
      });
      this.onMoveLayer?.(
        this.selected,
        { x: this.artPoint(at).x - this.moveStart.x, y: this.artPoint(at).y - this.moveStart.y },
        false,
      );
      return;
    }
    this.viewport.pan.x += event.clientX - this.drag.x;
    this.viewport.pan.y += event.clientY - this.drag.y;
    this.drag = { id: event.pointerId, x: event.clientX, y: event.clientY };
    this.draw();
    if (this.chartActive()) this.chartScene!.move(this.eventWorld(event));
  };
  private onUp = (event: PointerEvent): void => {
    if (this.drag?.id === event.pointerId) {
      if (this.cameraDrag && this.camera) {
        const at = this.eventWorld(event);
        this.camera.up(
          this.camera.tool.value === 'pivot' ? this.artPoint(at) : at,
          event.type === 'pointercancel',
        );
      } else if (this.revealDrag)
        this.revealScene?.up(this.artPoint(this.eventWorld(event)), event.type === 'pointercancel');
      else if (this.chartDrag)
        this.chartScene?.up(this.eventWorld(event), event.type === 'pointercancel');
      else if (this.moveStart && this.selected) {
        const rect = this.app.canvas.getBoundingClientRect();
        const at = this.viewport.toWorld({
          x: event.clientX - rect.left,
          y: event.clientY - rect.top,
        });
        this.onMoveLayer?.(
          this.selected,
          event.type === 'pointercancel'
            ? { x: 0, y: 0 }
            : {
                x: this.artPoint(at).x - this.moveStart.x,
                y: this.artPoint(at).y - this.moveStart.y,
              },
          true,
        );
      }
      this.moveStart = null;
      this.chartDrag = false;
      this.revealDrag = false;
      this.cameraDrag = false;
      this.drag = null;
      this.app.canvas.style.cursor = 'grab';
      if (this.app.canvas.hasPointerCapture(event.pointerId))
        this.app.canvas.releasePointerCapture(event.pointerId);
    }
  };
  contextTarget(event: MouseEvent): CommandTarget {
    const at = this.eventWorld(event);
    if (this.revealScene?.active()) {
      const id = this.revealScene.contextNode(this.artPoint(at));
      return id ? { kind: 'reveal', ids: [id] } : null;
    }
    if (this.chartActive()) {
      const id = this.chartScene?.contextTarget(at);
      return id ? { kind: 'notes', ids: [id] } : null;
    }
    const id = this.scene?.hit(this.artPoint(at));
    return id ? { kind: 'layer', ids: [id] } : null;
  }
  private eventWorld(event: MouseEvent): Vec2 {
    const rect = this.app.canvas.getBoundingClientRect();
    return this.viewport.toWorld({ x: event.clientX - rect.left, y: event.clientY - rect.top });
  }
  private artPoint(at: Vec2): Vec2 {
    return point(inverse(this.cameraTransform), at);
  }
  private chartActive(): boolean {
    return (
      !!this.chartScene &&
      (this.chartScene.chart.mode.value !== 'edit' || this.chartScene.chart.tool.value !== 'layers')
    );
  }
  private onLeave = (): void => {
    if (!this.drag) this.chartScene?.chart.setPointer(null);
  };
  private onDoubleClick = (event: MouseEvent): void => {
    if (this.revealScene?.active()) {
      this.revealScene.doubleClick(this.artPoint(this.eventWorld(event)));
      return;
    }
    if (this.chartActive()) this.chartScene?.doubleClick(this.eventWorld(event));
  };
  private resize(): void {
    if (!this.initialized || this.disposed) return;
    const width = Math.max(1, this.host.clientWidth);
    const height = Math.max(1, this.host.clientHeight);
    const previous = this.viewport.screen;
    this.app.renderer.resize(width, height, window.devicePixelRatio || 1);
    this.viewport.screen = { width, height };
    this.viewport.pan.x += (width - previous.width) / 2;
    this.viewport.pan.y += (height - previous.height) / 2;
    this.draw();
  }
  setArtwork(size: Size, fit = false): void {
    if (this.size.width === size.width && this.size.height === size.height && !fit) return;
    this.size = { ...size };
    this.updateArtworkClip();
    if (fit) this.fit();
    else this.draw();
  }
  setScene(project: Project, handle: string): void {
    if (!this.initialized) return;
    if (this.scene?.handle !== handle) {
      this.scene?.dispose();
      this.scene = new LayerScene(
        handle,
        this.viewport,
        this.capabilities!.maxTextureSize,
        () => {
          const stats = this.scene?.stats();
          this.host.dataset.textures = String(stats?.residentTextures ?? 0);
          this.host.dataset.loading = String((stats?.loading ?? 0) + (stats?.queued ?? 0));
          this.onChange?.();
          this.invalidate();
        },
        (error) => this.onAssetError?.(error),
        () => this.cameraTransform,
      );
      this.illustration.addChild(this.scene.root, this.scene.selection);
      this.scene.setTextureBudget(textureBudgetMiB.value * 1024 * 1024);
      if (this.chartScene) this.artwork.addChild(this.chartScene.root);
      if (this.outlineScene) this.illustration.addChild(this.outlineScene.root);
      if (this.revealScene) this.illustration.addChild(this.revealScene.root);
    }
    this.scene.setProject(project);
    this.scene.select(this.selected);
    this.invalidate();
  }
  select(id: string | null): void {
    this.selected = id;
    this.scene?.select(id);
    this.invalidate();
  }
  setChart(chart: ChartController): void {
    this.chartScene?.dispose();
    this.chartScene = new ChartScene(chart, () => this.viewport.zoom);
    this.artwork.addChild(this.chartScene.root);
    this.observe([
      chart.document,
      chart.mode,
      chart.tool,
      chart.timeUs,
      chart.selected,
      chart.nodeId,
      chart.runtime,
      chart.pointer,
      chart.selectionBox,
      chart.sliderDraft,
      chart.sliderCursor,
    ]);
    this.invalidate();
  }
  setReveals(reveals: RevealController): void {
    this.reveals = reveals;
    this.revealScene?.dispose();
    this.outlineScene?.dispose();
    this.outlineScene = new OutlineScene();
    this.revealScene = new RevealPathScene(reveals, () => this.viewport.zoom);
    this.illustration.addChild(this.outlineScene.root, this.revealScene.root);
    this.observe([
      reveals.document,
      reveals.states,
      reveals.pathEditing,
      reveals.nodeId,
      reveals.drawing,
      reveals.draftPoints,
      reveals.hover,
      reveals.selectedId,
    ]);
    this.invalidate();
  }
  setCamera(camera: CameraController): void {
    this.camera = camera;
    this.observe([camera.document, camera.pose, camera.showFrame, camera.tool]);
    this.invalidate();
  }
  fit(): void {
    this.viewport.fit(this.size);
    this.draw();
  }
  setZoom(zoom: number): void {
    this.viewport.zoomAt(
      { x: this.viewport.screen.width / 2, y: this.viewport.screen.height / 2 },
      zoom,
    );
    this.draw();
  }
  private updateArtworkClip(): void {
    // One vector rectangle, rebuilt only on a size change; no full-resolution mask texture.
    this.artworkClip.clear().rect(0, 0, this.size.width, this.size.height).fill(0xffffff);
  }
  private draw(): void {
    if (!this.initialized || this.disposed) return;
    const { zoom, pan, screen } = this.viewport;
    this.world.scale.set(zoom);
    this.world.position.set(pan.x, pan.y);
    this.board.clear().rect(0, 0, this.size.width, this.size.height).fill(0x2d3136);
    this.bounds
      .clear()
      .rect(0, 0, this.size.width, this.size.height)
      .stroke({ color: 0x75818c, width: 1 / zoom });
    const topLeft = this.viewport.toWorld({ x: 0, y: 0 });
    const bottomRight = this.viewport.toWorld({ x: screen.width, y: screen.height });
    const base = 10 ** Math.floor(Math.log10(64 / zoom));
    const step =
      [1, 2, 5, 10].map((value) => value * base).find((value) => value * zoom >= 40) ?? base * 10;
    this.grid.clear();
    const left = Math.max(0, topLeft.x),
      top = Math.max(0, topLeft.y);
    const right = Math.min(this.size.width, bottomRight.x),
      bottom = Math.min(this.size.height, bottomRight.y);
    if (right > left && bottom > top) {
      for (let x = Math.ceil(left / step) * step; x < right; x += step)
        this.grid.moveTo(x, top).lineTo(x, bottom);
      for (let y = Math.ceil(top / step) * step; y < bottom; y += step)
        this.grid.moveTo(left, y).lineTo(right, y);
    }
    this.grid.stroke({ color: 0x40464d, width: 1 / zoom, alpha: 0.65 });
    this.host.dataset.zoom = String(zoom);
    this.host.dataset.panX = String(pan.x);
    this.host.dataset.panY = String(pan.y);
    this.scene?.update();
    this.onChange?.();
    this.invalidate();
  }
  metrics() {
    return {
      capabilities: this.capabilities,
      gpu: this.gpu,
      rendering: { frames: this.renderCount, pending: this.rendering.pending, mode: 'on-demand' },
      previewFrames: this.renderFrames.snapshot(),
      layers: this.scene?.stats() ?? null,
      chart: this.chartScene?.metrics() ?? null,
      camera: {
        matrix: { ...this.cameraTransform },
        pose: this.camera?.pose.value ?? null,
        affectsNotes:
          !!this.chartScene &&
          Object.values(this.chartScene.chart.document.value.notes).some(
            (n) => n.kind === 'slider' && n.binding,
          ),
      },
      outlines: this.outlineScene?.metrics() ?? null,
      reveals: Object.values(this.reveals?.states.value ?? {}).map((s) => ({
        layerId: s.layerId,
        clipId: s.clipId,
        progress: s.rawProgress,
        alpha: s.alpha,
        mask: s.mask?.kind ?? null,
        outlinePhase: s.outline?.phase ?? null,
        outlineOpacity: s.outline?.opacity ?? 0,
        layerProgress: s.outline?.layerProgress ?? null,
      })),
      viewport: {
        zoom: this.viewport.zoom,
        pan: { ...this.viewport.pan },
        screen: { ...this.viewport.screen },
      },
      screenBuffer: this.initialized
        ? {
            width: this.app.canvas.width,
            height: this.app.canvas.height,
            rgbaBytesEstimate: this.app.canvas.width * this.app.canvas.height * 4,
          }
        : null,
    };
  }
  dispose(): void {
    this.disposed = true;
    this.rendering.dispose();
    this.watchers.forEach((stop) => stop());
    this.observer?.disconnect();
    if (this.initialized) {
      const canvas = this.app.canvas;
      canvas.removeEventListener('wheel', this.onWheel);
      canvas.removeEventListener('pointerdown', this.onDown);
      canvas.removeEventListener('pointermove', this.onMove);
      canvas.removeEventListener('pointerup', this.onUp);
      canvas.removeEventListener('pointercancel', this.onUp);
      canvas.removeEventListener('pointerleave', this.onLeave);
      canvas.removeEventListener('dblclick', this.onDoubleClick);
      canvas.removeEventListener('webglcontextlost', this.contextLost);
      canvas.removeEventListener('webglcontextrestored', this.contextRestored);
      this.scene?.dispose();
      this.chartScene?.dispose();
      this.revealScene?.dispose();
      this.outlineScene?.dispose();
      this.app.destroy(true, { children: true, context: true });
    }
  }
}
