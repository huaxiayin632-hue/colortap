import type { CameraPose, Project, Vec2 } from '../shared/models';
import { TempoMap } from './timing';
import { spanUs } from './chart';
import { easeProgress } from './easing';
import { inverse, point, type Affine } from './layers';

export function neutralCamera(p: Project): CameraPose {
  const position = { x: p.stage.artworkSize.width / 2, y: p.stage.artworkSize.height / 2 };
  return { position, zoom: 1, rotationRad: 0, pivot: { ...position } };
}
export function cameraEnabled(p: Project): boolean {
  return (
    p.camera.enabled ??
    (Object.keys(p.camera.keys).length > 0 || Object.keys(p.camera.shakes ?? {}).length > 0)
  );
}
export class CameraEvaluator {
  readonly tempo: TempoMap;
  readonly keys: { time: number; key: Project['camera']['keys'][string] }[];
  constructor(readonly project: Project) {
    this.tempo = new TempoMap(project.timing);
    this.keys = Object.values(project.camera.keys)
      .map((key) => ({ key, time: this.tempo.resolve(key.at) }))
      .sort((a, b) => a.time - b.time || a.key.id.localeCompare(b.key.id));
  }
  at(timeUs: number, shake = true): CameraPose {
    const p = this.project,
      neutral = neutralCamera(p);
    if (!cameraEnabled(p)) return neutral;
    let left: CameraPose = p.camera.base,
      right: CameraPose | undefined,
      start = 0,
      end = 0,
      easing: Project['camera']['keys'][string]['easingToNext'] = 'linear';
    for (const entry of this.keys) {
      if (entry.time <= timeUs) {
        left = entry.key;
        start = entry.time;
        easing = entry.key.easingToNext;
      } else {
        right = entry.key;
        end = entry.time;
        break;
      }
    }
    const t = right && end > start ? easeProgress((timeUs - start) / (end - start), easing) : 0;
    const mix = (a: number, b: number) => a + (b - a) * t;
    const lp = left.pivot ?? neutral.position,
      rp = right?.pivot ?? neutral.position;
    const pose: CameraPose = {
      position: {
        x: mix(left.position.x, right?.position.x ?? left.position.x),
        y: mix(left.position.y, right?.position.y ?? left.position.y),
      },
      zoom: Math.max(0.01, mix(left.zoom, right?.zoom ?? left.zoom)),
      rotationRad: mix(left.rotationRad, right?.rotationRad ?? left.rotationRad),
      pivot: { x: mix(lp.x, right ? rp.x : lp.x), y: mix(lp.y, right ? rp.y : lp.y) },
    };
    if (shake)
      for (const s of Object.values(p.camera.shakes ?? {})) {
        const from = this.tempo.resolve(s.at),
          duration = spanUs(s.duration, s.at, this.tempo),
          age = timeUs - from;
        if (age < 0 || age >= duration) continue;
        const f = (age / 1e6) * s.frequencyHz * 2 * Math.PI,
          envelope = Math.sin((Math.PI * age) / duration) ** 2,
          phase = s.seed * 0.718;
        pose.position.x += Math.sin(f + phase) * s.amplitude.x * envelope;
        pose.position.y += Math.sin(f * 1.37 + phase + 0.7) * s.amplitude.y * envelope;
        pose.rotationRad += Math.sin(f * 0.83 + phase) * s.rotationRad * envelope;
      }
    return pose;
  }
}
/** Artwork and explicitly attached Sliders share this camera; free notes remain independent. */
export function cameraMatrix(p: Project, pose: CameraPose): Affine {
  const center = neutralCamera(p).position,
    pivot = pose.pivot ?? center,
    c = Math.cos(-pose.rotationRad) * pose.zoom,
    s = Math.sin(-pose.rotationRad) * pose.zoom;
  return {
    a: c,
    b: s,
    c: -s,
    d: c,
    tx: center.x - pose.position.x + pivot.x - c * pivot.x + s * pivot.y,
    ty: center.y - pose.position.y + pivot.y - s * pivot.x - c * pivot.y,
  };
}
export function cameraViewBounds(
  matrix: Affine,
  rect: { x: number; y: number; width: number; height: number },
) {
  const inv = inverse(matrix),
    corners = [
      point(inv, rect),
      point(inv, { x: rect.x + rect.width, y: rect.y }),
      point(inv, { x: rect.x, y: rect.y + rect.height }),
      point(inv, { x: rect.x + rect.width, y: rect.y + rect.height }),
    ];
  const x = Math.min(...corners.map((v) => v.x)),
    y = Math.min(...corners.map((v) => v.y));
  return {
    x,
    y,
    width: Math.max(...corners.map((v) => v.x)) - x,
    height: Math.max(...corners.map((v) => v.y)) - y,
  };
}
export function cameraScreenPoint(p: Project, pose: CameraPose, at: Vec2): Vec2 {
  return point(cameraMatrix(p, pose), at);
}
