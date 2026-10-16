import { z } from 'zod';
import type { Project } from './models';

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
const pathUse = z.object({ pathId: id, transform }).strict();
const trigger = z.union([
  z.object({ kind: z.literal('timeline'), at: moment }).strict(),
  z
    .object({
      kind: z.literal('note'),
      noteId: id,
      event: z.enum(['hit', 'miss', 'slider-complete', 'slider-fail']),
    })
    .strict(),
]);
const record = <T extends z.ZodType>(value: T) => z.record(id, value);

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
const pose = { position: vec, zoom: positive, rotationRad: finite };

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
      .object({ assetId: id, gain: finite.min(0).max(1) })
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
            kind: z.literal('slider'),
            path: pathUse,
            duration: span,
            headRadius: positive,
            followRadius: positive,
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
                kind: z.literal('path'),
                path: pathUse,
                maskWidth: positive,
                completion: z.enum(['keep-mask', 'show-full-layer']),
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
            z.object({ kind: z.literal('reveal-start'), revealId: id }).strict(),
          ]),
          delayUs: us.nonnegative(),
          gain: finite.min(0).max(1),
          pan: finite.min(-1).max(1),
        })
        .strict(),
    ),
    camera: z
      .object({
        base: z.object(pose).strict(),
        keys: record(z.object({ id, at: moment, ...pose, easingToNext: ease }).strict()),
      })
      .strict(),
    rules: z
      .object({
        hitWindowsUs: z
          .object({ perfect: us.nonnegative(), good: us.nonnegative(), ok: us.nonnegative() })
          .strict(),
        sliderCompleteRatio: finite.min(0).max(1),
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
    if (item.kind === 'group') pending.push(...item.childrenBottomToTop);
    else requireRef(document.pixelSources, item.pixelSourceId, '图层像素');
  }
  if (seen.size !== Object.keys(document.layers).length) fail('存在未连接到图层树的图层');
  for (const path of Object.values(document.paths)) for (const node of path.nodes) addId(node.id);
  for (const note of Object.values(document.notes))
    if (note.kind === 'slider') requireRef(document.paths, note.path.pathId, 'Slider 路径');
  const checkTrigger = (value: Project['reveals'][string]['trigger']): void => {
    if (value.kind === 'note') requireRef(document.notes, value.noteId, '音符事件');
  };
  for (const clip of Object.values(document.reveals)) {
    requireRef(document.layers, clip.layerId, '演出图层');
    checkTrigger(clip.trigger);
    if (clip.progress.kind !== 'elapsed') {
      requireRef(document.notes, clip.progress.noteId, '进度来源');
      if (document.notes[clip.progress.noteId].kind !== 'slider')
        fail('Slider 进度必须引用 Slider');
    }
    if (clip.effect.kind === 'path')
      requireRef(document.paths, clip.effect.path.pathId, '显现路径');
  }
  for (const cue of Object.values(document.sounds)) {
    requireRef(document.assets, cue.assetId, '音效');
    if (document.assets[cue.assetId].kind !== 'audio') fail('音效必须引用音频素材');
    if (cue.trigger.kind === 'reveal-start')
      requireRef(document.reveals, cue.trigger.revealId, '演出事件');
    else checkTrigger(cue.trigger);
  }
  const windows = document.rules.hitWindowsUs;
  if (windows.perfect > windows.good || windows.good > windows.ok) fail('判定时间窗顺序错误');
  return document;
}

export function serializeProject(project: Project): string {
  const valid = validateProject(project);
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
  return JSON.stringify(canonicalize(valid), null, 2) + '\n';
}
