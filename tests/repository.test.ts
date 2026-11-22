import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createProject } from '../src/shared/models';
import { ProjectRepository, resolveWithin, eachAsset } from '../src/main/projects/repository';

let root: string, repository: ProjectRepository;
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'rhythm-canvas-unit-'));
  repository = new ProjectRepository(path.join(root, 'sessions'));
});
afterEach(async () => {
  vi.restoreAllMocks();
  await repository.closeAll();
  const absolute = path.resolve(root);
  if (
    path.dirname(absolute) !== path.resolve(os.tmpdir()) ||
    !path.basename(absolute).startsWith('rhythm-canvas-unit-')
  )
    throw new Error('Invalid test cleanup target');
  await fs.rm(absolute, { recursive: true, force: true });
});

async function withMusic() {
  const project = createProject('工程 中文 空格');
  const session = await repository.create(project);
  const original = path.join(root, '音乐 样本.wav');
  const bytes = Buffer.from('RIFF unit-test file content');
  await fs.writeFile(original, bytes);
  const asset = await repository.importAudio(session.handle, original);
  asset.audio = { durationUs: 12000000, sampleRate: 48000, channels: 2 };
  project.assets[asset.id] = asset;
  project.music = { assetId: asset.id, gain: 0.6 };
  return { project, session, original, asset, bytes };
}

describe('real project filesystem operations', () => {
  it('uses the physical session directory under a Windows app-data alias without weakening asset checks', async () => {
    const physical = path.join(root, 'physical-sessions'),
      alias = path.join(root, 'sessions');
    await fs.mkdir(physical);
    await fs.symlink(physical, alias, process.platform === 'win32' ? 'junction' : 'dir');
    const created = await repository.create(createProject());
    expect(await fs.readdir(physical)).toContain(created.handle);
    await repository.close(created.handle);
    expect(await fs.readdir(physical)).toEqual([]);
  });
  it('bounds concurrent asset I/O and waits for outstanding work before reporting an error', async () => {
    let active = 0,
      peak = 0,
      finished = 0;
    await expect(
      eachAsset(
        Array.from({ length: 40 }, (_, i) => i),
        async (i) => {
          active++;
          peak = Math.max(peak, active);
          try {
            await new Promise((resolve) => setTimeout(resolve, 5));
            if (i === 2) throw new Error('copy failed');
          } finally {
            active--;
            finished++;
          }
        },
      ),
    ).rejects.toThrow('copy failed');
    expect(active).toBe(0);
    expect(peak).toBeLessThanOrEqual(8);
    expect(finished).toBeGreaterThanOrEqual(3);
  });
  it('saves original music bytes, reopens all settings and supports Chinese paths', async () => {
    const { project, session, asset, bytes } = await withMusic();
    const file = path.join(root, '我的工程 目录', 'project.rcproj');
    await repository.save(session.handle, project, file);
    const reopened = await repository.open(file);
    expect(reopened.project).toEqual(project);
    expect(reopened.warnings).toEqual([]);
    expect(Buffer.from(await repository.readAsset(reopened.handle, asset.id))).toEqual(bytes);
    expect(await fs.readFile(resolveWithin(path.dirname(file), asset.relativePath))).toEqual(bytes);
  });
  it('save-as copies referenced assets and the new folder works after its original is removed', async () => {
    const { project, session, asset, original, bytes } = await withMusic();
    const first = path.join(root, 'first', 'project.rcproj'),
      second = path.join(root, 'portable', 'copy.rcproj');
    await repository.save(session.handle, project, first);
    await repository.save(session.handle, project, second);
    await fs.unlink(original);
    await fs.unlink(resolveWithin(path.dirname(first), asset.relativePath));
    const reopened = await repository.open(second);
    expect(Buffer.from(await repository.readAsset(reopened.handle, asset.id))).toEqual(bytes);
  });
  it('failed manifest replacement preserves the last valid document', async () => {
    const { project, session } = await withMusic();
    const file = path.join(root, 'failure', 'project.rcproj');
    await repository.save(session.handle, project, file);
    const before = await fs.readFile(file, 'utf8');
    const rename = fs.rename.bind(fs);
    vi.spyOn(fs, 'rename').mockImplementation(async (from, to) => {
      if (String(to) === file)
        throw Object.assign(new Error('simulated sharing violation'), { code: 'EPERM' });
      return rename(from, to);
    });
    project.name = '未提交的新名称';
    await expect(repository.save(session.handle, project, file)).rejects.toThrow(/sharing/);
    expect(await fs.readFile(file, 'utf8')).toBe(before);
    expect((await fs.readdir(path.dirname(file))).some((name) => name.endsWith('.tmp'))).toBe(
      false,
    );
  });
  it('missing music is reported without dropping its document reference', async () => {
    const { project, session, asset } = await withMusic();
    const file = path.join(root, 'missing', 'project.rcproj');
    await repository.save(session.handle, project, file);
    await fs.unlink(resolveWithin(path.dirname(file), asset.relativePath));
    const reopened = await repository.open(file);
    expect(reopened.warnings).toHaveLength(1);
    expect(reopened.project.music?.assetId).toBe(asset.id);
    await expect(repository.readAsset(reopened.handle, asset.id)).rejects.toThrow(/找不到/);
  });
  it('detects asset tampering and refuses unauthorized asset paths', async () => {
    const { project, session, asset } = await withMusic();
    const file = path.join(root, 'tampered', 'project.rcproj');
    await repository.save(session.handle, project, file);
    await fs.writeFile(resolveWithin(path.dirname(file), asset.relativePath), 'different');
    await expect(repository.readAsset(session.handle, asset.id)).rejects.toThrow(/改变/);
    project.assets[asset.id].relativePath = 'assets/audio/not-authorized.wav';
    await expect(repository.save(session.handle, project, file)).rejects.toThrow(/授权/);
  });
  it.each(['in-place', 'replace', 'delete'])(
    'invalidates a warm digest on external %s, even with restored mtime',
    async (mode) => {
      const { project, session, asset, bytes } = await withMusic();
      const file = path.join(root, 'cached', 'project.rcproj');
      await repository.save(session.handle, project, file);
      await repository.save(session.handle, project, file);
      const target = resolveWithin(path.dirname(file), asset.relativePath);
      const stat = await fs.stat(target);
      const bad = Buffer.alloc(bytes.length, 42);
      if (mode === 'in-place') await fs.writeFile(target, bad);
      if (mode === 'replace') {
        await fs.writeFile(target + '.replacement', bad);
        await fs.rename(target + '.replacement', target);
      }
      if (mode === 'delete') await fs.unlink(target);
      else await fs.utimes(target, stat.atime, stat.mtime);
      await expect(repository.save(session.handle, project, file)).rejects.toThrow();
      await expect(repository.readAsset(session.handle, asset.id)).rejects.toThrow();
      expect((await repository.open(file)).project).toEqual(project);
    },
  );
  it('checks an already verified save-as target again after outside changes', async () => {
    const { project, session, asset, bytes } = await withMusic();
    const first = path.join(root, 'first', 'project.rcproj');
    const second = path.join(root, 'second', 'project.rcproj');
    await repository.save(session.handle, project, first);
    await repository.save(session.handle, project, second);
    await repository.save(session.handle, project, first);
    await fs.writeFile(
      resolveWithin(path.dirname(second), asset.relativePath),
      Buffer.alloc(bytes.length),
    );
    await expect(repository.save(session.handle, project, second)).rejects.toThrow(/同名/);
    expect(repository.filePath(session.handle)).toBe(first);
  });
  it.each([
    '../outside.wav',
    'assets/../outside.wav',
    'C:/outside.wav',
    'assets/a:stream',
    'assets\\file.wav',
    'assets//file.wav',
  ])('rejects unsafe path %s', (value) => {
    expect(() => resolveWithin(root, value)).toThrow();
  });
  it('rejects a junction escaping the saved project directory', async () => {
    const { project, session } = await withMusic();
    const destination = path.join(root, 'junction-project'),
      outside = path.join(root, 'outside-project');
    await fs.mkdir(destination);
    await fs.mkdir(outside);
    await fs.symlink(
      outside,
      path.join(destination, 'assets'),
      process.platform === 'win32' ? 'junction' : 'dir',
    );
    await expect(
      repository.save(session.handle, project, path.join(destination, 'project.rcproj')),
    ).rejects.toThrow(/以外/);
    expect(await fs.stat(path.join(destination, 'project.rcproj')).catch(() => null)).toBeNull();
  });
});
