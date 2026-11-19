import { z } from 'zod';
import { defaultMixer, defaultTracks, type Project } from './models';
import { validateClipping } from '../core/compositing';

const finite = z.number().finite();
const integer = finite.int().refine(Number.isSafeInteger, '数值超过安全整数范围');
const positive = finite.positive();
const positiveInt = integer.positive();
const id = z.uuid();
const us = integer;
const vec = z.object({ x: finite, y: finite }).strict();
const size = z.object({ width: positiveInt, height: positiveInt }).strict();
const rect = z.object({ x: finite, y: finite, width: positive, height: positive }).strict();
const transform = z
  .object({ position: vec, scale: vec, rotationRad: finite, skewRad: vec, pivot: vec })
  .strict();
const moment = z.union([
  z.object({ basis: z.literal('time'), timeUs: us }).strict(),
  z.object({ basis: z.literal('beat'), tick: integer }).strict(),
]);
const span = z.union([
  z.object({ basis: z.literal('time'), durationUs: us.nonnegative() }).strict(),
  z.object({ basis: z.literal('beat'), ticks: integer.nonnegative() }).strict(),
]);
const ease = z.union([
  z.enum(['linear', 'ease-in', 'ease-out', 'ease-in-out']),
  z.object({ cubicBezier: z.tuple([finite, finite, finite, finite]) }).strict(),
]);
const pathUse = z.object({ pathId: id, transform, reversed: z.boolean().optional() }).strict();
const trigger = z.union([
  z.object({ kind: z.literal('timeline'), at: moment }).strict(),
  z
    .object({
      kind: z.literal('note'),
      noteId: id,
      event: z.enum([
        'hit',
        'miss',
        'slider-start',
        'slider-complete',
        'slider-fail',
        'hold-complete',
        'hold-fail',
      ]),
    })
    .strict(),
]);
const record = <T extends z.ZodType>(value: T) => z.record(id, value);
const tempoCandidate = z
  .object({
    bpm: positive,
    phaseUs: us.nonnegative(),
    anchorUs: us.nonnegative(),
    support: finite.min(0).max(1),
    matchedOnsets: integer.nonnegative(),
    meanErrorUs: us.nonnegative(),
  })
  .strict();
const analysisRegion = z.object({ startUs: us.nonnegative(), endUs: us.nonnegative() }).strict();
const audioAnalysis = z
  .object({
    algorithm: z.string().min(1),
    sampleRate: positiveInt,
    sampleCount: integer.nonnegative(),
    channels: positiveInt,
    durationUs: us.nonnegative(),
    parameters: z
      .object({
        fftSize: positiveInt,
        hopSize: positiveInt,
        minOnsetIntervalUs: finite.nonnegative(),
        peakThreshold: finite.min(0).max(1),
        minBpm: positive,
        maxBpm: positive,
        tempoWindowUs: positive,
      })
      .strict(),
    onsets: z.array(
      z.object({ timeUs: us.nonnegative(), strength: finite.min(0).max(1) }).strict(),
    ),
    tempos: z.array(tempoCandidate),
    suggestion: tempoCandidate.nullable(),
    regions: z.array(analysisRegion.extend({ tempos: z.array(tempoCandidate) })),
    quietRegions: z.array(analysisRegion),
    warnings: z.array(
      z.enum(['quiet-audio', 'insufficient-rhythm', 'tempo-change', 'metrical-ambiguity']),
    ),
  })
  .strict()
  .superRefine((analysis, ctx) => {
    let previous = -1;
    for (const onset of analysis.onsets) {
      if (onset.timeUs <= previous || onset.timeUs > analysis.durationUs) {
        ctx.addIssue({ code: 'custom', message: '起音必须按时间递增且处于分析音频范围内' });
        break;
      }
      previous = onset.timeUs;
    }
    for (const region of [...analysis.regions, ...analysis.quietRegions])
      if (region.endUs < region.startUs || region.endUs > analysis.durationUs) {
        ctx.addIssue({ code: 'custom', message: '分析分段超出音频范围' });
        break;
      }
  });

export function isSafeAssetPath(value: string): boolean {
  return (
    value.startsWith('assets/') &&
    !/[\\:\x00-\x1f]/.test(value) &&
    value.split('/').every((part) => part !== '' && part !== '.' && part !== '..')
  );
}

export const assetSchema = z
  .object({
    id,
    kind: z.enum(['audio', 'psd', 'png', 'svg']),
    relativePath: z.string().refine(isSafeAssetPath, '素材路径必须是安全的工程相对路径'),
    originalName: z.string(),
    label: z.string().optional(),
    audioRole: z.enum(['music', 'sfx']).optional(),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    byteLength: integer.nonnegative(),
    pixelSize: size.optional(),
    audio: z
      .object({ durationUs: us.nonnegative(), sampleRate: positiveInt, channels: positiveInt })
      .strict()
      .optional(),
  })
  .strict();
const layerBase = {
  id,
  name: z.string(),
  transform,
  opacity: finite.min(0).max(1),
  enabled: z.boolean(),
  locked: z.boolean(),
  initialReveal: z.union([z.literal(0), z.literal(1)]),
  blendMode: z.string(),
  staticMaskSourceId: id.optional(),
  clippingBaseId: id.optional(),
  rasterMask: z
    .object({
      sourceId: id.optional(),
      position: vec,
      defaultValue: finite.min(0).max(1),
      enabled: z.boolean(),
      density: finite.min(0).max(1),
      feather: finite.nonnegative(),
      positionRelativeToLayer: z.boolean(),
    })
    .strict()
    .optional(),
};
const layer = z.discriminatedUnion('kind', [
  z
    .object({
      ...layerBase,
      kind: z.literal('group'),
      childrenBottomToTop: z.array(id),
      isolation: z.enum(['isolated', 'pass-through']),
      expanded: z.boolean().optional(),
    })
    .strict(),
  z.object({ ...layerBase, kind: z.enum(['raster', 'svg']), pixelSourceId: id }).strict(),
]);
const pose = { position: vec, zoom: positive, rotationRad: finite, pivot: vec.optional() };

export const projectSchema = z
  .object({
    format: z.literal('rhythm-canvas'),
    schemaVersion: z.literal(1),
    id,
    name: z.string().trim().min(1),
    revision: integer.nonnegative(),
    createdAt: z.iso.datetime(),
    modifiedAt: z.iso.datetime(),
    stage: z.object({ artworkSize: size, chartSize: size, playfieldRect: rect }).strict(),
    output: z.object({ size, framing: z.enum(['contain', 'cover']) }).strict(),
    sourceDocuments: record(
      z
        .object({
          id,
          assetId: id,
          pixelSize: size,
          bitsPerChannel: positiveInt,
          colorMode: z.string(),
          warnings: z.array(z.string()).optional(),
        })
        .strict(),
    ),
    timing: z
      .object({
        ppq: z.literal(960),
        beatZeroUs: us,
        points: z
          .array(
            z
              .object({
                id,
                tick: integer.nonnegative(),
                bpm: positive,
                meter: z.tuple([positiveInt, positiveInt]),
              })
              .strict(),
          )
          .min(1),
      })
      .strict(),
    music: z
      .object({
        assetId: id,
        gain: finite.min(0).max(1),
        analysis: z
          .object({
            sourceSha256: z.string().regex(/^[a-f0-9]{64}$/),
            result: audioAnalysis,
          })
          .strict()
          .optional(),
      })
      .strict()
      .optional(),
    assets: record(assetSchema),
    pixelSources: record(
      z
        .object({
          id,
          sourceAssetId: id,
          originalBounds: rect,
          cropRect: rect,
          psdLayerId: integer.optional(),
          levels: z.array(
            z
              .object({
                level: integer.nonnegative(),
                scale: positive,
                pixelSize: size,
                tileSize: positiveInt,
                gutter: integer.nonnegative(),
                tiles: z.array(
                  z.object({ assetId: id, sourceRect: rect, pixelRect: rect }).strict(),
                ),
              })
              .strict(),
          ),
        })
        .strict(),
    ),
    layers: record(layer),
    rootLayersBottomToTop: z.array(id),
    paths: record(
      z
        .object({
          id,
          name: z.string(),
          closed: z.boolean(),
          defaultWidth: positive,
          interpolation: z.enum(['bezier', 'polyline']).optional(),
          nodes: z
            .array(
              z
                .object({
                  id,
                  point: vec,
                  handleIn: vec,
                  handleOut: vec,
                  mode: z.enum(['corner', 'aligned', 'mirrored']),
                })
                .strict(),
            )
            .min(2),
        })
        .strict(),
    ),
    notes: record(
      z.discriminatedUnion('kind', [
        z
          .object({ id, at: moment, kind: z.literal('circle'), position: vec, radius: positive })
          .strict(),
        z
          .object({
            id,
            at: moment,
            kind: z.literal('hold'),
            position: vec,
            radius: positive,
            duration: span,
          })
          .strict(),
        z
          .object({
            id,
            at: moment,
            kind: z.literal('slider'),
            path: pathUse,
            duration: span,
            headRadius: positive,
            followRadius: positive,
            binding: z.object({ layerId: id, reference: transform }).strict().optional(),
          })
          .strict(),
      ]),
    ),
    reveals: record(
      z
        .object({
          id,
          layerId: id,
          trigger,
          easing: ease,
          after: z.enum(['hold', 'restore']),
          priority: integer,
          delayUs: us.nonnegative().optional(),
          progress: z.union([
            z.object({ kind: z.literal('elapsed'), duration: span }).strict(),
            z.object({ kind: z.enum(['slider-timeline', 'slider-follow']), noteId: id }).strict(),
          ]),
          effect: z.union([
            z.object({ kind: z.enum(['instant', 'fade']) }).strict(),
            z.object({ kind: z.literal('slide-in'), offset: vec }).strict(),
            z
              .object({
                kind: z.literal('pop'),
                fromScale: positive,
                overshoot: finite.nonnegative(),
              })
              .strict(),
            z
              .object({ kind: z.literal('directional'), direction: vec, region: rect.optional() })
              .strict(),
            z
              .object({
                kind: z.literal('fan'),
                center: z.object({ x: finite.min(0).max(1), y: finite.min(0).max(1) }).strict(),
                startAngleRad: finite,
                sweepAngleRad: finite.min(0).max(Math.PI * 2),
                direction: z.enum(['clockwise', 'counterclockwise']),
                mode: z.enum(['open', 'close']),
              })
              .strict(),
            z
              .object({
                kind: z.literal('path'),
                path: pathUse,
                linkedSliderId: id.optional(),
                maskWidth: positive,
                completion: z.enum(['keep-mask', 'show-full-layer']),
              })
              .strict(),
            z
              .object({
                kind: z.literal('outline'),
                path: pathUse,
                linkedSliderId: id.optional(),
                drawing: z
                  .object({
                    mode: z.enum(['single', 'bidirectional']),
                    start: finite.min(0).max(1),
                    forwardRatio: finite.min(0).max(1),
                  })
                  .strict(),
                stroke: z
                  .object({
                    color: z.string().regex(/^#[0-9a-fA-F]{6}$/),
                    width: positive,
                    glow: finite.min(0).max(4),
                    tips: z.boolean(),
                    tipSize: positive,
                  })
                  .strict(),
                layer: z
                  .object({
                    kind: z.enum(['instant', 'fade', 'pop']),
                    threshold: finite.min(0).max(1),
                    durationUs: us.nonnegative(),
                    fromScale: positive,
                    overshoot: finite.nonnegative(),
                  })
                  .strict(),
                lineAfter: z
                  .object({ kind: z.enum(['keep', 'fade', 'hide']), durationUs: us.nonnegative() })
                  .strict(),
              })
              .strict(),
          ]),
        })
        .strict(),
    ),
    sounds: record(
      z
        .object({
          id,
          assetId: id,
          trigger: z.union([
            trigger,
            z
              .object({
                kind: z.enum(['reveal-start', 'outline-start', 'outline-complete', 'layer-reveal']),
                revealId: id,
              })
              .strict(),
            z
              .object({ kind: z.literal('slider-tick'), noteId: id, intervalTicks: positiveInt })
              .strict(),
          ]),
          delayUs: us.nonnegative(),
          gain: finite.min(0).max(1),
          pan: finite.min(-1).max(1),
          bus: z.enum(['hit', 'animation']).optional(),
          enabled: z.boolean().optional(),
        })
        .strict(),
    ),
    camera: z
      .object({
        base: z.object(pose).strict(),
        enabled: z.boolean().optional(),
        keys: record(z.object({ id, at: moment, ...pose, easingToNext: ease }).strict()),
        shakes: record(
          z
            .object({
              id,
              at: moment,
              duration: span,
              amplitude: vec,
              rotationRad: finite,
              frequencyHz: positive,
              seed: integer,
            })
            .strict(),
        ).optional(),
      })
      .strict(),
    mixer: z
      .object({
        music: z.object({ gain: finite.min(0).max(1), muted: z.boolean() }).strict(),
        hit: z.object({ gain: finite.min(0).max(1), muted: z.boolean() }).strict(),
        animation: z.object({ gain: finite.min(0).max(1), muted: z.boolean() }).strict(),
      })
      .strict()
      .optional(),
    tracks: z
      .object({
        order: z
          .array(z.enum(['music', 'notes', 'layers', 'outlines', 'sounds', 'camera']))
          .length(6),
        collapsed: z.array(z.enum(['music', 'notes', 'layers', 'outlines', 'sounds', 'camera'])),
        hidden: z.array(z.enum(['music', 'notes', 'layers', 'outlines', 'sounds', 'camera'])),
      })
      .strict()
      .optional(),
    rules: z
      .object({
        hitWindowsUs: z
          .object({ perfect: us.nonnegative(), good: us.nonnegative(), ok: us.nonnegative() })
          .strict(),
        sliderCompleteRatio: finite.min(0).max(1),
        holdCompleteRatio: finite.min(0).max(1).optional(),
        sliderTailGraceUs: us.nonnegative(),
      })
      .strict(),
  })
  .strict();

export function validateProject(input: unknown): Project {
  if (input && typeof input === 'object' && 'schemaVersion' in input && input.schemaVersion !== 1) {
    throw new Error('此工程使用了当前版本尚不支持的数据格式，请使用对应版本打开。');
  }
  const document: Project = projectSchema.parse(input);
  // Additive migration for stages 1–4: preserve IDs/assets/bindings and the old view.
  document.mixer ??= defaultMixer();
  document.tracks ??= defaultTracks();
  document.camera.shakes ??= {};
  document.camera.enabled ??=
    Object.keys(document.camera.keys).length > 0 || Object.keys(document.camera.shakes).length > 0;
  const fail = (message: string): never => {
    throw new Error(`工程数据错误：${message}`);
  };
  const requireRef = (values: Record<string, unknown>, key: string, label: string): void => {
    if (!Object.hasOwn(values, key)) fail(`${label}引用不存在：${key}`);
  };
  const allIds = new Set<string>();
  const addId = (key: string): void => {
    if (allIds.has(key)) fail('对象 ID 重复');
    allIds.add(key);
  };
  addId(document.id);
  for (const collection of [
    document.assets,
    document.layers,
    document.pixelSources,
    document.paths,
    document.notes,
    document.reveals,
    document.sounds,
    document.camera.keys,
    document.camera.shakes ?? {},
    document.sourceDocuments,
  ]) {
    for (const [key, item] of Object.entries(collection)) {
      if (key !== item.id) fail('对象 ID 与索引不一致');
      addId(key);
    }
  }
  let previousTick = -1;
  for (const point of document.timing.points) {
    addId(point.id);
    if (point.tick <= previousTick || (previousTick === -1 && point.tick !== 0))
      fail('BPM 点必须从第零拍起按刻度递增');
    previousTick = point.tick;
  }
  if (document.music) {
    requireRef(document.assets, document.music.assetId, '音乐');
    if (document.assets[document.music.assetId].kind !== 'audio') fail('音乐必须引用音频素材');
  }
  for (const source of Object.values(document.sourceDocuments))
    requireRef(document.assets, source.assetId, '原始文档');
  for (const source of Object.values(document.pixelSources)) {
    requireRef(document.assets, source.sourceAssetId, '原始像素');
    for (const level of source.levels)
      for (const tile of level.tiles) requireRef(document.assets, tile.assetId, '图像分块');
  }
  // An iterative traversal also supports deeply nested groups without recursion limits.
  const seen = new Set<string>();
  const pending = [...document.rootLayersBottomToTop];
  while (pending.length) {
    const key = pending.pop()!;
    requireRef(document.layers, key, '图层');
    if (seen.has(key)) fail('图层树包含循环或重复父级');
    seen.add(key);
    const item = document.layers[key];
    if (item.staticMaskSourceId)
      requireRef(document.pixelSources, item.staticMaskSourceId, '静态蒙版');
    if (item.rasterMask?.sourceId)
      requireRef(document.pixelSources, item.rasterMask.sourceId, 'PSD 像素蒙版');
    if (item.kind === 'group') pending.push(...item.childrenBottomToTop);
    else requireRef(document.pixelSources, item.pixelSourceId, '图层像素');
  }
  if (seen.size !== Object.keys(document.layers).length) fail('存在未连接到图层树的图层');
  validateClipping(document);
  for (const path of Object.values(document.paths)) for (const node of path.nodes) addId(node.id);
  for (const note of Object.values(document.notes)) {
    if ((note.at.basis === 'time' ? note.at.timeUs : note.at.tick) < 0) fail('音符时间不能小于零');
    if (note.kind === 'slider') {
      requireRef(document.paths, note.path.pathId, 'Slider 路径');
      if (note.binding) {
        requireRef(document.layers, note.binding.layerId, 'Slider 贴合图层');
        const t = note.binding.reference;
        if (Math.abs(t.scale.x * t.scale.y * Math.cos(t.skewRad.x + t.skewRad.y)) < 1e-12)
          fail('Slider 贴合参考变换不可为零缩放');
      }
    }
    if (
      note.kind !== 'circle' &&
      (note.duration.basis === 'time' ? note.duration.durationUs : note.duration.ticks) <= 0
    )
      fail('持续时间必须大于零');
  }
  const checkTrigger = (value: Project['reveals'][string]['trigger']): void => {
    if (value.kind === 'note') {
      requireRef(document.notes, value.noteId, '音符事件');
      if (value.event.startsWith('slider-') && document.notes[value.noteId].kind !== 'slider')
        fail('Slider 事件必须引用 Slider');
      if (value.event.startsWith('hold-') && document.notes[value.noteId].kind !== 'hold')
        fail('长按事件必须引用长按音符');
    }
  };
  for (const clip of Object.values(document.reveals)) {
    requireRef(document.layers, clip.layerId, '演出图层');
    checkTrigger(clip.trigger);
    if (clip.progress.kind !== 'elapsed') {
      requireRef(document.notes, clip.progress.noteId, '进度来源');
      if (document.notes[clip.progress.noteId].kind !== 'slider')
        fail('Slider 进度必须引用 Slider');
    }
    if (clip.effect.kind === 'path' || clip.effect.kind === 'outline') {
      requireRef(document.paths, clip.effect.path.pathId, '显现路径');
      if (clip.effect.linkedSliderId) {
        requireRef(document.notes, clip.effect.linkedSliderId, '关联 Slider');
        if (document.notes[clip.effect.linkedSliderId].kind !== 'slider')
          fail('关联路径必须引用 Slider');
      }
    }
    if (
      clip.effect.kind === 'directional' &&
      Math.hypot(clip.effect.direction.x, clip.effect.direction.y) < 1e-10
    )
      fail('显现方向不能为零');
  }
  for (const cue of Object.values(document.sounds)) {
    requireRef(document.assets, cue.assetId, '音效');
    if (document.assets[cue.assetId].kind !== 'audio') fail('音效必须引用音频素材');
    if ('revealId' in cue.trigger) requireRef(document.reveals, cue.trigger.revealId, '演出事件');
    else if (cue.trigger.kind === 'slider-tick') {
      requireRef(document.notes, cue.trigger.noteId, '追踪节点');
      if (document.notes[cue.trigger.noteId].kind !== 'slider') fail('追踪音效必须引用 Slider');
    } else checkTrigger(cue.trigger);
  }
  if (document.tracks && new Set(document.tracks.order).size !== 6) fail('轨道顺序重复');
  for (const key of Object.values(document.camera.keys))
    if ((key.at.basis === 'time' ? key.at.timeUs : key.at.tick) < 0) fail('镜头时间不能小于零');
  for (const shake of Object.values(document.camera.shakes ?? {}))
    if ((shake.duration.basis === 'time' ? shake.duration.durationUs : shake.duration.ticks) <= 0)
      fail('震动持续时间必须大于零');
  const windows = document.rules.hitWindowsUs;
  if (windows.perfect > windows.good || windows.good > windows.ok) fail('判定时间窗顺序错误');
  return document;
}

/** Formatting only; command and repository boundaries own project validation. */
export function serializeProject(project: Project): string {
  const canonicalize = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(canonicalize);
    if (value !== null && typeof value === 'object')
      return Object.fromEntries(
        Object.entries(value)
          .filter(([, item]) => item !== undefined)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([key, item]) => [key, canonicalize(item)]),
      );
    return value;
  };
  return JSON.stringify(canonicalize(project), null, 2) + '\n';
}
