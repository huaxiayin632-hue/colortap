import { createReadStream, createWriteStream } from 'node:fs';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { Asset, Project } from '../../shared/models';
import type { ProjectSession } from '../../shared/ipc';
import { isSafeAssetPath, serializeProject, validateProject } from '../../shared/schema';
import type { ImageImport, ImageWorkerRequest } from '../../shared/images';

interface AssetLocation {
  asset: Asset;
  file: string;
  root: string;
  staged: boolean;
}
interface Session {
  handle: string;
  projectId: string;
  filePath: string | null;
  staging: string;
  sources: Map<string, AssetLocation>;
}

export function resolveWithin(root: string, relative: string): string {
  if (!isSafeAssetPath(relative)) throw new Error('素材路径不安全');
  const absolute = path.resolve(root, relative);
  const difference = path.relative(path.resolve(root), absolute);
  if (difference.startsWith('..' + path.sep) || difference === '..' || path.isAbsolute(difference))
    throw new Error('素材超出工程目录');
  return absolute;
}

async function checkRealPath(root: string, file: string): Promise<void> {
  const [realRoot, realFile] = await Promise.all([fs.realpath(root), fs.realpath(file)]);
  const relative = path.relative(realRoot, realFile);
  if (relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative))
    throw new Error('素材链接指向工程目录以外的位置');
}

async function hashFile(file: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}

/** Bound filesystem pressure; wait for all in-flight operations before returning a failure. */
export async function eachAsset<T>(
  items: T[],
  operation: (item: T, index: number) => Promise<void>,
): Promise<void> {
  let cursor = 0,
    failed = false;
  const results = await Promise.allSettled(
    Array.from({ length: Math.min(8, items.length) }, async () => {
      while (!failed) {
        const index = cursor++;
        if (index >= items.length) return;
        try {
          await operation(items[index], index);
        } catch (error) {
          failed = true;
          throw error;
        }
      }
    }),
  );
  const failure = results.find((result) => result.status === 'rejected');
  if (failure?.status === 'rejected') throw failure.reason;
}

export async function atomicWrite(file: string, text: string, backup = true): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temporary = path.join(path.dirname(file), `.${path.basename(file)}.${randomUUID()}.tmp`);
  try {
    const handle = await fs.open(temporary, 'wx');
    try {
      await handle.writeFile(text, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    if (backup) {
      try {
        await atomicWrite(file + '.bak', await fs.readFile(file, 'utf8'), false);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    }
    await fs.rename(temporary, file);
  } finally {
    await fs.unlink(temporary).catch(() => undefined);
  }
}

export class ProjectRepository {
  private readonly sessions = new Map<string, Session>();
  private resolvedSessionRoot: string | null = null;
  constructor(private readonly sessionRoot: string) {}
  private get(handle: string): Session {
    const session = this.sessions.get(handle);
    if (!session) throw new Error('工程会话已关闭，请重新打开工程');
    return session;
  }
  private async session(project: Project, filePath: string | null): Promise<Session> {
    const handle = randomUUID();
    const requested = path.resolve(this.resolvedSessionRoot ?? this.sessionRoot, handle);
    await fs.mkdir(requested, { recursive: true });
    // Windows packaged launchers may virtualize Roaming children while leaving their parent
    // alias unchanged. Resolve the directory we just created, then keep all session I/O and
    // ownership checks under its actual parent. Asset containment checks remain unchanged.
    const staging = await fs.realpath(requested),
      actualRoot = path.dirname(staging);
    if (
      path.basename(staging) !== handle ||
      (this.resolvedSessionRoot && path.relative(this.resolvedSessionRoot, actualRoot) !== '')
    )
      throw new Error('临时目录实际路径校验失败');
    this.resolvedSessionRoot = actualRoot;
    const session: Session = {
      handle,
      projectId: project.id,
      filePath,
      staging,
      sources: new Map(),
    };
    if (filePath) {
      const root = path.dirname(filePath);
      for (const asset of Object.values(project.assets))
        session.sources.set(asset.id, {
          asset,
          file: resolveWithin(root, asset.relativePath),
          root,
          staged: false,
        });
    }
    this.sessions.set(handle, session);
    return session;
  }
  async create(input: unknown): Promise<ProjectSession> {
    const project = validateProject(input);
    if (Object.keys(project.assets).length) throw new Error('新工程不能引用未经导入的本地素材');
    const session = await this.session(project, null);
    return { handle: session.handle, project, filePath: null, warnings: [] };
  }
  async open(file: string): Promise<ProjectSession> {
    const project = validateProject(JSON.parse(await fs.readFile(file, 'utf8')));
    const session = await this.session(project, path.resolve(file));
    const warnings: string[] = [];
    await eachAsset([...session.sources.values()], async (source, index) => {
      try {
        await checkRealPath(source.root, source.file);
      } catch {
        warnings[index] = `素材缺失或无法访问：${source.asset.originalName}`;
      }
    });
    return {
      handle: session.handle,
      project,
      filePath: session.filePath,
      warnings: warnings.filter(Boolean),
    };
  }
  async importAudio(handle: string, sourceFile: string): Promise<Asset> {
    const session = this.get(handle);
    const extension = path.extname(sourceFile).toLowerCase();
    if (!['.wav', '.mp3', '.ogg', '.flac', '.m4a', '.aac', '.opus', '.webm'].includes(extension))
      throw new Error('请选择 WAV、MP3、OGG 或兼容的音频文件');
    const id = randomUUID();
    const relativePath = `assets/audio/${id}${extension}`;
    const target = resolveWithin(session.staging, relativePath);
    await fs.mkdir(path.dirname(target), { recursive: true });
    const hash = createHash('sha256');
    let byteLength = 0;
    try {
      await pipeline(
        createReadStream(sourceFile),
        new Transform({
          transform(chunk: Buffer, _encoding, callback) {
            hash.update(chunk);
            byteLength += chunk.length;
            callback(null, chunk);
          },
        }),
        createWriteStream(target, { flags: 'wx' }),
      );
      if (byteLength === 0) throw new Error('音乐文件为空');
      const asset: Asset = {
        id,
        kind: 'audio',
        relativePath,
        originalName: path.basename(sourceFile),
        sha256: hash.digest('hex'),
        byteLength,
      };
      session.sources.set(id, { asset, file: target, root: session.staging, staged: true });
      return asset;
    } catch (error) {
      await fs.unlink(target).catch(() => undefined);
      throw error;
    }
  }
  async readAsset(handle: string, assetId: string): Promise<ArrayBuffer> {
    const source = this.get(handle).sources.get(assetId);
    if (!source) throw new Error('当前工程没有该素材');
    try {
      await checkRealPath(source.root, source.file);
      const bytes = await fs.readFile(source.file);
      if (
        bytes.byteLength !== source.asset.byteLength ||
        createHash('sha256').update(bytes).digest('hex') !== source.asset.sha256
      ) {
        throw new Error('素材内容已改变，请重新导入');
      }
      return Uint8Array.from(bytes).buffer;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT')
        throw new Error(
          `找不到素材文件「${source.asset.originalName}」，请重新导入或恢复 assets 文件夹`,
        );
      throw error;
    }
  }
  async importImage(
    handle: string,
    sourceFile: string,
    tileSize: number,
    execute: (request: ImageWorkerRequest) => Promise<ImageImport>,
  ): Promise<ImageImport> {
    const session = this.get(handle),
      importId = randomUUID();
    const folder = resolveWithin(session.staging, `assets/images/${importId}`);
    try {
      const result = await execute({
        sourceFile,
        stagingRoot: session.staging,
        importId,
        tileSize,
      });
      if (result.id !== importId) throw new Error('导入批次不匹配');
      for (const asset of Object.values(result.assets)) {
        if (!asset.relativePath.startsWith(`assets/images/${importId}/`))
          throw new Error('导入素材路径无效');
        const file = resolveWithin(session.staging, asset.relativePath);
        await checkRealPath(session.staging, file);
        session.sources.set(asset.id, { asset, file, root: session.staging, staged: true });
      }
      return result;
    } catch (error) {
      for (const [id, source] of session.sources)
        if (source.file.startsWith(folder + path.sep)) session.sources.delete(id);
      // Only this UUID batch under this session can be removed on failure/cancellation.
      if (
        path.dirname(folder) !== path.resolve(session.staging, 'assets/images') ||
        path.basename(folder) !== importId
      )
        throw new Error('导入清理目录校验失败');
      try {
        await checkRealPath(session.staging, folder);
        await fs.rm(folder, { recursive: true, force: true });
      } catch (cleanupError) {
        if ((cleanupError as NodeJS.ErrnoException).code !== 'ENOENT') throw cleanupError;
      }
      throw error;
    }
  }
  async discardImport(handle: string, assetId: string): Promise<void> {
    const session = this.get(handle);
    const source = session.sources.get(assetId);
    if (!source?.staged) return;
    await checkRealPath(session.staging, source.file);
    await fs.unlink(source.file);
    session.sources.delete(assetId);
  }
  async save(
    handle: string,
    input: unknown,
    file: string,
  ): Promise<{ filePath: string; savedRevision: number }> {
    const session = this.get(handle);
    const project = validateProject(input);
    if (project.id !== session.projectId) throw new Error('工程会话与文档不匹配');
    if (path.extname(file).toLowerCase() !== '.rcproj')
      throw new Error('请使用 .rcproj 扩展名保存工程');
    const target = path.resolve(file);
    const root = path.dirname(target);
    await fs.mkdir(root, { recursive: true });
    const nextSources = new Map<string, AssetLocation>();
    await eachAsset(Object.values(project.assets), async (asset) => {
      const source = session.sources.get(asset.id);
      if (
        !source ||
        source.asset.relativePath !== asset.relativePath ||
        source.asset.sha256 !== asset.sha256 ||
        source.asset.byteLength !== asset.byteLength
      ) {
        throw new Error(`素材未通过导入授权：${asset.originalName}`);
      }
      await checkRealPath(source.root, source.file);
      if ((await hashFile(source.file)) !== asset.sha256)
        throw new Error(`素材内容已改变：${asset.originalName}`);
      const destination = resolveWithin(root, asset.relativePath);
      await fs.mkdir(path.dirname(destination), { recursive: true });
      await checkRealPath(root, path.dirname(destination));
      if (path.resolve(source.file) !== destination) {
        let exists = false;
        try {
          await fs.access(destination);
          exists = true;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        }
        if (exists) {
          await checkRealPath(root, destination);
          if ((await hashFile(destination)) !== asset.sha256)
            throw new Error(`目标文件夹中存在不同内容的同名素材：${asset.originalName}`);
        } else {
          const temp = destination + '.' + randomUUID() + '.tmp';
          try {
            await fs.copyFile(source.file, temp);
            await fs.rename(temp, destination);
          } finally {
            await fs.unlink(temp).catch(() => undefined);
          }
        }
      }
      nextSources.set(asset.id, { asset, file: destination, root, staged: false });
    });
    // Commit the manifest only after every asset is present. Failed saves retain the last valid manifest.
    await atomicWrite(target, serializeProject(project));
    session.filePath = target;
    for (const [id, source] of nextSources) session.sources.set(id, source);
    return { filePath: target, savedRevision: project.revision };
  }
  filePath(handle: string): string | null {
    return this.get(handle).filePath;
  }
  async close(handle: string): Promise<void> {
    const session = this.sessions.get(handle);
    if (!session) return;
    const root = this.resolvedSessionRoot ?? path.resolve(this.sessionRoot);
    const target = path.resolve(session.staging);
    if (path.dirname(target) !== root || path.basename(target) !== handle)
      throw new Error('临时目录校验失败');
    await checkRealPath(root, target);
    await fs.rm(target, { recursive: true, force: true });
    this.sessions.delete(handle);
  }
  async closeAll(): Promise<void> {
    for (const handle of this.sessions.keys()) await this.close(handle);
  }
}
