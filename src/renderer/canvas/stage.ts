// Pixi's static uniform adapters support the strict CSP without enabling string evaluation.
import 'pixi.js/unsafe-eval';
import { Application, Container, Graphics, type WebGLRenderer } from 'pixi.js';
import { Viewport } from '../../core/viewport';
import type { RenderCapabilities } from '../../core/tiles';
import type { Project, Size, Vec2 } from '../../shared/models';
import { LayerScene } from './layer-scene';
import { FrameRecorder } from '../../core/performance';

export class EditorStage {
  readonly viewport = new Viewport();
  private readonly app = new Application();
  private readonly world = new Container();
  private readonly board = new Graphics();
  private readonly grid = new Graphics();
  private readonly artwork = new Container();
  private readonly artworkClip = new Graphics();
  private readonly bounds = new Graphics();
  private readonly renderFrames = new FrameRecorder();
  private scene: LayerScene | null = null;
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
  constructor(private readonly host: HTMLElement) {}
  async initialize(): Promise<void> {
    await this.app.init({
      preference: 'webgl',
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
    this.app.ticker.add(() => {
      if (document.hidden) this.renderFrames.resume();
      else this.renderFrames.frame(performance.now());
    });
    const canvas = this.app.canvas;
    canvas.setAttribute('aria-label', 'PixiJS 编辑画布，空白或中键拖动平移，滚轮缩放');
    canvas.setAttribute('data-testid', 'pixi-canvas');
    this.host.append(canvas);
    const gl = (this.app.renderer as WebGLRenderer).gl;
    const viewport = gl.getParameter(gl.MAX_VIEWPORT_DIMS) as Int32Array;
    this.capabilities = {
      maxTextureSize: gl.getParameter(gl.MAX_TEXTURE_SIZE),
      maxRenderbufferSize: gl.getParameter(gl.MAX_RENDERBUFFER_SIZE),
      maxViewport: { width: viewport[0], height: viewport[1] },
    };
    this.world.addChild(this.board, this.grid, this.artwork, this.artworkClip, this.bounds);
    this.artwork.mask = this.artworkClip;
    this.updateArtworkClip();
    this.app.stage.addChild(this.world);
    canvas.addEventListener('wheel', this.onWheel, { passive: false });
    canvas.addEventListener('pointerdown', this.onDown);
    canvas.addEventListener('pointermove', this.onMove);
    canvas.addEventListener('pointerup', this.onUp);
    canvas.addEventListener('pointercancel', this.onUp);
    canvas.addEventListener('webglcontextlost', this.contextLost);
    canvas.addEventListener('webglcontextrestored', this.contextRestored);
    this.observer = new ResizeObserver(() => this.resize());
    this.observer.observe(this.host);
    this.resize();
    this.fit();
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
    this.viewport.zoomAt(
      { x: event.clientX - rect.left, y: event.clientY - rect.top },
      this.viewport.zoom * Math.exp(-event.deltaY * 0.0015),
    );
    this.draw();
  };
  private onDown = (event: PointerEvent): void => {
    if (event.button !== 0 && event.button !== 1) return;
    event.preventDefault();
    this.drag = { id: event.pointerId, x: event.clientX, y: event.clientY };
    const rect = this.app.canvas.getBoundingClientRect();
    const at = this.viewport.toWorld({ x: event.clientX - rect.left, y: event.clientY - rect.top });
    const hit = event.button === 0 && !event.altKey ? this.scene?.hit(at) : null;
    if (hit) {
      this.onSelect?.(hit);
      this.moveStart = at;
    } else if (event.button === 0 && !event.altKey) this.onSelect?.(null);
    this.app.canvas.setPointerCapture(event.pointerId);
    this.app.canvas.style.cursor = 'grabbing';
  };
  private onMove = (event: PointerEvent): void => {
    if (!this.drag || this.drag.id !== event.pointerId) return;
    if (this.moveStart && this.selected) {
      const rect = this.app.canvas.getBoundingClientRect();
      const at = this.viewport.toWorld({
        x: event.clientX - rect.left,
        y: event.clientY - rect.top,
      });
      this.onMoveLayer?.(
        this.selected,
        { x: at.x - this.moveStart.x, y: at.y - this.moveStart.y },
        false,
      );
      return;
    }
    this.viewport.pan.x += event.clientX - this.drag.x;
    this.viewport.pan.y += event.clientY - this.drag.y;
    this.drag = { id: event.pointerId, x: event.clientX, y: event.clientY };
    this.draw();
  };
  private onUp = (event: PointerEvent): void => {
    if (this.drag?.id === event.pointerId) {
      if (this.moveStart && this.selected) {
        const rect = this.app.canvas.getBoundingClientRect();
        const at = this.viewport.toWorld({
          x: event.clientX - rect.left,
          y: event.clientY - rect.top,
        });
        this.onMoveLayer?.(
          this.selected,
          event.type === 'pointercancel'
            ? { x: 0, y: 0 }
            : { x: at.x - this.moveStart.x, y: at.y - this.moveStart.y },
          true,
        );
      }
      this.moveStart = null;
      this.drag = null;
      this.app.canvas.style.cursor = 'grab';
      if (this.app.canvas.hasPointerCapture(event.pointerId))
        this.app.canvas.releasePointerCapture(event.pointerId);
    }
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
        },
        (error) => this.onAssetError?.(error),
      );
      this.artwork.addChild(this.scene.root, this.scene.selection);
    }
    this.scene.setProject(project);
    this.scene.select(this.selected);
  }
  select(id: string | null): void {
    this.selected = id;
    this.scene?.select(id);
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
  }
  metrics() {
    return {
      capabilities: this.capabilities,
      previewFrames: this.renderFrames.snapshot(),
      layers: this.scene?.stats() ?? null,
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
    this.observer?.disconnect();
    if (this.initialized) {
      const canvas = this.app.canvas;
      canvas.removeEventListener('wheel', this.onWheel);
      canvas.removeEventListener('pointerdown', this.onDown);
      canvas.removeEventListener('pointermove', this.onMove);
      canvas.removeEventListener('pointerup', this.onUp);
      canvas.removeEventListener('pointercancel', this.onUp);
      canvas.removeEventListener('webglcontextlost', this.contextLost);
      canvas.removeEventListener('webglcontextrestored', this.contextRestored);
      this.scene?.dispose();
      this.app.destroy(true, { children: true });
    }
  }
}
