import { AlphaMaskPipe, extensions, type AlphaMaskInstruction, type Renderer } from 'pixi.js';

/**
 * Pixi 8.22's bitmap-mask pipe uses push/pop while its filter system uses bind.
 * A mask nested inside a filter would therefore return to the root surface,
 * bypassing the enclosing group's opacity/blend/clipping. Preserve the actual
 * current binding using the public render-target API; leave sprite masks alone.
 */
class LayerAlphaMaskPipe extends AlphaMaskPipe {
  constructor(private readonly layerRenderer: Renderer) {
    super(layerRenderer);
  }

  override execute(instruction: AlphaMaskInstruction): void {
    const target = this.layerRenderer.renderTarget;
    const bitmap = instruction.mask.renderMaskToTexture;
    if (bitmap && instruction.action === 'pushMaskBegin')
      target.push({ ...target.getBindState(), clear: false });
    super.execute(instruction);
    if (bitmap && instruction.action === 'pushMaskEnd') {
      // The native pipe has restored the saved binding and begun the mask filter.
      // Balance our extra stack entry without changing that new filter target.
      const active = target.getBindState();
      target.pop();
      target.bind(active);
    }
  }
}

extensions.remove(AlphaMaskPipe);
extensions.add(LayerAlphaMaskPipe);
