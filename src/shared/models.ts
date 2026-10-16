// These are document values only. Never put Vue, PixiJS, AudioBuffer or file handles here.
export type Id = string;
export type Us = number;
export type Vec2 = { x: number; y: number };
export type Size = { width: number; height: number };
export type Rect = Vec2 & Size;
export type Transform2D = {
  position: Vec2;
  scale: Vec2;
  rotationRad: number;
  skewRad: Vec2;
  pivot: Vec2;
};
export type Moment = { basis: 'time'; timeUs: Us } | { basis: 'beat'; tick: number };
export type Span = { basis: 'time'; durationUs: Us } | { basis: 'beat'; ticks: number };
export type Easing =
  | 'linear'
  | 'ease-in'
  | 'ease-out'
  | 'ease-in-out'
  | { cubicBezier: [number, number, number, number] };

export interface TimingMap {
  ppq: 960;
  beatZeroUs: Us;
  points: { id: Id; tick: number; bpm: number; meter: [number, number] }[];
}

export interface Asset {
  id: Id;
  kind: 'audio' | 'psd' | 'png' | 'svg';
  relativePath: string;
  originalName: string;
  sha256: string;
  byteLength: number;
  pixelSize?: Size;
  audio?: { durationUs: Us; sampleRate: number; channels: number };
}

export interface TileLevel {
  level: number;
  scale: number;
  pixelSize: Size;
  tileSize: number;
  gutter: number;
  tiles: { assetId: Id; sourceRect: Rect; pixelRect: Rect }[];
}
export interface PixelSource {
  id: Id;
  sourceAssetId: Id;
  originalBounds: Rect;
  cropRect: Rect;
  levels: TileLevel[];
  psdLayerId?: number;
}
export interface LayerBase {
  id: Id;
  name: string;
  transform: Transform2D;
  opacity: number;
  enabled: boolean;
  locked: boolean;
  initialReveal: 0 | 1;
  blendMode: string;
}
export type Layer = LayerBase &
  (
    | {
        kind: 'group';
        childrenBottomToTop: Id[];
        isolation: 'isolated' | 'pass-through';
        expanded?: boolean;
        staticMaskSourceId?: Id;
      }
    | { kind: 'raster' | 'svg'; pixelSourceId: Id; staticMaskSourceId?: Id }
  );
export interface BezierPath {
  id: Id;
  name: string;
  closed: boolean;
  defaultWidth: number;
  nodes: {
    id: Id;
    point: Vec2;
    handleIn: Vec2;
    handleOut: Vec2;
    mode: 'corner' | 'aligned' | 'mirrored';
  }[];
}
export interface PathInstance {
  pathId: Id;
  transform: Transform2D;
}
export type Note = { id: Id; at: Moment } & (
  | { kind: 'circle'; position: Vec2; radius: number }
  | { kind: 'slider'; path: PathInstance; duration: Span; headRadius: number; followRadius: number }
);
export type Trigger =
  | { kind: 'timeline'; at: Moment }
  | { kind: 'note'; noteId: Id; event: 'hit' | 'miss' | 'slider-complete' | 'slider-fail' };
export type RevealEffect =
  | { kind: 'instant' | 'fade' }
  | { kind: 'slide-in'; offset: Vec2 }
  | { kind: 'pop'; fromScale: number; overshoot: number }
  | { kind: 'directional'; direction: Vec2; region?: Rect }
  | {
      kind: 'path';
      path: PathInstance;
      maskWidth: number;
      completion: 'keep-mask' | 'show-full-layer';
    };
export interface RevealClip {
  id: Id;
  layerId: Id;
  trigger: Trigger;
  effect: RevealEffect;
  easing: Easing;
  progress:
    { kind: 'elapsed'; duration: Span } | { kind: 'slider-timeline' | 'slider-follow'; noteId: Id };
  after: 'hold' | 'restore';
  priority: number;
}
export interface SoundCue {
  id: Id;
  assetId: Id;
  trigger: Trigger | { kind: 'reveal-start'; revealId: Id };
  delayUs: Us;
  gain: number;
  pan: number;
}
export interface CameraPose {
  position: Vec2;
  zoom: number;
  rotationRad: number;
}
export interface CameraKey extends CameraPose {
  id: Id;
  at: Moment;
  easingToNext: Easing;
}

export interface Project {
  format: 'rhythm-canvas';
  schemaVersion: 1;
  id: Id;
  name: string;
  revision: number;
  createdAt: string;
  modifiedAt: string;
  stage: { artworkSize: Size; chartSize: Size; playfieldRect: Rect };
  output: { size: Size; framing: 'contain' | 'cover' };
  sourceDocuments: Record<
    Id,
    {
      id: Id;
      assetId: Id;
      pixelSize: Size;
      bitsPerChannel: number;
      colorMode: string;
      warnings?: string[];
    }
  >;
  timing: TimingMap;
  music?: { assetId: Id; gain: number };
  assets: Record<Id, Asset>;
  pixelSources: Record<Id, PixelSource>;
  layers: Record<Id, Layer>;
  rootLayersBottomToTop: Id[];
  paths: Record<Id, BezierPath>;
  notes: Record<Id, Note>;
  reveals: Record<Id, RevealClip>;
  sounds: Record<Id, SoundCue>;
  camera: { base: CameraPose; keys: Record<Id, CameraKey> };
  rules: {
    hitWindowsUs: { perfect: Us; good: Us; ok: Us };
    sliderCompleteRatio: number;
    sliderTailGraceUs: Us;
  };
}

export function createProject(
  name = '未命名工程',
  artworkSize: Size = { width: 6000, height: 6000 },
): Project {
  const now = new Date().toISOString();
  return {
    format: 'rhythm-canvas',
    schemaVersion: 1,
    id: crypto.randomUUID(),
    name,
    revision: 0,
    createdAt: now,
    modifiedAt: now,
    stage: {
      artworkSize: { ...artworkSize },
      chartSize: { width: 512, height: 384 },
      playfieldRect: { x: 0, y: 0, width: artworkSize.width, height: artworkSize.height },
    },
    output: { size: { width: 1920, height: 1080 }, framing: 'contain' },
    sourceDocuments: {},
    pixelSources: {},
    timing: {
      ppq: 960,
      beatZeroUs: 0,
      points: [{ id: crypto.randomUUID(), tick: 0, bpm: 120, meter: [4, 4] }],
    },
    assets: {},
    layers: {},
    rootLayersBottomToTop: [],
    paths: {},
    notes: {},
    reveals: {},
    sounds: {},
    camera: {
      base: {
        position: { x: artworkSize.width / 2, y: artworkSize.height / 2 },
        zoom: 1,
        rotationRad: 0,
      },
      keys: {},
    },
    rules: {
      hitWindowsUs: { perfect: 50000, good: 100000, ok: 150000 },
      sliderCompleteRatio: 0.8,
      sliderTailGraceUs: 80000,
    },
  };
}
