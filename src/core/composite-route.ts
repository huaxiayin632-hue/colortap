import type { Layer, Project } from '../shared/models';
import { supportedBlend } from './compositing';

/** Conservative proof: all descendants use source-over (clipping stacks keep
 * their own isolation). Never flatten a normal group merely because it is opaque.
 */
export function normalSubtrees(project: Project): Set<string> {
  const normal = new Set<string>();
  const visit = (id: string): boolean => {
    const l = project.layers[id];
    const childrenNormal = l.kind !== 'group' || l.childrenBottomToTop.map(visit).every(Boolean);
    const result = supportedBlend(l.blendMode) === 'normal' && childrenNormal;
    if (result) normal.add(id);
    return result;
  };
  project.rootLayersBottomToTop.forEach(visit);
  return normal;
}

export function compositeRoute(
  layer: Layer,
  alpha: number,
  deferred: boolean,
  dynamicMask: boolean,
  normalSubtree: boolean,
  hasReveal: boolean,
  documentIsolated: boolean,
) {
  const mode = deferred ? 'normal' : supportedBlend(layer.blendMode);
  const clipped = !!layer.clippingBaseId;
  // Raster tiles do not overlap in source space. Masks and groups still flatten
  // first so clipping/opacity applies to the combined image exactly once.
  const directClipped =
    clipped &&
    mode === 'normal' &&
    layer.kind === 'raster' &&
    !layer.rasterMask?.enabled &&
    !dynamicMask;
  const ownAlpha = deferred ? 1 : alpha;
  const groupIsolation =
    layer.kind === 'group' &&
    (ownAlpha !== 1 ||
      (!layer.rasterMask?.enabled &&
        (layer.isolation === 'isolated' || hasReveal) &&
        !normalSubtree));
  const maskedOpacity = !!layer.rasterMask?.enabled && ownAlpha !== 1;
  // The main framebuffer uses MSAA; CompositeFilter targets do not. Without a
  // document filter, removing the last isolation changes rotated edge coverage
  // and the AA inherited by nested bitmap masks. Keep those original surfaces.
  const preserveSurface =
    !documentIsolated &&
    (!!layer.rasterMask?.enabled ||
      (layer.kind === 'group' && (layer.isolation === 'isolated' || hasReveal)));
  const filtered =
    !directClipped &&
    (clipped || mode !== 'normal' || groupIsolation || maskedOpacity || preserveSurface);
  return { mode, directClipped, key: filtered ? `${mode}:${clipped}` : undefined };
}
