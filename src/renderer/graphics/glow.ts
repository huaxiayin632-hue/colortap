import type { Graphics } from 'pixi.js';

export const NOTE_LIGHT = { core: 0xffffff, edge: 0xe5d7ff, halo: 0xb49bdf };

/** Narrow vector halos keep the white silhouette crisp, without a full-scene blur pass. */
export function glowRing(g: Graphics, radius: number, width: number): void {
  for (const [spread, alpha] of [
    [9, 0.025],
    [5, 0.055],
    [2.4, 0.2],
  ] as const)
    g.circle(0, 0, radius).stroke({ color: NOTE_LIGHT.halo, width: width * spread, alpha });
  g.circle(0, 0, radius).stroke({ color: NOTE_LIGHT.edge, width: width * 1.6, alpha: 0.85 });
  g.circle(0, 0, radius).stroke({ color: NOTE_LIGHT.core, width });
}
export function glowLine(g: Graphics, positions: number[], width: number): void {
  if (positions.length < 4) return;
  for (const [spread, alpha] of [
    [8, 0.025],
    [4, 0.06],
    [1.8, 0.17],
  ] as const)
    g.poly(positions, false).stroke({
      color: NOTE_LIGHT.halo,
      width: width * spread,
      alpha,
      cap: 'round',
      join: 'round',
    });
  g.poly(positions, false).stroke({ color: NOTE_LIGHT.core, width, cap: 'round', join: 'round' });
}
export function glowDot(g: Graphics, x: number, y: number, radius: number, alpha = 1): void {
  g.circle(x, y, radius * 3).fill({ color: NOTE_LIGHT.halo, alpha: alpha * 0.04 });
  g.circle(x, y, radius * 1.9).fill({ color: NOTE_LIGHT.edge, alpha: alpha * 0.11 });
  g.circle(x, y, radius * 1.25).fill({ color: NOTE_LIGHT.edge, alpha: alpha * 0.25 });
  g.circle(x, y, radius).fill({ color: NOTE_LIGHT.core, alpha });
}
