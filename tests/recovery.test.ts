import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createProject } from '../src/shared/models';
import { ProjectRepository } from '../src/main/projects/repository';

let root: string, repository: ProjectRepository;
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'rhythm-recovery-unit-'));
  repository = new ProjectRepository(path.join(root, 'sessions'));
});
afterEach(async () => {
  vi.restoreAllMocks();
  await repository.closeAll();
  if (
    path.dirname(root) !== os.tmpdir() ||
    !path.basename(root).startsWith('rhythm-recovery-unit-')
  )
    throw Error('Unsafe test cleanup');
  await fs.rm(root, { recursive: true, force: true });
});
async function setup() {
  const project = createProject('尚未保存的工程'),
    session = await repository.create(project);
  const original = path.join(root, `${randomUUID()}.wav`),
    bytes = Buffer.from('RIFF recovery music and sfx');
  await fs.writeFile(original, bytes);
  const music = await repository.importAudio(session.handle, original);
  const sound = await repository.importAudio(session.handle, original);
  sound.audioRole = 'sfx';
  project.assets[music.id] = music;
  project.assets[sound.id] = sound;
  project.music = { assetId: music.id, gain: 0.8 };
  return { project, session, original, music, sound, bytes };
}

describe('recovery storage and session ownership', () => {
  it('cleans interrupted pointer files and uncommitted generations without changing the last complete version', async () => {
    const { project, session } = await setup();
    const entry = (await repository.snapshot(session.handle, project, 1))!;
    const folder = path.join(root, 'recoveries', entry.id);
    const temporary = `.current.json.${randomUUID()}.tmp`,
      generation = randomUUID();
    await fs.writeFile(path.join(folder, temporary), 'incomplete');
    await fs.mkdir(path.join(folder, generation));
    await fs.writeFile(path.join(folder, 'keep.txt'), 'not owned');
    expect((await repository.listRecoveries()).entries).toEqual([entry]);
    const files = await fs.readdir(folder);
    expect(files).not.toContain(temporary);
    expect(files).not.toContain(generation);
    expect(files).toContain('keep.txt');
    expect(files).toContain(entry.token);
  });
  it('restores unnamed projects and all audio from independent assets after session cleanup', async () => {
    const { project, session, original, music, sound, bytes } = await setup();
    const entry = (await repository.snapshot(session.handle, project, 1))!;
    await repository.close(session.handle);
    await fs.unlink(original);
    expect((await repository.listRecoveries()).entries).toEqual([entry]);
    const restored = await repository.restoreRecovery(entry.id, entry.token);
    expect(restored.project).toEqual(project);
    expect(restored.filePath).toBeNull();
    expect(restored.recovery?.savedAt).toBe(entry.savedAt);
    for (const asset of [music, sound])
      expect(Buffer.from(await repository.readAsset(restored.handle, asset.id))).toEqual(bytes);
    const file = path.join(root, '正式', '工程.rcproj');
    await repository.save(restored.handle, project, file, entry.version);
    expect((await repository.listRecoveries()).entries).toEqual([]);
    expect((await repository.open(file)).project).toEqual(project);
  });
  it('leaves the official document untouched and retains recovery through a second crash', async () => {
    const { project, session, music, bytes } = await setup();
    const file = path.join(root, '正式', '工程.rcproj');
    await repository.save(session.handle, project, file, 1);
    const saved = await fs.readFile(file, 'utf8');
    project.name = '未正式保存的修改';
    const entry = (await repository.snapshot(session.handle, project, 2))!;
    expect(await fs.readFile(file, 'utf8')).toBe(saved);
    await repository.close(session.handle);
    const recovered = await repository.restoreRecovery(entry.id, entry.token);
    expect(recovered.filePath).toBe(file);
    await repository.close(recovered.handle);
    const again = await repository.restoreRecovery(entry.id, entry.token);
    expect(again.project.name).toBe(project.name);
    expect(Buffer.from(await repository.readAsset(again.handle, music.id))).toEqual(bytes);
  });
  it.each(['asset-copy', 'pointer-commit'])(
    'keeps the previous complete snapshot on %s failure',
    async (failure) => {
      const { project, session } = await setup();
      const first = (await repository.snapshot(session.handle, project, 1))!;
      project.name = '不会替换完整快照';
      if (failure === 'asset-copy')
        vi.spyOn(fs, 'copyFile').mockRejectedValueOnce(Error('disk full'));
      else {
        const rename = fs.rename.bind(fs);
        vi.spyOn(fs, 'rename').mockImplementation(async (from, to) => {
          if (path.basename(String(to)) === 'current.json') throw Error('interrupted pointer');
          return rename(from, to);
        });
      }
      await expect(repository.snapshot(session.handle, project, 2)).rejects.toThrow();
      expect((await repository.listRecoveries()).entries).toEqual([first]);
      await repository.close(session.handle);
      expect((await repository.restoreRecovery(first.id, first.token)).project.name).toBe(
        '尚未保存的工程',
      );
    },
  );
  it('does not advertise a partial first snapshot or delete an unrelated folder', async () => {
    const { project, session } = await setup();
    vi.spyOn(fs, 'copyFile').mockRejectedValueOnce(Error('disk full'));
    await expect(repository.snapshot(session.handle, project, 1)).rejects.toThrow();
    const unrelated = path.join(root, 'recoveries', 'user-folder');
    await fs.mkdir(unrelated);
    await fs.writeFile(path.join(unrelated, 'keep.txt'), 'keep');
    expect((await repository.listRecoveries()).entries).toEqual([]);
    expect(await fs.readFile(path.join(unrelated, 'keep.txt'), 'utf8')).toBe('keep');
  });
  it('rejects corrupt recovery assets without deleting the snapshot', async () => {
    const { project, session, music } = await setup();
    const entry = (await repository.snapshot(session.handle, project, 1))!;
    await repository.close(session.handle);
    await fs.writeFile(
      path.join(root, 'recoveries', entry.id, entry.token, music.relativePath),
      'broken',
    );
    const list = await repository.listRecoveries();
    expect(list.entries).toEqual([]);
    expect(list.warnings).toHaveLength(1);
    await expect(repository.restoreRecovery(entry.id, entry.token)).rejects.toThrow(/损坏/);
    expect(await fs.stat(path.join(root, 'recoveries', entry.id, 'current.json'))).toBeTruthy();
  });
  it('preserves a newer snapshot and other projects when saving an older version', async () => {
    const { project, session } = await setup();
    const older = structuredClone(project);
    project.name = '较新的修改';
    const newer = (await repository.snapshot(session.handle, project, 3))!;
    const another = await repository.create(createProject('另一个工程'));
    const other = (await repository.snapshot(another.handle, another.project, 1))!;
    await repository.save(session.handle, older, path.join(root, '正式', '工程.rcproj'), 2);
    expect((await repository.listRecoveries()).entries.map((e) => e.token).sort()).toEqual(
      [newer.token, other.token].sort(),
    );
  });
  it('serializes a save with a newer queued snapshot and rejects late obsolete writes', async () => {
    const { project, session } = await setup();
    const saved = structuredClone(project);
    project.name = '保存中出现的新修改';
    await Promise.all([
      repository.save(session.handle, saved, path.join(root, '正式', '工程.rcproj'), 2),
      repository.snapshot(session.handle, project, 3),
    ]);
    expect(await repository.snapshot(session.handle, saved, 2)).toBeNull();
    const [entry] = (await repository.listRecoveries()).entries;
    expect(entry.name).toBe(project.name);
    await repository.discardSessionRecovery(session.handle, 2);
    expect((await repository.listRecoveries()).entries).toEqual([entry]);
  });
  it('waits for pending snapshots before closing and never resurrects explicitly discarded versions', async () => {
    const { project, session } = await setup();
    const [entry] = await Promise.all([
      repository.snapshot(session.handle, project, 4),
      repository.close(session.handle),
    ]);
    expect((await repository.listRecoveries()).entries).toEqual([entry]);
    const restored = await repository.restoreRecovery(entry!.id, entry!.token);
    await repository.discardSessionRecovery(restored.handle, 4);
    expect(await repository.snapshot(restored.handle, project, 4)).toBeNull();
    expect((await repository.listRecoveries()).entries).toEqual([]);
  });
  it('refuses stale recovery selection and keeps live restored assets after snapshot discard', async () => {
    const { project, session, music, bytes } = await setup();
    const first = (await repository.snapshot(session.handle, project, 1))!;
    project.name = '第二份';
    const second = (await repository.snapshot(session.handle, project, 2))!;
    await repository.close(session.handle);
    await expect(repository.discardRecovery(first.id, first.token)).rejects.toThrow(/更新/);
    const restored = await repository.restoreRecovery(second.id, second.token);
    await repository.discardSessionRecovery(restored.handle, 2);
    expect(Buffer.from(await repository.readAsset(restored.handle, music.id))).toEqual(bytes);
  });
  it('failed official save keeps recovery and permits retry', async () => {
    const { project, session } = await setup();
    const entry = (await repository.snapshot(session.handle, project, 1))!;
    const blocked = path.join(root, 'blocked');
    await fs.writeFile(blocked, 'not a directory');
    await expect(
      repository.save(session.handle, project, path.join(blocked, '工程.rcproj'), 1),
    ).rejects.toThrow();
    expect((await repository.listRecoveries()).entries).toEqual([entry]);
    await repository.save(session.handle, project, path.join(root, 'ok', '工程.rcproj'), 1);
    expect((await repository.listRecoveries()).entries).toEqual([]);
  });
  it('cleans only abandoned staging directories and keeps recovery and active sessions', async () => {
    const { project, session } = await setup();
    const entry = (await repository.snapshot(session.handle, project, 1))!;
    const abandoned = path.join(root, 'sessions', randomUUID());
    await fs.mkdir(abandoned);
    await fs.writeFile(
      path.join(abandoned, '.recovery-session.json'),
      JSON.stringify({ handle: path.basename(abandoned), pid: 2147483647 }),
    );
    const legacy = path.join(root, 'sessions', randomUUID());
    await fs.mkdir(legacy);
    const live = path.join(root, 'sessions', randomUUID());
    await fs.mkdir(live);
    await fs.writeFile(
      path.join(live, '.recovery-session.json'),
      JSON.stringify({ handle: path.basename(live), pid: process.pid }),
    );
    const unrelated = path.join(root, 'sessions', 'keep');
    await fs.mkdir(unrelated);
    await repository.cleanupAbandonedSessions();
    await expect(fs.stat(abandoned)).rejects.toThrow();
    expect(await fs.stat(unrelated)).toBeTruthy();
    expect(await fs.stat(legacy)).toBeTruthy();
    expect(await fs.stat(live)).toBeTruthy();
    expect(await fs.stat(path.join(root, 'sessions', session.handle))).toBeTruthy();
    expect((await repository.listRecoveries()).entries).toEqual([entry]);
  });
});
