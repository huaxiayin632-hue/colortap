import { FilterSystem, MaskFilter, extensions } from 'pixi.js';
import { CompositeFilter } from './composite-filter';

/** Counts submitted filter draws, rather than the number of attached filter objects.
 * The renderer is WebGL-only; no GPU timings or total VRAM are inferred here.
 */
export class CompositingMetrics extends FilterSystem {
  private frame = { filterPasses: 0, compositePasses: 0, maskPasses: 0, backdropCopies: 0 };
  beginFrame(): void {
    this.frame = { filterPasses: 0, compositePasses: 0, maskPasses: 0, backdropCopies: 0 };
  }
  snapshot() {
    return { ...this.frame };
  }
  override applyFilter(...args: Parameters<FilterSystem['applyFilter']>): void {
    this.frame.filterPasses++;
    if (args[0] instanceof CompositeFilter) this.frame.compositePasses++;
    if (args[0] instanceof MaskFilter) this.frame.maskPasses++;
    super.applyFilter(...args);
  }
  override getBackTexture(...args: Parameters<FilterSystem['getBackTexture']>) {
    this.frame.backdropCopies++;
    return super.getBackTexture(...args);
  }
}
extensions.remove(FilterSystem);
extensions.add(CompositingMetrics);
