import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  net,
  protocol,
  session,
  utilityProcess,
} from 'electron';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import { z } from 'zod';
import { channels, type Result } from '../shared/ipc';
import { projectSchema } from '../shared/schema';
import { atomicWrite, ProjectRepository } from './projects/repository';
import type { ImageImport, ImageWorkerRequest } from '../shared/images';

const currentDir = path.dirname(fileURLToPath(import.meta.url));
const rendererRoot = path.resolve(currentDir, '../renderer');
const devUrl = process.env.ELECTRON_RENDERER_URL;
const isDev = !app.isPackaged && Boolean(devUrl);
if (process.env.RHYTHM_USER_DATA && !app.isPackaged)
  app.setPath('userData', path.resolve(process.env.RHYTHM_USER_DATA));
protocol.registerSchemesAsPrivileged([
  {
    scheme: 'rhythm',
    privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true },
  },
]);

let window: BrowserWindow | null = null;
let repository: ProjectRepository;
let dirty = false;
let closing = false;
let activeHandle: string | null = null;
let cancelImport: (() => void) | null = null;
let importJob: Promise<ImageImport> | null = null;

function runImageWorker(request: ImageWorkerRequest, projectHandle: string): Promise<ImageImport> {
  if (cancelImport) throw new Error('已有导入任务正在运行');
  return new Promise((resolve, reject) => {
    const worker = utilityProcess.fork(path.join(currentDir, 'image-worker.js'), [], {
      serviceName: 'Rhythm PSD Import',
      stdio: 'pipe',
    });
    let settled = false,
      stderr = '';
    let outcome: { value?: ImageImport; error?: string } | null = null;
    const finish = (value?: ImageImport, error?: string) => {
      if (settled || outcome) return;
      outcome = { value, error };
      worker.kill();
    };
    cancelImport = () => finish(undefined, '已取消图片导入，原工程未改变');
    worker.stderr?.on('data', (chunk: Buffer) => {
      stderr = (stderr + chunk.toString()).slice(-2000);
    });
    worker.on('message', (message) => {
      if (message.type === 'progress')
        window?.webContents.send(channels.imageProgress, {
          handle: projectHandle,
          phase: message.phase,
          completed: message.completed,
          total: message.total,
        });
      else if (message.type === 'done') finish(message.value);
      else if (message.type === 'error') finish(undefined, message.error);
    });
    worker.once('exit', (code) => {
      if (settled) return;
      settled = true;
      cancelImport = null;
      // Wait for process exit before rollback: on Windows a decoder may still hold its tile file open.
      const result = outcome ?? {
        error: `PSD 后台进程退出（${code}）。${stderr} 可尝试分层 PNG。`,
      };
      if (result.error) reject(new Error(result.error));
      else resolve(result.value!);
    });
    worker.once('spawn', () => {
      if (!outcome) worker.postMessage(request);
    });
  });
}

function trusted(url: string): boolean {
  try {
    return isDev
      ? new URL(url).origin === new URL(devUrl!).origin
      : new URL(url).protocol === 'rhythm:' && new URL(url).host === 'app';
  } catch {
    return false;
  }
}
function message(error: unknown): string {
  if (error instanceof z.ZodError)
    return `数据校验失败：${error.issues[0]?.path.join('.') || '工程'}，${error.issues[0]?.message}`;
  return error instanceof Error ? error.message : '操作失败，请重试';
}
function handle<S extends z.ZodType, T>(
  channel: string,
  schema: S,
  callback: (value: z.output<S>) => Promise<T> | T,
): void {
  ipcMain.handle(channel, async (event, input): Promise<Result<T>> => {
    try {
      if (
        event.sender !== window?.webContents ||
        event.senderFrame !== window.webContents.mainFrame ||
        !trusted(event.senderFrame.url)
      )
        throw new Error('未授权的桌面请求');
      return { ok: true, value: await callback(schema.parse(input)) };
    } catch (error) {
      return { ok: false, error: message(error) };
    }
  });
}

function setupIPC(): void {
  const id = z.uuid();
  handle(channels.cancelImageImport, z.undefined(), () => {
    cancelImport?.();
  });
  handle(
    channels.importImage,
    z.object({ handle: id, tileSize: z.number().int().min(64).max(1024) }).strict(),
    async (request) => {
      const selected = await dialog.showOpenDialog(window!, {
        title: '导入 PSD / PNG 图层',
        properties: ['openFile'],
        filters: [{ name: '插画素材', extensions: ['psd', 'png'] }],
      });
      if (selected.canceled || !selected.filePaths[0]) return null;
      const task = repository.importImage(
        request.handle,
        selected.filePaths[0],
        request.tileSize,
        (input) => runImageWorker(input, request.handle),
      );
      importJob = task;
      try {
        return await task;
      } finally {
        if (importJob === task) importJob = null;
      }
    },
  );
  handle(channels.newProject, projectSchema, async (project) => {
    const result = await repository.create(project);
    activeHandle = result.handle;
    dirty = false;
    return result;
  });
  handle(channels.openProject, z.undefined(), async () => {
    const selected = await dialog.showOpenDialog(window!, {
      title: '打开 Rhythm Canvas 工程',
      filters: [{ name: 'Rhythm Canvas 工程', extensions: ['rcproj'] }],
      properties: ['openFile'],
    });
    if (selected.canceled || !selected.filePaths[0]) return null;
    const result = await repository.open(selected.filePaths[0]);
    activeHandle = result.handle;
    dirty = false;
    return result;
  });
  handle(
    channels.saveProject,
    z.object({ handle: id, project: projectSchema, saveAs: z.boolean() }).strict(),
    async (request) => {
      let file = request.saveAs ? null : repository.filePath(request.handle);
      if (!file) {
        const selected = await dialog.showSaveDialog(window!, {
          title: '保存工程（音乐、原图和分块会保存在旁边的 assets 文件夹）',
          defaultPath: `${request.project.name.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_')}.rcproj`,
          filters: [{ name: 'Rhythm Canvas 工程', extensions: ['rcproj'] }],
        });
        if (selected.canceled || !selected.filePath) return null;
        file = selected.filePath;
      }
      const result = await repository.save(request.handle, request.project, file);
      dirty = false;
      return result;
    },
  );
  handle(channels.importMusic, id, async (projectHandle) => {
    const selected = await dialog.showOpenDialog(window!, {
      title: '导入音乐',
      properties: ['openFile'],
      filters: [
        { name: '音频', extensions: ['wav', 'mp3', 'ogg', 'flac', 'm4a', 'aac', 'opus', 'webm'] },
      ],
    });
    return selected.canceled || !selected.filePaths[0]
      ? null
      : repository.importAudio(projectHandle, selected.filePaths[0]);
  });
  handle(channels.readAsset, z.object({ handle: id, assetId: id }).strict(), (request) =>
    repository.readAsset(request.handle, request.assetId),
  );
  handle(channels.discardImport, z.object({ handle: id, assetId: id }).strict(), (request) =>
    repository.discardImport(request.handle, request.assetId),
  );
  handle(channels.closeSession, id, (projectHandle) => repository.close(projectHandle));
  handle(channels.setDirty, z.object({ handle: id, dirty: z.boolean() }).strict(), (request) => {
    if (request.handle === activeHandle) dirty = request.dirty;
  });
  handle(channels.processSample, z.undefined(), () => ({
    sampledAt: new Date().toISOString(),
    processes: app.getAppMetrics().map((metric) => ({
      pid: metric.pid,
      type: metric.type,
      cpuPercent: metric.cpu.percentCPUUsage,
      workingSetKiB: metric.memory.workingSetSize,
      peakWorkingSetKiB: metric.memory.peakWorkingSetSize,
      privateKiB: metric.memory.privateBytes ?? null,
    })),
  }));
  handle(channels.exportPerformance, z.string(), async (report) => {
    JSON.parse(report);
    const selected = await dialog.showSaveDialog(window!, {
      title: '保存性能记录',
      defaultPath: 'Rhythm-Canvas-性能记录.json',
      filters: [{ name: 'JSON 记录', extensions: ['json'] }],
    });
    if (selected.canceled || !selected.filePath) return null;
    await atomicWrite(selected.filePath, report + '\n', false);
    return selected.filePath;
  });
}

function initializeDesktop(): void {
  app.setAppUserModelId('studio.rhythm-canvas.editor');
  repository = new ProjectRepository(path.join(app.getPath('userData'), 'import-sessions'));
  Menu.setApplicationMenu(null);
  session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) =>
    callback(false),
  );
  session.defaultSession.setPermissionCheckHandler(() => false);

  protocol.handle('rhythm', async (request) => {
    try {
      const url = new URL(request.url);
      if (url.host !== 'app') return new Response('Forbidden', { status: 403 });
      const relative = decodeURIComponent(url.pathname).replace(/^\/+/, '') || 'index.html';
      const file = path.resolve(rendererRoot, relative);
      const difference = path.relative(rendererRoot, file);
      if (difference.startsWith('..') || path.isAbsolute(difference) || relative.includes('\\'))
        return new Response('Forbidden', { status: 403 });
      return await net.fetch(pathToFileURL(file).toString());
    } catch {
      return new Response('Not found', { status: 404 });
    }
  });
}

function createWindow(): void {
  window = new BrowserWindow({
    title: 'Rhythm Canvas',
    width: 1440,
    height: 960,
    minWidth: 1080,
    minHeight: 720,
    backgroundColor: '#26282c',
    show: false,
    webPreferences: {
      preload: path.join(currentDir, '../preload/index.cjs'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webSecurity: true,
    },
  });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', (event, url) => {
    if (!trusted(url)) event.preventDefault();
  });
  window.once('ready-to-show', () => window?.show());
  window.on('close', (event) => {
    if (closing) return;
    event.preventDefault();
    void (async () => {
      if (dirty) {
        const response = await dialog.showMessageBox(window!, {
          type: 'question',
          title: '工程尚未保存',
          message: '工程有未保存的修改',
          detail: '选择“返回保存”后，可在顶部工具栏保存工程。',
          buttons: ['返回保存', '不保存并退出'],
          defaultId: 0,
          cancelId: 0,
        });
        if (response.response !== 1) return;
      }
      closing = true;
      cancelImport?.();
      await importJob?.catch(() => undefined);
      await repository
        .closeAll()
        .catch((error) => console.error('Temporary resource cleanup:', error));
      window?.destroy();
    })();
  });
  window.on('closed', () => {
    window = null;
  });
  if (isDev) void window.loadURL(devUrl!);
  else void window.loadURL('rhythm://app/index.html');
}
// Register readiness without blocking evaluation of the ESM entry module.
void app
  .whenReady()
  .then(() => {
    initializeDesktop();
    setupIPC();
    createWindow();
  })
  .catch((error) => {
    console.error('Rhythm Canvas startup failed:', error);
    dialog.showErrorBox('Rhythm Canvas 无法启动', message(error));
    app.quit();
  });
app.on('window-all-closed', () => app.quit());
