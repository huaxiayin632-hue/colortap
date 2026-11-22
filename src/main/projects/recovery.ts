import { promises as fs } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { RecoveryEntry, RecoveryList } from '../../shared/ipc';
import { atomicWrite, checkRealPath, eachAsset, hashFile, resolveWithin } from './file-io';
import { validateProject } from '../../shared/schema';

const entrySchema = z
  .object({
    id: z.uuid(),
    token: z.uuid(),
    name: z.string(),
    filePath: z.string().nullable(),
    savedAt: z.iso.datetime(),
    version: z.number().int().nonnegative(),
    sharedAssets: z.literal(true).optional(),
  })
  .strict();

/** Immutable manifests share independent, verified recovery assets. The pointer commits last. */
export class RecoveryStore {
  constructor(private readonly root: string) {}

  private folder(id: string): string {
    return path.join(this.root, z.uuid().parse(id));
  }

  private async current(id: string): Promise<RecoveryEntry | null> {
    try {
      const folder = this.folder(id),
        file = path.join(folder, 'current.json');
      await checkRealPath(this.root, file);
      const entry = entrySchema.parse(JSON.parse(await fs.readFile(file, 'utf8')));
      if (entry.id !== id) throw Error('恢复记录与目录不匹配');
      return entry;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
  }

  async load(id: string, token: string) {
    const entry = await this.current(id);
    if (!entry || entry.token !== token) throw Error('恢复快照已更新，请重新查看恢复列表');
    const file = entry.sharedAssets
      ? path.join(this.folder(id), entry.token + '.rcproj')
      : path.join(this.folder(id), entry.token, 'project.rcproj');
    await checkRealPath(this.root, file);
    const project = validateProject(JSON.parse(await fs.readFile(file, 'utf8')));
    await eachAsset(Object.values(project.assets), async (asset) => {
      const source = resolveWithin(path.dirname(file), asset.relativePath);
      await checkRealPath(this.root, source);
      if (
        (await fs.stat(source)).size !== asset.byteLength ||
        (await hashFile(source)) !== asset.sha256
      )
        throw Error(`恢复素材损坏：${asset.originalName}`);
    });
    return { entry, project, file };
  }

  async list(): Promise<RecoveryList> {
    await fs.mkdir(this.root, { recursive: true });
    const entries: RecoveryEntry[] = [],
      warnings: string[] = [];
    for (const folder of await fs.readdir(this.root, { withFileTypes: true })) {
      if (!folder.isDirectory() || !z.uuid().safeParse(folder.name).success) continue;
      try {
        const entry = await this.current(folder.name);
        if (entry) {
          await this.load(entry.id, entry.token);
          entries.push(entry);
        }
        await this.prune(folder.name, entry?.token ?? null).catch(() => undefined);
      } catch {
        warnings.push(`有一份恢复快照无法完整读取，已保留原数据（${folder.name}）`);
      }
    }
    entries.sort((a, b) => b.savedAt.localeCompare(a.savedAt));
    return { entries, warnings };
  }

  async write(
    info: Omit<RecoveryEntry, 'token' | 'savedAt'>,
    writeProject: (file: string) => Promise<void>,
  ): Promise<RecoveryEntry> {
    const folder = this.folder(info.id),
      token = randomUUID();
    const pending = path.join(folder, `.pending-${token}.rcproj`),
      complete = path.join(folder, token + '.rcproj');
    const entry = entrySchema.parse({
      ...info,
      token,
      savedAt: new Date().toISOString(),
      sharedAssets: true,
    });
    await fs.mkdir(folder, { recursive: true });
    await checkRealPath(this.root, folder);
    try {
      await writeProject(pending);
      await fs.rename(pending, complete);
      await atomicWrite(path.join(folder, 'current.json'), JSON.stringify(entry), false);
    } finally {
      await fs.unlink(pending).catch(() => undefined);
    }
    // Old generations are unreferenced now. A cleanup failure must not hide a valid snapshot.
    await this.prune(info.id, token).catch(() => undefined);
    return entry;
  }

  async discard(id: string, token: string): Promise<void> {
    const current = await this.current(id);
    if (!current) return;
    if (current.token !== token) throw Error('恢复快照已更新，未删除新的内容');
    // Remove the pointer first. An interrupted cleanup can only leave unreferenced files.
    await fs.unlink(path.join(this.folder(id), 'current.json'));
    await this.prune(id, null).catch(() => undefined);
  }

  async discardThrough(id: string, version: number): Promise<void> {
    const current = await this.current(id);
    if (current && current.version <= version) await this.discard(id, current.token);
  }

  private async prune(id: string, keep: string | null): Promise<void> {
    const folder = this.folder(id);
    await checkRealPath(this.root, folder);
    const current = keep ? await this.current(id) : null;
    let referenced = new Set<string>();
    if (current?.sharedAssets) {
      const file = path.join(folder, current.token + '.rcproj');
      await checkRealPath(folder, file);
      const project = validateProject(JSON.parse(await fs.readFile(file, 'utf8')));
      referenced = new Set(
        Object.values(project.assets).map((asset) => resolveWithin(folder, asset.relativePath)),
      );
    }
    for (const item of await fs.readdir(folder, { withFileTypes: true })) {
      const manifest = /^(?:\.pending-)?([\da-f-]+)\.rcproj$/.exec(item.name);
      if (item.isFile() && manifest && z.uuid().safeParse(manifest[1]).success) {
        if (item.name !== keep + '.rcproj') {
          const target = path.join(folder, item.name);
          await checkRealPath(folder, target);
          await fs.unlink(target);
        }
        continue;
      }
      if (item.name === 'assets' && item.isDirectory()) {
        const clean = async (directory: string): Promise<void> => {
          await checkRealPath(folder, directory);
          for (const child of await fs.readdir(directory, { withFileTypes: true })) {
            const target = path.join(directory, child.name);
            if (referenced.has(target) && child.isFile()) continue;
            await checkRealPath(folder, target);
            if (child.isDirectory()) await clean(target);
            else if (!referenced.has(target)) await fs.unlink(target);
          }
          await fs.rmdir(directory).catch(() => undefined);
        };
        await clean(path.join(folder, item.name));
        continue;
      }
      const temporaryPointer = /^\.current\.json\.(.+)\.tmp$/.exec(item.name);
      const temporaryManifest = /^\.(?:\.pending-)?([\da-f-]+)\.rcproj\.([\da-f-]+)\.tmp$/.exec(
        item.name,
      );
      if (
        item.isFile() &&
        ((temporaryPointer && z.uuid().safeParse(temporaryPointer[1]).success) ||
          (temporaryManifest &&
            temporaryManifest.slice(1).every((part) => z.uuid().safeParse(part).success)))
      ) {
        const target = path.join(folder, item.name);
        await checkRealPath(folder, target);
        await fs.unlink(target);
        continue;
      }
      const uuid = item.name.replace(/^\.pending-/, '');
      if (!item.isDirectory() || item.name === keep || !z.uuid().safeParse(uuid).success) continue;
      const target = path.join(folder, item.name);
      await checkRealPath(folder, target);
      await fs.rm(target, { recursive: true, force: true });
    }
    if (!keep) await fs.rmdir(folder).catch(() => undefined);
  }
}
