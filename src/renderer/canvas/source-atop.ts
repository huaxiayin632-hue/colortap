import { GlStateSystem, extensions, type BLEND_MODES, type GlRenderingContext } from 'pixi.js';

// Internal WebGL blend state, never a project/PSD blend mode. Pixi 8.22 batches by
// the mode string but its public union does not include Porter-Duff source-atop.
export const sourceAtop = 'rhythm-source-atop' as BLEND_MODES;
class ClippingStateSystem extends GlStateSystem {
  protected override contextChange(gl: GlRenderingContext): void {
    super.contextChange(gl);
    // Premultiplied C = S * Ad + D * (1 - As), A = Ad. No backdrop texture copy.
    this.blendModesMap[sourceAtop] = [gl.DST_ALPHA, gl.ONE_MINUS_SRC_ALPHA, gl.ZERO, gl.ONE];
  }
}
extensions.remove(GlStateSystem);
extensions.add(ClippingStateSystem);
