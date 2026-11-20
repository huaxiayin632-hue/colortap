import { createReadStream, createWriteStream } from 'node:fs';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { Asset, Project } from '../../shared/models';
import type { ProjectSession, RecoveryEntry, SaveResult } from '../../shared/ipc';
import { RecoveryStore } from './recovery';
import { z } from 'zod';
import { atomicWrite, checkRealPath, eachAsset, hashFile, resolveWithin } from './file-io';
export { atomicWrite, eachAsset, resolveWithin } from './file-io';
import { serializeProject, validateProject } from '../../shared/schema';
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
  recoveryId: string;
  settledVersion: number;
  snapshotVersion: number;
}

export class ProjectRepository {
  private readonly sessions = new Map<string, Session>();
  private resolvedSessionRoot: string | null = null;
  private pending: Promise<unknown> = Promise.resolve();
  private readonly recovery: RecoveryStore;
  constructor(
    private readonly sessionRoot: string,
    recoveryRoot = path.join(path.dirname(sessionRoot), 'recoveries'),
  ) {
    this.recovery = new RecoveryStore(recoveryRoot);
  }
  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.pending.then(operation);
    this.pending = next.catch(() => undefined);
    return next;
  }
  create(input: unknown) {
    return this.enqueue(() => this.createNow(input));
  }
  open(file: string) {
    return this.enqueue(() => this.openNow(file));
  }
  importAudio(handle: string, sourceFile: string) {
    return this.enqueue(() => this.importAudioNow(handle, sourceFile));
  }
  importImage(
    handle: string,
    sourceFile: string,
    tileSize: number,
    execute: (request: ImageWorkerRequest) => Promise<ImageImport>,
  ) {
    return this.enqueue(() => this.importImageNow(handle, sourceFile, tileSize, execute));
  }
  discardImport(handle: string, assetId: string) {
    return this.enqueue(() => this.discardImportNow(handle, assetId));
  }
  save(handle: string, input: unknown, file: string, version = 0) {
    return this.enqueue(() => this.saveNow(handle, input, file, version));
  }
  close(handle: string) {
    return this.enqueue(() => this.closeNow(handle));
  }
  closeAll() {
    return this.enqueue(async () => {
      for (const handle of this.sessions.keys()) await this.closeNow(handle);
    });
  }
  listRecoveries() {
    return this.enqueue(() => this.recovery.list());
  }
  cleanupAbandonedSessions() {
    return this.enqueue(async () => {
      await fs.mkdir(this.sessionRoot, { recursive: true });
      const root = await fs.realpath(this.sessionRoot);
      for (const item of await fs.readdir(root, { withFileTypes: true })) {
        if (
          !item.isDirectory() ||
          !z.uuid().safeParse(item.name).success ||
          this.sessions.has(item.name)
        )
          continue;
        const target = path.join(root, item.name);
        await checkRealPath(root, target);
        // Older editors did not acquire the profile lock. Never clean their unmarked
        // directories, or a marked session whose owner is still alive.
        try {
          const marker = path.join(target, '.recovery-session.json');
          await checkRealPath(target, marker);
          const owner = z
            .object({ handle: z.uuid(), pid: z.number().int().positive() })
            .strict()
            .parse(JSON.parse(await fs.readFile(marker, 'utf8')));
          if (owner.handle !== item.name) continue;
          try {
            process.kill(owner.pid, 0);
            continue;
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ESRCH') continue;
          }
        } catch {
          continue;
        }
        await fs.rm(target, { recursive: true, force: true });
      }
    });
  }
  snapshot(handle: string, input: unknown, version: number): Promise<RecoveryEntry | null> {
    return this.enqueue(async () => {
      const session = this.get(handle);
      if (version <= session.settledVersion || version <= session.snapshotVersion) return null;
      const project = validateProject(input);
      const entry = await this.recovery.write(
        {
          id: session.recoveryId,
          name: project.name,
          filePath: session.filePath,
          version,
        },
        async (file) => {
          await this.writeProject(session, project, file);
        },
      );
      session.snapshotVersion = version;
      return entry;
    });
  }
  restoreRecovery(id: string, token: string): Promise<ProjectSession> {
    return this.enqueue(async () => {
      if ([...this.sessions.values()].some((session) => session.recoveryId === id))
        throw Error('该恢复工程已在当前窗口打开');
      const { entry, project, file } = await this.recovery.load(id, token);
      const session = await this.session(project, file);
      try {
        // The restored editor owns a fresh copy, so discarding an old snapshot cannot
        // invalidate live reads, undo, or a subsequent formal save.
        const sources = await this.writeProject(
          session,
          project,
          path.join(session.staging, 'project.rcproj'),
        );
        session.sources = sources;
        session.filePath = entry.filePath;
        session.recoveryId = id;
        session.snapshotVersion = entry.version;
        return {
          handle: session.handle,
          project,
          filePath: entry.filePath,
          warnings: [],
          recovery: entry,
        };
      } catch (error) {
        await this.closeNow(session.handle);
        throw error;
      }
    });
  }
  discardRecovery(id: string, token: string): Promise<void> {
    return this.enqueue(async () => {
      if ([...this.sessions.values()].some((session) => session.recoveryId === id))
        throw Error('请在当前工程中保存或放弃修改');
      await this.recovery.discard(id, token);
    });
  }
  discardSessionRecovery(handle: string, version: number): Promise<void> {
    return this.enqueue(async () => {
      const session = this.get(handle);
      await this.recovery.discardThrough(session.recoveryId, version);
      session.settledVersion = Math.max(session.settledVersion, version);
    });
  }

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
    await atomicWrite(
      path.join(staging, '.recovery-session.json'),
      JSON.stringify({ handle, pid: process.pid }),
      false,
    );
    const session: Session = {
      handle,
      projectId: project.id,
      filePath,
      staging,
      sources: new Map(),
      recoveryId: handle,
      settledVersion: -1,
      snapshotVersion: -1,
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
  private async createNow(input: unknown): Promise<ProjectSession> {
    const project = validateProject(input);
    if (Object.keys(project.assets).length) throw new Error('新工程不能引用未经导入的本地素材');
    const session = await this.session(project, null);
    return { handle: session.handle, project, filePath: null, warnings: [] };
  }
  private async openNow(file: string): Promise<ProjectSession> {
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
  private async importAudioNow(handle: string, sourceFile: string): Promise<Asset> {
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
  private async importImageNow(
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
  private async discardImportNow(handle: string, assetId: string): Promise<void> {
    const session = this.get(handle);
    const source = session.sources.get(assetId);
    if (!source?.staged) return;
    await checkRealPath(session.staging, source.file);
    await fs.unlink(source.file);
    session.sources.delete(assetId);
  }
  private async saveNow(
    handle: string,
    input: unknown,
    file: string,
    version: number,
  ): Promise<SaveResult> {
    const session = this.get(handle),
      project = validateProject(input);
    if (project.id !== session.projectId) throw new Error('工程会话与文档不匹配');
    if (path.extname(file).toLowerCase() !== '.rcproj')
      throw new Error('请使用 .rcproj 扩展名保存工程');
    const target = path.resolve(file);
    const nextSources = await this.writeProject(session, project, target, true);
    session.filePath = target;
    for (const [id, source] of nextSources) session.sources.set(id, source);
    session.settledVersion = Math.max(session.settledVersion, version);
    let warning: string | undefined;
    try {
      await this.recovery.discardThrough(session.recoveryId, version);
    } catch {
      warning = '工程已保存，但旧恢复快照未能清理；原恢复数据已保留';
    }
    return { filePath: target, savedRevision: project.revision, warning };
  }
  private async writeProject(session: Session, project: Project, target: string, backup = false) {
    if (project.id !== session.projectId) throw new Error('工程会话与文档不匹配');
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
            if (
              (await fs.stat(temp)).size !== asset.byteLength ||
              (await hashFile(temp)) !== asset.sha256
            )
              throw new Error(`素材复制校验失败：${asset.originalName}`);
            const copied = await fs.open(temp, 'r+');
            try {
              await copied.sync();
            } finally {
              await copied.close();
            }
            await fs.rename(temp, destination);
          } finally {
            await fs.unlink(temp).catch(() => undefined);
          }
        }
      }
      nextSources.set(asset.id, { asset, file: destination, root, staged: false });
    });
    // Commit the manifest only after every asset is present. Failed saves retain the last valid manifest.
    await atomicWrite(target, serializeProject(project), backup);
    return nextSources;
  }
  filePath(handle: string): string | null {
    return this.get(handle).filePath;
  }
  private async closeNow(handle: string): Promise<void> {
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
}
