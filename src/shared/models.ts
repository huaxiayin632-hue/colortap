import type { MusicAnalysis } from './audio-analysis';

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
  label?: string;
  audioRole?: 'music' | 'sfx';
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
  /** The non-clipped sibling underneath this contiguous clipping stack. */
  clippingBaseId?: Id;
  /** Grayscale pixels are stored separately, never applied destructively to layer pixels. */
  rasterMask?: {
    sourceId?: Id;
    position: Vec2;
    defaultValue: number;
    enabled: boolean;
    density: number;
    feather: number;
    positionRelativeToLayer: boolean;
  };
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
  interpolation?: 'bezier' | 'polyline';
  // Handles are offsets from their node, in path-local coordinates.
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
  reversed?: boolean;
}
export interface SliderBinding {
  layerId: Id;
  // Layer-to-artwork pose at attachment. Existing path coordinates stay in chart space.
  reference: Transform2D;
}
export type Note = { id: Id; at: Moment } & (
  | { kind: 'circle'; position: Vec2; radius: number }
  | { kind: 'hold'; position: Vec2; radius: number; duration: Span }
  | {
      kind: 'slider';
      path: PathInstance;
      duration: Span;
      headRadius: number;
      followRadius: number;
      binding?: SliderBinding;
    }
);
export type Trigger =
  | { kind: 'timeline'; at: Moment }
  | {
      kind: 'note';
      noteId: Id;
      event:
        | 'hit'
        | 'miss'
        | 'slider-start'
        | 'slider-complete'
        | 'slider-fail'
        | 'hold-complete'
        | 'hold-fail';
    };
export type RevealEffect =
  | { kind: 'instant' | 'fade' }
  | { kind: 'slide-in'; offset: Vec2 }
  | { kind: 'pop'; fromScale: number; overshoot: number }
  | { kind: 'directional'; direction: Vec2; region?: Rect }
  | FanReveal
  | {
      kind: 'path';
      path: PathInstance;
      // Reveal paths use artwork coordinates. A live link resolves the Slider's current
      // geometry, transform and direction through the independent chart-to-artwork mapping.
      linkedSliderId?: Id;
      maskWidth: number;
      completion: 'keep-mask' | 'show-full-layer';
    }
  | OutlineReveal;
export interface FanReveal {
  kind: 'fan';
  // Relative to the target layer/group bounds: (0, 0) top-left, (1, 1) bottom-right.
  center: Vec2;
  startAngleRad: number;
  // The final sector runs clockwise from startAngleRad through this positive angle.
  sweepAngleRad: number;
  direction: 'clockwise' | 'counterclockwise';
  mode: 'open' | 'close';
}
export interface OutlineReveal {
  kind: 'outline';
  path: PathInstance;
  linkedSliderId?: Id;
  drawing: {
    mode: 'single' | 'bidirectional';
    // Arc-length position on the original path, independent of reversed direction.
    start: number;
    forwardRatio: number;
  };
  stroke: { color: string; width: number; glow: number; tips: boolean; tipSize: number };
  layer: {
    kind: 'instant' | 'fade' | 'pop';
    threshold: number;
    durationUs: Us;
    fromScale: number;
    overshoot: number;
  };
  lineAfter: { kind: 'keep' | 'fade' | 'hide'; durationUs: Us };
}
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
  delayUs?: Us;
}
export interface SoundCue {
  id: Id;
  assetId: Id;
  trigger:
    | Trigger
    | { kind: 'reveal-start' | 'outline-start' | 'outline-complete' | 'layer-reveal'; revealId: Id }
    | { kind: 'slider-tick'; noteId: Id; intervalTicks: number };
  delayUs: Us;
  gain: number;
  pan: number;
  bus?: 'hit' | 'animation';
  enabled?: boolean;
}
export type AudioBus = 'music' | 'hit' | 'animation';
export type Mixer = Record<AudioBus, { gain: number; muted: boolean }>;
export const defaultMixer = (): Mixer => ({
  music: { gain: 1, muted: false },
  hit: { gain: 1, muted: false },
  animation: { gain: 1, muted: false },
});
export type TrackId = 'music' | 'notes' | 'layers' | 'outlines' | 'sounds' | 'camera';
export interface TrackLayout {
  order: TrackId[];
  collapsed: TrackId[];
  hidden: TrackId[];
}
export const defaultTracks = (): TrackLayout => ({
  order: ['music', 'notes', 'layers', 'outlines', 'sounds', 'camera'],
  collapsed: [],
  hidden: [],
});
export interface CameraPose {
  position: Vec2;
  zoom: number;
  rotationRad: number;
  pivot?: Vec2;
}
export interface CameraShake {
  id: Id;
  at: Moment;
  duration: Span;
  amplitude: Vec2;
  rotationRad: number;
  frequencyHz: number;
  seed: number;
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
  music?: { assetId: Id; gain: number; analysis?: MusicAnalysis };
  assets: Record<Id, Asset>;
  pixelSources: Record<Id, PixelSource>;
  layers: Record<Id, Layer>;
  rootLayersBottomToTop: Id[];
  paths: Record<Id, BezierPath>;
  notes: Record<Id, Note>;
  reveals: Record<Id, RevealClip>;
  sounds: Record<Id, SoundCue>;
  camera: {
    base: CameraPose;
    keys: Record<Id, CameraKey>;
    shakes?: Record<Id, CameraShake>;
    enabled?: boolean;
  };
  mixer?: Mixer;
  tracks?: TrackLayout;
  rules: {
    hitWindowsUs: { perfect: Us; good: Us; ok: Us };
    sliderCompleteRatio: number;
    holdCompleteRatio?: number;
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
    mixer: defaultMixer(),
    tracks: defaultTracks(),
    camera: {
      enabled: false,
      shakes: {},
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
      holdCompleteRatio: 0.95,
      sliderTailGraceUs: 80000,
    },
  };
}
