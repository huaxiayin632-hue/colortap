import type { Asset, Project } from './models';
import type { ImageImport, ImageImportProgress } from './images';

export type Result<T> = { ok: true; value: T } | { ok: false; error: string };
export interface ProjectSession {
  handle: string;
  project: Project;
  filePath: string | null;
  warnings: string[];
}
export interface SaveResult {
  filePath: string;
  savedRevision: number;
}
export interface ProcessSample {
  sampledAt: string;
  processes: {
    pid: number;
    type: string;
    cpuPercent: number;
    workingSetKiB: number;
    peakWorkingSetKiB: number;
    privateKiB: number | null;
  }[];
}
export interface DesktopAPI {
  newProject(project: Project): Promise<Result<ProjectSession>>;
  openProject(): Promise<Result<ProjectSession | null>>;
  saveProject(request: {
    handle: string;
    project: Project;
    saveAs: boolean;
  }): Promise<Result<SaveResult | null>>;
  importMusic(handle: string): Promise<Result<Asset | null>>;
  importImage(request: { handle: string; tileSize: number }): Promise<Result<ImageImport | null>>;
  cancelImageImport(): Promise<Result<void>>;
  onImageProgress(listener: (progress: ImageImportProgress) => void): () => void;
  readAsset(request: { handle: string; assetId: string }): Promise<Result<ArrayBuffer>>;
  discardImport(request: { handle: string; assetId: string }): Promise<Result<void>>;
  closeSession(handle: string): Promise<Result<void>>;
  setDirty(request: { handle: string; dirty: boolean }): Promise<Result<void>>;
  processSample(): Promise<Result<ProcessSample>>;
  exportPerformance(report: string): Promise<Result<string | null>>;
}
export const channels = {
  newProject: 'project:new',
  openProject: 'project:open',
  saveProject: 'project:save',
  importMusic: 'music:import',
  importImage: 'image:import',
  cancelImageImport: 'image:cancel',
  imageProgress: 'image:progress',
  readAsset: 'asset:read',
  discardImport: 'asset:discard',
  closeSession: 'project:close-session',
  setDirty: 'project:dirty',
  processSample: 'performance:sample',
  exportPerformance: 'performance:export',
} as const;

export function unwrap<T>(result: Result<T>): T {
  if (!result.ok) throw new Error(result.error);
  return result.value;
}
