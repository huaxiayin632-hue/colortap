import type {
  Asset,
  BezierPath,
  LayerBase,
  Note,
  Project,
  RevealClip,
  Size,
  Vec2,
  SoundCue,
  CameraKey,
  CameraPose,
  CameraShake,
  Mixer,
  TrackLayout,
  TimingMap,
} from '../shared/models';
import type { AudioAnalysis } from '../shared/audio-analysis';
import type { NoteTimeEdit } from '../core/note-alignment';
import { validateProject } from '../shared/schema';
import type { ImageImport } from '../shared/images';
import {
  deleteLayer,
  isLocked,
  moveLayer,
  decompose,
  matrix,
  multiply,
  parents,
} from '../core/layers';
import { SceneGeometry } from '../core/scene-geometry';
import { moveNotes } from '../core/chart';
import { equalData } from '../core/project';
import { neutralCamera } from '../core/camera';

export type EditCommand =
  | { type: 'rename'; name: string }
  | { type: 'set-bpm'; bpm: number }
  | { type: 'set-beat-zero'; timeUs: number }
  | { type: 'set-timing'; timing: TimingMap }
  | { type: 'set-audio-analysis'; assetId: string; sha256: string; analysis: AudioAnalysis }
  | { type: 'resize-artwork'; size: Size }
  | { type: 'resize-output'; size: Size }
  | { type: 'set-gain'; gain: number }
  | { type: 'set-music'; asset: Asset }
  | { type: 'delete-audio'; assetId: string }
  | { type: 'import-image'; imported: ImageImport }
  | {
      type: 'set-layer';
      id: string;
      patch: Partial<
        Pick<LayerBase, 'name' | 'enabled' | 'locked' | 'opacity' | 'transform' | 'initialReveal'>
      >;
    }
  | { type: 'move-layer'; id: string; parentId: string | null; index: number }
  | {
      type: 'delete-layer';
      id: string;
      atUs?: number;
      sourceOnly?: boolean;
      revealOverride?: { clipId: string; progress: number } | null;
    }
  | { type: 'set-group-expanded'; id: string; expanded: boolean };

export type RevealCommand =
  | { type: 'put-reveal'; clip: RevealClip; paths?: BezierPath[]; hideInitially?: boolean }
  | { type: 'delete-reveal'; id: string; restoreVisibility?: boolean };
export type ProductionCommand =
  | { type: 'delete-sfx-reference'; id: string }
  | { type: 'put-sound'; cue: SoundCue }
  | { type: 'delete-sound'; id: string }
  | { type: 'put-sfx-asset'; asset: Asset; replaceId?: string }
  | { type: 'rename-audio'; id: string; label: string }
  | { type: 'set-mixer'; mixer: Mixer }
  | { type: 'put-camera-key'; key: CameraKey }
  | { type: 'delete-camera-key'; id: string }
  | { type: 'put-shake'; shake: CameraShake }
  | { type: 'delete-shake'; id: string }
  | { type: 'set-camera-base'; pose: CameraPose }
  | { type: 'enable-camera'; enabled: boolean }
  | { type: 'set-tracks'; tracks: TrackLayout };

export type ChartCommand =
  | { type: 'add-notes'; notes: Note[]; paths?: BezierPath[] }
  | { type: 'set-note'; note: Note }
  | { type: 'use-reveal-path'; note: Extract<Note, { kind: 'slider' }>; revealId: string }
  | { type: 'convert-hold'; id: string }
  | { type: 'delete-notes'; ids: string[] }
  | { type: 'move-notes'; ids: string[]; delta: Vec2; deltas?: Record<string, Vec2> }
  | { type: 'set-note-times'; updates: NoteTimeEdit[] }
  | { type: 'set-path'; path: BezierPath }
  | { type: 'set-rules'; rules: Project['rules'] };

export function applyCommand(
  project: Project,
  command: EditCommand | ChartCommand | RevealCommand | ProductionCommand,
): Project {
  // Copy only edited sections. Source pixels, asset indexes and untouched objects are
  // shared by undo snapshots and renderers; no published object may be mutated here.
  const next = { ...project };
  function enableCamera(enabled = true): void {
    next.camera = { ...next.camera, enabled };
    if (enabled && !project.camera.enabled && !Object.keys(project.camera.keys).length)
      next.camera.base = neutralCamera(project);
  }
  switch (command.type) {
    case 'delete-sfx-reference':
      next.sounds = { ...next.sounds };
      for (const [id, cue] of Object.entries(next.sounds))
        if (cue.assetId === command.id) delete next.sounds[id];
      if (next.music?.assetId !== command.id) {
        next.assets = { ...next.assets };
        delete next.assets[command.id];
      }
      break;
    case 'put-sound':
      next.sounds = { ...next.sounds, [command.cue.id]: structuredClone(command.cue) };
      break;
    case 'delete-sound':
      next.sounds = { ...next.sounds };
      delete next.sounds[command.id];
      break;
    case 'rename-audio':
      next.assets = {
        ...next.assets,
        [command.id]: { ...next.assets[command.id], label: command.label.trim() },
      };
      break;
    case 'put-sfx-asset':
      next.assets = { ...next.assets, [command.asset.id]: structuredClone(command.asset) };
      if (command.replaceId) {
        next.sounds = { ...next.sounds };
        for (const cue of Object.values(next.sounds))
          if (cue.assetId === command.replaceId)
            next.sounds[cue.id] = { ...cue, assetId: command.asset.id };
        if (next.music?.assetId !== command.replaceId) delete next.assets[command.replaceId];
      }
      break;
    case 'set-mixer':
      next.mixer = structuredClone(command.mixer);
      break;
    case 'put-camera-key':
      enableCamera();
      next.camera.keys = { ...next.camera.keys, [command.key.id]: structuredClone(command.key) };
      break;
    case 'delete-camera-key':
      next.camera = { ...next.camera, keys: { ...next.camera.keys } };
      delete next.camera.keys[command.id];
      break;
    case 'put-shake':
      enableCamera();
      next.camera.shakes = {
        ...next.camera.shakes,
        [command.shake.id]: structuredClone(command.shake),
      };
      break;
    case 'delete-shake':
      next.camera = { ...next.camera, shakes: { ...next.camera.shakes } };
      if (next.camera.shakes) delete next.camera.shakes[command.id];
      break;
    case 'set-camera-base':
      next.camera = { ...next.camera, enabled: true, base: structuredClone(command.pose) };
      break;
    case 'enable-camera':
      enableCamera(command.enabled);
      break;
    case 'set-tracks':
      next.tracks = structuredClone(command.tracks);
      break;
    case 'put-reveal':
      if (command.paths?.length) next.paths = { ...next.paths };
      for (const path of command.paths ?? []) next.paths[path.id] = structuredClone(path);
      next.reveals = { ...next.reveals, [command.clip.id]: structuredClone(command.clip) };
      if (command.hideInitially && next.layers[command.clip.layerId])
        next.layers = {
          ...next.layers,
          [command.clip.layerId]: { ...next.layers[command.clip.layerId], initialReveal: 0 },
        };
      break;
    case 'delete-reveal': {
      const layerId = next.reveals[command.id]?.layerId;
      next.reveals = { ...next.reveals };
      next.sounds = { ...next.sounds };
      delete next.reveals[command.id];
      if (
        command.restoreVisibility &&
        layerId &&
        !Object.values(next.reveals).some((c) => c.layerId === layerId)
      )
        next.layers = { ...next.layers, [layerId]: { ...next.layers[layerId], initialReveal: 1 } };
      for (const [id, sound] of Object.entries(next.sounds))
        if ('revealId' in sound.trigger && sound.trigger.revealId === command.id)
          delete next.sounds[id];
      break;
    }
    case 'rename':
      next.name = command.name.trim();
      break;
    case 'set-bpm':
      next.timing = {
        ...next.timing,
        points: next.timing.points.map((p, i) => (i === 0 ? { ...p, bpm: command.bpm } : p)),
      };
      break;
    case 'set-beat-zero':
      next.timing = { ...next.timing, beatZeroUs: command.timeUs };
      break;
    case 'set-timing':
      next.timing = structuredClone(command.timing);
      break;
    case 'set-audio-analysis':
      if (
        next.music?.assetId !== command.assetId ||
        next.assets[command.assetId]?.sha256 !== command.sha256
      )
        throw new Error('分析结果不属于当前音乐');
      next.music = {
        ...next.music,
        analysis: { sourceSha256: command.sha256, result: structuredClone(command.analysis) },
      };
      break;
    case 'resize-artwork':
      next.stage = { ...next.stage, artworkSize: { ...command.size } };
      break;
    case 'resize-output':
      next.output = { ...next.output, size: { ...command.size } };
      break;
    case 'set-gain':
      if (next.music) next.music = { ...next.music, gain: command.gain };
      break;
    case 'set-music':
      next.assets = { ...next.assets, [command.asset.id]: structuredClone(command.asset) };
      next.music = { assetId: command.asset.id, gain: next.music?.gain ?? 0.8 };
      break;
    case 'delete-audio': {
      const asset = next.assets[command.assetId];
      if (!asset || asset.kind !== 'audio') throw new Error('音频素材不存在');
      next.sounds = { ...next.sounds };
      next.assets = { ...next.assets };
      if (next.music?.assetId === asset.id) delete next.music;
      for (const [key, sound] of Object.entries(next.sounds))
        if (sound.assetId === asset.id) delete next.sounds[key];
      delete next.assets[asset.id];
      break;
    }
    case 'import-image': {
      const imported = command.imported;
      next.assets = { ...next.assets, ...structuredClone(imported.assets) };
      next.layers = { ...next.layers, ...structuredClone(imported.layers) };
      next.pixelSources = { ...next.pixelSources, ...structuredClone(imported.pixelSources) };
      next.sourceDocuments = {
        ...next.sourceDocuments,
        ...structuredClone(imported.sourceDocuments),
      };
      next.rootLayersBottomToTop = [
        ...next.rootLayersBottomToTop,
        ...imported.rootLayersBottomToTop,
      ];
      // A first illustration sets the artboard only; output/chart dimensions remain independent.
      if (!Object.keys(project.layers).length)
        next.stage = { ...next.stage, artworkSize: { ...imported.size } };
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
      next.layers = {
        ...next.layers,
        [command.id]: { ...layer, ...structuredClone(command.patch) },
      };
      break;
    }
    case 'move-layer':
      next.layers = structuredClone(next.layers);
      next.rootLayersBottomToTop = [...next.rootLayersBottomToTop];
      moveLayer(next, command.id, command.parentId, command.index);
      break;
    case 'delete-layer': {
      const parentMap = parents(project);
      const attached = Object.values(project.notes).filter((n) => {
        if (n.kind !== 'slider' || !n.binding) return false;
        let id: string | null | undefined = n.binding.layerId;
        while (id) {
          if (id === command.id) return true;
          id = parentMap.get(id);
        }
        return false;
      });
      if (attached.length) {
        const geometry = new SceneGeometry(project);
        next.notes = { ...next.notes };
        for (const original of attached) {
          if (original.kind !== 'slider') continue;
          const note = structuredClone(original);
          note.path.transform = decompose(
            multiply(
              geometry.display(
                note,
                command.atUs ?? 0,
                'preview',
                undefined,
                command.sourceOnly,
                command.revealOverride,
              ),
              matrix(note.path.transform),
            ),
          );
          delete note.binding;
          next.notes[note.id] = note;
        }
      }
      next.layers = structuredClone(next.layers);
      next.rootLayersBottomToTop = [...next.rootLayersBottomToTop];
      next.reveals = { ...next.reveals };
      next.sounds = { ...next.sounds };
      deleteLayer(next, command.id);
      break;
    }
    case 'set-group-expanded': {
      const layer = next.layers[command.id];
      if (layer?.kind === 'group')
        next.layers = { ...next.layers, [command.id]: { ...layer, expanded: command.expanded } };
      break;
    }
    case 'add-notes':
      next.notes = { ...next.notes };
      if (command.paths?.length) next.paths = { ...next.paths };
      for (const path of command.paths ?? []) {
        if (next.paths[path.id]) throw new Error('路径 ID 已存在');
        next.paths[path.id] = structuredClone(path);
      }
      for (const note of command.notes) {
        if (next.notes[note.id]) throw new Error('音符 ID 已存在');
        next.notes[note.id] = structuredClone(note);
      }
      break;
    case 'convert-hold': {
      const old = next.notes[command.id];
      if (old?.kind !== 'hold') break;
      next.notes = {
        ...next.notes,
        [old.id]: {
          id: old.id,
          at: old.at,
          kind: 'circle',
          position: old.position,
          radius: old.radius,
        },
      };
      const convert = <T extends RevealClip | SoundCue>(items: Record<string, T>) =>
        Object.fromEntries(
          Object.entries(items).map(([id, item]) => {
            const t = item.trigger;
            return [
              id,
              t.kind === 'note' &&
              t.noteId === old.id &&
              (t.event === 'hold-complete' || t.event === 'hold-fail')
                ? {
                    ...item,
                    trigger: { ...t, event: t.event === 'hold-complete' ? 'hit' : 'miss' },
                  }
                : item,
            ];
          }),
        ) as Record<string, T>;
      next.reveals = convert(next.reveals);
      next.sounds = convert(next.sounds);
      break;
    }
    case 'set-note':
      if (!next.notes[command.note.id]) throw new Error('音符不存在');
      next.notes = { ...next.notes, [command.note.id]: structuredClone(command.note) };
      break;
    case 'move-notes':
      next.notes = { ...next.notes };
      for (const id of command.ids)
        if (next.notes[id]) next.notes[id] = structuredClone(next.notes[id]);
      moveNotes(next, command.ids, command.delta, command.deltas);
      break;
    case 'set-note-times': {
      next.notes = { ...next.notes };
      for (const update of command.updates) {
        const note = next.notes[update.id];
        if (note) {
          if (update.duration && note.kind === 'circle') throw new Error('Circle 没有尾端');
          next.notes[update.id] = {
            ...note,
            ...(update.at ? { at: structuredClone(update.at) } : {}),
            ...(update.duration ? { duration: structuredClone(update.duration) } : {}),
          } as Note;
        }
      }
      break;
    }
    case 'use-reveal-path': {
      const clip = next.reveals[command.revealId];
      if (!clip || (clip.effect.kind !== 'path' && clip.effect.kind !== 'outline'))
        throw Error('描边路径不存在');
      if (clip.effect.linkedSliderId && clip.effect.linkedSliderId !== command.note.id)
        throw Error('这条描边已关联另一个 Slider');
      next.notes = { ...next.notes, [command.note.id]: structuredClone(command.note) };
      next.reveals = {
        ...next.reveals,
        [clip.id]: { ...clip, effect: { ...clip.effect, linkedSliderId: command.note.id } },
      };
      break;
    }
    case 'set-path':
      if (!next.paths[command.path.id]) throw new Error('路径不存在');
      next.paths = { ...next.paths, [command.path.id]: structuredClone(command.path) };
      break;
    case 'set-rules':
      next.rules = structuredClone(command.rules);
      break;
    case 'delete-notes': {
      const removed = new Set(command.ids),
        reveals = new Set<string>();
      next.notes = { ...next.notes };
      next.reveals = { ...next.reveals };
      next.sounds = { ...next.sounds };
      for (const id of removed) delete next.notes[id];
      for (const [id, reveal] of Object.entries(next.reveals))
        if (
          (reveal.trigger.kind === 'note' && removed.has(reveal.trigger.noteId)) ||
          (reveal.progress.kind !== 'elapsed' && removed.has(reveal.progress.noteId)) ||
          ((reveal.effect.kind === 'path' || reveal.effect.kind === 'outline') &&
            reveal.effect.linkedSliderId &&
            removed.has(reveal.effect.linkedSliderId))
        ) {
          reveals.add(id);
          delete next.reveals[id];
        }
      for (const [id, sound] of Object.entries(next.sounds))
        if (
          ('noteId' in sound.trigger && removed.has(sound.trigger.noteId)) ||
          ('revealId' in sound.trigger && reveals.has(sound.trigger.revealId))
        )
          delete next.sounds[id];
      // Paths stay in the reusable path library even after their last Slider is removed.
      break;
    }
  }
  // Restore references for no-op sections. Equal data does not invalidate renderers
  // or create an undo entry. Shared branches return immediately from equalData.
  const keys = Object.keys(next) as (keyof Project)[];
  function reuse<K extends keyof Project>(key: K): void {
    if (equalData(project[key], next[key])) next[key] = project[key];
  }
  keys.forEach(reuse);
  if (keys.every((key) => next[key] === project[key])) return project;
  // One validation at the command boundary; file I/O validates untrusted data separately.
  validateProject(next);
  next.revision++;
  next.modifiedAt = new Date().toISOString();
  return next;
}

export class EditHistory {
  private past: Project[] = [];
  private future: Project[] = [];
  private saved: Project | null;
  private previewBase: Project | null = null;
  constructor(
    public current: Project,
    recovered = false,
  ) {
    validateProject(current);
    this.saved = recovered ? null : current;
  }
  get committed(): Project {
    return this.previewBase ?? this.current;
  }
  get canUndo(): boolean {
    return this.past.length > 0;
  }
  get canRedo(): boolean {
    return this.future.length > 0;
  }
  get dirty(): boolean {
    return this.current !== this.saved;
  }
  preview(command: EditCommand | ChartCommand | RevealCommand | ProductionCommand): void {
    const base = this.previewBase ?? this.current;
    const next = applyCommand(base, command);
    this.previewBase = base;
    this.current = next;
  }
  cancelPreview(): void {
    if (this.previewBase) {
      this.current = this.previewBase;
      this.previewBase = null;
    }
  }
  execute(command: EditCommand | ChartCommand | RevealCommand | ProductionCommand): void {
    this.cancelPreview();
    const next = applyCommand(this.current, command);
    if (next === this.current) return;
    this.past.push(this.current);
    this.current = next;
    this.future = [];
  }
  undo(): void {
    this.cancelPreview();
    const previous = this.past.pop();
    if (previous) {
      this.future.push(this.current);
      this.current = previous;
    }
  }
  redo(): void {
    this.cancelPreview();
    const next = this.future.pop();
    if (next) {
      this.past.push(this.current);
      this.current = next;
    }
  }
  markSaved(project = this.committed): void {
    this.saved = project;
  }
}
