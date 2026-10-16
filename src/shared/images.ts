import type { Project, Size } from './models';

export interface ImageImportProgress {
  handle: string;
  phase: string;
  completed: number;
  total: number;
}
export interface ImageImportMetrics {
  elapsedMs: number;
  peakWorkerRssBytes: number;
  peakWorkerExternalBytes: number;
  originalBytes: number;
  derivedBytes: number;
  rasterLayers: number;
  groups: number;
  tiles: number;
}
/** Only serializable metadata crosses IPC. Bitmaps remain in the background process/on disk. */
export interface ImageImport {
  id: string;
  name: string;
  size: Size;
  assets: Project['assets'];
  pixelSources: Project['pixelSources'];
  layers: Project['layers'];
  rootLayersBottomToTop: string[];
  sourceDocuments: Project['sourceDocuments'];
  warnings: string[];
  metrics: ImageImportMetrics;
}
export interface ImageWorkerRequest {
  sourceFile: string;
  stagingRoot: string;
  importId: string;
  tileSize: number;
}
