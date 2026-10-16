import type { Asset, LayerBase, Project, Size } from '../shared/models';
import { serializeProject, validateProject } from '../shared/schema';
import type { ImageImport } from '../shared/images';
import { deleteLayer, isLocked, moveLayer } from '../core/layers';

export type EditCommand =
  | { type: 'rename'; name: string }
  | { type: 'set-bpm'; bpm: number }
  | { type: 'set-beat-zero'; timeUs: number }
  | { type: 'resize-artwork'; size: Size }
  | { type: 'resize-output'; size: Size }
  | { type: 'set-gain'; gain: number }
  | { type: 'set-music'; asset: Asset }
  | { type: 'delete-audio'; assetId: string }
  | { type: 'import-image'; imported: ImageImport }
  | {
      type: 'set-layer';
      id: string;
      patch: Partial<Pick<LayerBase, 'name' | 'enabled' | 'locked' | 'opacity' | 'transform'>>;
    }
  | { type: 'move-layer'; id: string; parentId: string | null; index: number }
  | { type: 'delete-layer'; id: string }
  | { type: 'set-group-expanded'; id: string; expanded: boolean };

export function applyCommand(project: Project, command: EditCommand): Project {
  const next = structuredClone(project);
  switch (command.type) {
    case 'rename':
      next.name = command.name.trim();
      break;
    case 'set-bpm':
      next.timing.points[0].bpm = command.bpm;
      break;
    case 'set-beat-zero':
      next.timing.beatZeroUs = command.timeUs;
      break;
    case 'resize-artwork':
      next.stage.artworkSize = { ...command.size };
      break;
    case 'resize-output':
      next.output.size = { ...command.size };
      break;
    case 'set-gain':
      if (next.music) next.music.gain = command.gain;
      break;
    case 'set-music':
      next.assets[command.asset.id] = command.asset;
      next.music = { assetId: command.asset.id, gain: next.music?.gain ?? 0.8 };
      break;
    case 'delete-audio': {
      const asset = next.assets[command.assetId];
      if (!asset || asset.kind !== 'audio') throw new Error('音频素材不存在');
      if (next.music?.assetId === asset.id) delete next.music;
      for (const [key, sound] of Object.entries(next.sounds))
        if (sound.assetId === asset.id) delete next.sounds[key];
      delete next.assets[asset.id];
      break;
    }
    case 'import-image': {
      const imported = command.imported;
      for (const key of ['assets', 'layers', 'pixelSources', 'sourceDocuments'] as const)
        Object.assign(next[key], structuredClone(imported[key]));
      next.rootLayersBottomToTop.push(...imported.rootLayersBottomToTop);
      // A first illustration sets the artboard only; output/chart dimensions remain independent.
      if (!Object.keys(project.layers).length) next.stage.artworkSize = { ...imported.size };
      break;
    }
    case 'set-layer': {
      const layer = next.layers[command.id];
      if (!layer) throw new Error('图层不存在');
      if (
        (command.patch.transform || command.patch.opacity !== undefined) &&
        isLocked(next, command.id)
      )
        throw new Error('请先解锁图层或所属分组');
      if (command.patch.locked !== undefined && isLocked(next, command.id, false))
        throw new Error('请先解锁所属分组');
      Object.assign(layer, structuredClone(command.patch));
      break;
    }
    case 'move-layer':
      moveLayer(next, command.id, command.parentId, command.index);
      break;
    case 'delete-layer':
      deleteLayer(next, command.id);
      break;
    case 'set-group-expanded': {
      const layer = next.layers[command.id];
      if (layer?.kind === 'group') layer.expanded = command.expanded;
      break;
    }
  }
  // Validate before publishing the edit, so a failed edit never changes the document.
  validateProject(next);
  next.revision++;
  next.modifiedAt = new Date().toISOString();
  return next;
}

export class EditHistory {
  private past: Project[] = [];
  private future: Project[] = [];
  private saved = '';
  constructor(public current: Project) {
    this.markSaved();
  }
  get canUndo(): boolean {
    return this.past.length > 0;
  }
  get canRedo(): boolean {
    return this.future.length > 0;
  }
  get dirty(): boolean {
    return serializeProject(this.current) !== this.saved;
  }
  execute(command: EditCommand): void {
    const next = applyCommand(this.current, command);
    // Ignore edits that do not change authoring content.
    const before = { ...this.current, revision: 0, modifiedAt: '' };
    const after = { ...next, revision: 0, modifiedAt: '' };
    if (JSON.stringify(before) === JSON.stringify(after)) return;
    this.past.push(this.current);
    this.current = next;
    this.future = [];
  }
  undo(): void {
    const previous = this.past.pop();
    if (previous) {
      this.future.push(this.current);
      this.current = previous;
    }
  }
  redo(): void {
    const next = this.future.pop();
    if (next) {
      this.past.push(this.current);
      this.current = next;
    }
  }
  markSaved(): void {
    this.saved = serializeProject(this.current);
  }
}
