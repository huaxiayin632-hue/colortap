import { describe, expect, it } from 'vitest';
import { EditHistory } from '../src/application/history';
import { createProject, type Asset } from '../src/shared/models';
import { serializeProject, validateProject } from '../src/shared/schema';

const audio = (): Asset => ({
  id: crypto.randomUUID(),
  kind: 'audio',
  relativePath: `assets/${crypto.randomUUID()}.wav`,
  originalName: 'music.wav',
  sha256: '0'.repeat(64),
  byteLength: 44,
});

describe('document commands and history', () => {
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
