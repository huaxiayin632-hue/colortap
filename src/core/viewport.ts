import type { Size, Vec2 } from '../shared/models';

export class Viewport {
  zoom = 1;
  pan: Vec2 = { x: 0, y: 0 };
  screen: Size = { width: 1, height: 1 };
  toWorld(point: Vec2): Vec2 {
    return { x: (point.x - this.pan.x) / this.zoom, y: (point.y - this.pan.y) / this.zoom };
  }
  toScreen(point: Vec2): Vec2 {
    return { x: point.x * this.zoom + this.pan.x, y: point.y * this.zoom + this.pan.y };
  }
  zoomAt(point: Vec2, nextZoom: number): void {
    if (!Number.isFinite(nextZoom) || nextZoom <= 0) return;
    const anchor = this.toWorld(point);
    this.zoom = Math.max(1e-12, Math.min(256, nextZoom));
    this.pan = { x: point.x - anchor.x * this.zoom, y: point.y - anchor.y * this.zoom };
  }
  fit(artwork: Size): void {
    const available = {
      width: Math.max(1, this.screen.width - 96),
      height: Math.max(1, this.screen.height - 80),
    };
    this.zoom = Math.min(available.width / artwork.width, available.height / artwork.height);
    this.center(artwork);
  }
  center(artwork: Size): void {
    this.pan = {
      x: (this.screen.width - artwork.width * this.zoom) / 2,
      y: (this.screen.height - artwork.height * this.zoom) / 2,
    };
  }
}
