import { describe, expect, it } from 'vitest';
import { createProject, type Layer, type Transform2D } from '../src/shared/models';
import { serializeProject, validateProject } from '../src/shared/schema';

const transform = (): Transform2D => ({
  position: { x: 0, y: 0 },
  scale: { x: 1, y: 1 },
  rotationRad: 0,
  skewRad: { x: 0, y: 0 },
  pivot: { x: 0, y: 0 },
});
function layerBase() {
  return {
    id: crypto.randomUUID(),
    name: '同名图层',
    transform: transform(),
    opacity: 0.37,
    enabled: true,
    locked: false,
    initialReveal: 1 as const,
    blendMode: 'normal',
  };
}

describe('versioned project documents', () => {
  it('round-trips a project without introducing UI or renderer state', () => {
    const project = createProject('保存测试');
    expect(validateProject(JSON.parse(serializeProject(project)))).toEqual(project);
    expect(serializeProject(validateProject(project))).toBe(serializeProject(project));
    expect(() => validateProject({ ...project, selectedLayer: 'a' })).toThrow();
  });
  it('keeps source dimensions, scene dimensions and output dimensions independent', () => {
    const project = createProject('大画板', { width: 12000, height: 9000 });
    expect(validateProject(project).stage.artworkSize).toEqual({ width: 12000, height: 9000 });
    expect(project.output.size).toEqual({ width: 1920, height: 1080 });
  });
  it('preserves 100 renderable layers plus nested groups, bounds, opacity and ordering', () => {
    const project = createProject();
    const assetId = crypto.randomUUID(),
      pixelSourceId = crypto.randomUUID();
    project.assets[assetId] = {
      id: assetId,
      kind: 'psd',
      relativePath: `assets/originals/${assetId}.psd`,
      originalName: '原稿.psd',
      byteLength: 123,
      sha256: 'a'.repeat(64),
      pixelSize: { width: 6000, height: 6000 },
    };
    project.pixelSources[pixelSourceId] = {
      id: pixelSourceId,
      sourceAssetId: assetId,
      originalBounds: { x: -250, y: 400, width: 6000, height: 6000 },
      cropRect: { x: 500, y: 300, width: 3000, height: 2000 },
      levels: [],
    };
    const groups: Layer[] = Array.from({ length: 3 }, () => ({
      ...layerBase(),
      kind: 'group',
      childrenBottomToTop: [],
      isolation: 'isolated',
    }));
    for (const group of groups) project.layers[group.id] = group;
    project.rootLayersBottomToTop = [groups[0].id];
    (groups[0] as Extract<Layer, { kind: 'group' }>).childrenBottomToTop.push(groups[1].id);
    (groups[1] as Extract<Layer, { kind: 'group' }>).childrenBottomToTop.push(groups[2].id);
    for (let index = 0; index < 100; index++) {
      const layer: Layer = { ...layerBase(), kind: 'raster', pixelSourceId };
      project.layers[layer.id] = layer;
      (groups[2] as Extract<Layer, { kind: 'group' }>).childrenBottomToTop.push(layer.id);
    }
    const restored = validateProject(JSON.parse(serializeProject(project)));
    expect(Object.values(restored.layers).filter((item) => item.kind === 'raster')).toHaveLength(
      100,
    );
    expect(restored.layers).toEqual(project.layers);
    expect(restored.pixelSources).toEqual(project.pixelSources);
  });
  it('rejects cycles and disconnected layers', () => {
    const project = createProject();
    const group: Layer = {
      ...layerBase(),
      kind: 'group',
      isolation: 'isolated',
      childrenBottomToTop: [],
    };
    project.layers[group.id] = group;
    project.rootLayersBottomToTop = [group.id];
    group.childrenBottomToTop.push(group.id);
    expect(() => validateProject(project)).toThrow(/循环/);
    group.childrenBottomToTop = [];
    project.rootLayersBottomToTop = [];
    expect(() => validateProject(project)).toThrow(/未连接/);
  });
  it('rejects unknown versions without silently dropping fields', () => {
    expect(() => validateProject({ ...createProject(), schemaVersion: 2 })).toThrow(/数据格式/);
  });
  it('rejects missing references and non-finite or fractional dimensions', () => {
    const project = createProject();
    project.music = { assetId: crypto.randomUUID(), gain: 1 };
    expect(() => validateProject(project)).toThrow(/引用不存在/);
    delete project.music;
    project.stage.artworkSize.width = Infinity;
    expect(() => validateProject(project)).toThrow();
    project.stage.artworkSize.width = 12.5;
    expect(() => validateProject(project)).toThrow();
  });
});
