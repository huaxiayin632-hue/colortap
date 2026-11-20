import { describe, expect, it } from 'vitest';
import { EditHistory, applyCommand } from '../src/application/history';
import { createProject, type Asset, type Project } from '../src/shared/models';
import { serializeProject, validateProject } from '../src/shared/schema';
import { identityTransform } from '../src/core/layers';
import { createSlider } from '../src/core/chart';

function freeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
}

const audio = (): Asset => ({
  id: crypto.randomUUID(),
  kind: 'audio',
  relativePath: `assets/${crypto.randomUUID()}.wav`,
  originalName: 'music.wav',
  sha256: '0'.repeat(64),
  byteLength: 44,
});

describe('document commands and history', () => {
  it('shares unchanged asset indexes across edits and restores the saved snapshot without serializing it', () => {
    const project = createProject();
    const asset = audio();
    project.assets[asset.id] = asset;
    const h = new EditHistory(freeze(project));
    for (let i = 0; i < 100; i++) {
      h.execute({ type: 'rename', name: `名称 ${i}` });
      expect(h.current.assets).toBe(project.assets);
      expect(h.current.pixelSources).toBe(project.pixelSources);
      expect(h.current.notes).toBe(project.notes);
    }
    h.markSaved();
    const saved = h.current;
    h.execute({ type: 'rename', name: saved.name });
    expect(h.current).toBe(saved);
    expect(h.dirty).toBe(false);
    h.undo();
    expect(h.dirty).toBe(true);
    h.redo();
    expect(h.current).toBe(saved);
    expect(h.dirty).toBe(false);
  });
  it('changes only selected objects and never mutates command payloads or frozen undo snapshots', () => {
    const p = createProject(),
      s = createSlider({ x: 30, y: 40 }, { x: 230, y: 140 }, { basis: 'time', timeUs: 1e6 });
    const group = (id: string): Project['layers'][string] => ({
      id,
      kind: 'group',
      name: id,
      childrenBottomToTop: [],
      isolation: 'pass-through',
      transform: identityTransform(),
      opacity: 1,
      enabled: true,
      locked: false,
      initialReveal: 1,
      blendMode: 'normal',
    });
    const a = group(crypto.randomUUID()),
      b = group(crypto.randomUUID());
    p.layers[a.id] = a;
    p.layers[b.id] = b;
    p.rootLayersBottomToTop = [a.id, b.id];
    p.notes[s.note.id] = s.note;
    p.paths[s.path.id] = s.path;
    const h = new EditHistory(freeze(p));
    h.execute({ type: 'set-layer', id: a.id, patch: { opacity: 0.4 } });
    expect(h.current.layers[b.id]).toBe(b);
    expect(h.current.paths).toBe(p.paths);
    h.execute({ type: 'move-layer', id: a.id, parentId: b.id, index: 0 });
    expect(p.rootLayersBottomToTop).toEqual([a.id, b.id]);
    h.execute({ type: 'move-notes', ids: [s.note.id], delta: { x: 20, y: 10 } });
    expect(s.note.path.transform.position).toEqual({ x: 0, y: 0 });
    expect(h.current.paths[s.path.id]).toBe(s.path);
    const edited = structuredClone(h.current.notes[s.note.id]);
    h.execute({ type: 'set-note', note: edited });
    const snapshot = h.current;
    if (edited.kind === 'slider') edited.path.transform.position.x = 999;
    expect(h.current).toBe(snapshot);
    expect(h.current.notes[s.note.id]).not.toEqual(edited);
    const beforeDelete = freeze(h.current);
    h.execute({ type: 'delete-layer', id: b.id });
    expect(h.current.layers).toEqual({});
    h.undo();
    expect(h.current).toBe(beforeDelete);
    expect(() =>
      applyCommand(beforeDelete, { type: 'set-layer', id: a.id, patch: { opacity: -1 } }),
    ).toThrow();
    expect(h.current.layers[a.id].opacity).toBe(0.4);
  });
  it('treats equal values with different property order as the same edit and preserves redo', () => {
    const h = new EditHistory(createProject());
    h.execute({ type: 'resize-artwork', size: { height: 4200, width: 5500 } });
    h.undo();
    const original = h.current;
    h.execute({ type: 'resize-artwork', size: { height: 6000, width: 6000 } });
    expect(h.current).toBe(original);
    expect(h.canRedo).toBe(true);
  });
  it('undoes and redoes actual BPM and scene edits without mutating prior documents', () => {
    const original = createProject();
    const history = new EditHistory(original);
    history.execute({ type: 'set-bpm', bpm: 137 });
    history.execute({ type: 'resize-artwork', size: { width: 10000, height: 7500 } });
    expect(original.stage.artworkSize.width).toBe(6000);
    expect(original.timing.points[0].bpm).toBe(120);
    history.undo();
    expect(history.current.stage.artworkSize.width).toBe(6000);
    history.undo();
    expect(history.current.timing.points[0].bpm).toBe(120);
    expect(history.dirty).toBe(false);
    history.redo();
    expect(history.current.timing.points[0].bpm).toBe(137);
  });
  it('recognizes the saved position and invalidates redo after a branch edit', () => {
    const history = new EditHistory(createProject());
    history.execute({ type: 'rename', name: '保存点' });
    history.markSaved();
    history.execute({ type: 'set-bpm', bpm: 145 });
    expect(history.dirty).toBe(true);
    history.undo();
    expect(history.dirty).toBe(false);
    history.execute({ type: 'set-bpm', bpm: 150 });
    expect(history.canRedo).toBe(false);
  });
  it('does not publish failed commands or no-op edits', () => {
    const original = createProject();
    const history = new EditHistory(original);
    expect(() => history.execute({ type: 'set-bpm', bpm: 0 })).toThrow();
    expect(history.current).toBe(original);
    expect(history.canUndo).toBe(false);
    history.execute({ type: 'set-bpm', bpm: 120 });
    expect(history.canUndo).toBe(false);
  });
  it('commits multiple previews as a single undoable edit', () => {
    const original = createProject();
    const history = new EditHistory(original);
    history.preview({ type: 'set-bpm', bpm: 130 });
    history.preview({ type: 'set-bpm', bpm: 140 });
    history.preview({ type: 'set-bpm', bpm: 150 });
    history.execute({ type: 'set-bpm', bpm: 150 });
    expect(history.current.timing.points[0].bpm).toBe(150);
    history.undo();
    expect(history.current).toBe(original);
    expect(history.canUndo).toBe(false);
  });
  it('cancels previews back to the identical original project', () => {
    const original = createProject();
    const history = new EditHistory(original);
    history.preview({ type: 'set-bpm', bpm: 130 });
    history.preview({ type: 'set-bpm', bpm: 140 });
    history.cancelPreview();
    expect(history.current).toBe(original);
  });
  it('cancels a preview before undoing a committed edit', () => {
    const original = createProject();
    const history = new EditHistory(original);
    history.execute({ type: 'rename', name: '已提交' });
    history.preview({ type: 'set-bpm', bpm: 140 });
    history.undo();
    expect(history.current).toBe(original);
    expect(history.canRedo).toBe(true);
  });
  it('keeps the last successful preview when a later preview is invalid', () => {
    const original = createProject();
    const history = new EditHistory(original);
    history.preview({ type: 'set-bpm', bpm: 140 });
    const lastGood = history.current;
    expect(() => history.preview({ type: 'set-bpm', bpm: 0 })).toThrow();
    expect(history.current).toBe(lastGood);
    history.cancelPreview();
    expect(history.current).toBe(original);
  });
  it('removes the current audio and its cues from serialized data, with complete undo/redo', () => {
    const project = createProject(),
      asset = audio(),
      cueId = crypto.randomUUID();
    project.assets[asset.id] = asset;
    project.music = { assetId: asset.id, gain: 0.42 };
    project.sounds[cueId] = {
      id: cueId,
      assetId: asset.id,
      trigger: { kind: 'timeline', at: { basis: 'time', timeUs: 0 } },
      gain: 1,
      pan: 0,
      delayUs: 0,
    };
    const history = new EditHistory(project);
    history.execute({ type: 'delete-audio', assetId: asset.id });
    const reopened = validateProject(JSON.parse(serializeProject(history.current)));
    expect(reopened.music).toBeUndefined();
    expect(reopened.assets[asset.id]).toBeUndefined();
    expect(reopened.sounds).toEqual({});
    history.undo();
    expect(history.current).toEqual(project);
    history.redo();
    expect(history.current.music).toBeUndefined();
  });
  it('removes an unused audio asset without affecting current music and rejects non-audio deletion', () => {
    const project = createProject(),
      current = audio(),
      unused = audio();
    project.assets[current.id] = current;
    project.assets[unused.id] = unused;
    project.music = { assetId: current.id, gain: 0.8 };
    const image = { ...audio(), kind: 'png' as const };
    project.assets[image.id] = image;
    const history = new EditHistory(project);
    history.execute({ type: 'delete-audio', assetId: unused.id });
    expect(history.current.music).toEqual(project.music);
    expect(history.current.assets[current.id]).toEqual(current);
    expect(history.current.assets[unused.id]).toBeUndefined();
    expect(() => history.execute({ type: 'delete-audio', assetId: image.id })).toThrow('不存在');
    expect(history.current.assets[image.id]).toEqual(image);
  });
});
describe('recovery save boundaries', () => {
  it('restored state remains dirty through undo until explicitly saved', () => {
    const project = createProject(),
      history = new EditHistory(project, true);
    expect(history.dirty).toBe(true);
    history.execute({ type: 'rename', name: '恢复后修改' });
    history.undo();
    expect(history.dirty).toBe(true);
    history.markSaved();
    expect(history.dirty).toBe(false);
  });
  it('exposes committed edits and marks only the document actually saved', () => {
    const history = new EditHistory(createProject());
    history.execute({ type: 'rename', name: '正在保存' });
    const saved = history.committed;
    history.preview({ type: 'set-bpm', bpm: 150 });
    expect(history.committed).toBe(saved);
    history.markSaved(saved);
    expect(history.dirty).toBe(true);
    history.execute({ type: 'set-bpm', bpm: 160 });
    history.markSaved(saved);
    expect(history.dirty).toBe(true);
    history.undo();
    expect(history.dirty).toBe(false);
  });
});
