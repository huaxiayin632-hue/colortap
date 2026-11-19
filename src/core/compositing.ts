import type { Layer, Project } from '../shared/models';

export const supportedBlendModes = [
  'normal',
  'multiply',
  'screen',
  'overlay',
  'darken',
  'lighten',
  'soft light',
  'hard light',
] as const;
export type SupportedBlendMode = (typeof supportedBlendModes)[number];
export function supportedBlend(mode: string): SupportedBlendMode {
  return supportedBlendModes.includes(mode as SupportedBlendMode)
    ? (mode as SupportedBlendMode)
    : 'normal';
}

/** Explicit references keep edits from silently clipping to a different sibling. */
export function validateClipping(project: Pick<Project, 'layers' | 'rootLayersBottomToTop'>): void {
  const lists = [project.rootLayersBottomToTop];
  for (const layer of Object.values(project.layers))
    if (layer.kind === 'group') lists.push(layer.childrenBottomToTop);
  for (const ids of lists) {
    let base: Layer | undefined;
    for (const id of ids) {
      const layer = project.layers[id];
      if (layer.clippingBaseId) {
        if (!base || base.id !== layer.clippingBaseId)
          throw new Error(`「${layer.name}」必须与剪贴底层相邻且处于同一分组；请保留整组剪贴关系`);
      } else base = layer;
    }
  }
}
