import { afterEach, describe, expect, it, vi } from 'vitest';
import { createEditor, type Editor } from '../src/renderer/state/editor';
import type { DesktopAPI, ProjectSession, Result } from '../src/shared/ipc';

let editor: Editor;
afterEach(async () => {
  await editor?.dispose();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
async function setup(failed = false) {
  vi.useFakeTimers();
  vi.stubGlobal('requestAnimationFrame', () => 0);
  vi.stubGlobal('cancelAnimationFrame', vi.fn());
  let close!: () => void;
  const handle = crypto.randomUUID();
  const desktop = {
    newProject: vi.fn<DesktopAPI['newProject']>(async (project): Promise<Result<ProjectSession>> =>
      failed
        ? { ok: false, error: 'ENOSPC' }
        : { ok: true, value: { handle, project, filePath: null, warnings: [] } },
    ),
    activateSession: vi.fn<DesktopAPI['activateSession']>(async () => ({
      ok: true,
      value: undefined,
    })),
    closeSession: vi.fn<DesktopAPI['closeSession']>(async () => ({ ok: true, value: undefined })),
    setDirty: vi.fn<DesktopAPI['setDirty']>(async () => ({ ok: true, value: undefined })),
    onImageProgress: () => () => {},
    onCloseRequested: (listener) => {
      close = listener;
      return () => {};
    },
    listRecoveries: async () => ({ ok: true, value: { entries: [], warnings: [] } }),
    snapshot: vi.fn<DesktopAPI['snapshot']>(async (request) => ({
      ok: true,
      value: {
        id: request.handle,
        token: crypto.randomUUID(),
        name: request.project.name,
        filePath: null,
        savedAt: new Date().toISOString(),
        version: request.version,
      },
    })),
    discardSessionRecovery: vi.fn<DesktopAPI['discardSessionRecovery']>(async () => ({
      ok: true,
      value: undefined,
    })),
    finishClose: vi.fn<DesktopAPI['finishClose']>(async () => ({ ok: true, value: undefined })),
    saveProject: vi.fn<DesktopAPI['saveProject']>(async () => ({ ok: true, value: null })),
    processSample: async () => ({
      ok: true,
      value: { sampledAt: new Date().toISOString(), processes: [] },
    }),
  } satisfies Partial<DesktopAPI>;
  vi.stubGlobal('window', { desktop });
  editor = createEditor();
  await editor.initialize();
  return { desktop, handle, close: () => close() };
}

describe('editor recovery and exit transitions', () => {
  it('updates existing recovery after undo returns to a formally saved state', async () => {
    const { desktop } = await setup();
    const initial = editor.project.value.name;
    editor.edit({ type: 'rename', name: '撤销前' });
    await vi.advanceTimersByTimeAsync(15000);
    await editor.undo();
    expect(editor.dirty.value).toBe(false);
    await vi.advanceTimersByTimeAsync(15000);
    expect(desktop.snapshot).toHaveBeenCalledTimes(2);
    expect(desktop.snapshot.mock.calls[1][0]).toMatchObject({
      version: 2,
      project: { name: initial },
    });
  });
  it('skips gesture previews, preserves normal edits and writes once after gesture commit', async () => {
    const { desktop } = await setup();
    editor.edit({ type: 'rename', name: '已提交' });
    editor.beginGesture();
    editor.edit({ type: 'set-bpm', bpm: 150 });
    await vi.advanceTimersByTimeAsync(15000);
    expect(desktop.snapshot).not.toHaveBeenCalled();
    editor.endGesture(true);
    await vi.advanceTimersByTimeAsync(15000);
    expect(desktop.snapshot.mock.calls[0][0].project.timing.points[0].bpm).toBe(150);
    await vi.advanceTimersByTimeAsync(15000);
    expect(desktop.snapshot).toHaveBeenCalledTimes(1);
  });
  it('keeps the last timestamp and surfaces failure while allowing later retry', async () => {
    const { desktop } = await setup();
    editor.edit({ type: 'rename', name: '完整' });
    await vi.advanceTimersByTimeAsync(15000);
    const timestamp = editor.recoveryTime.value;
    editor.edit({ type: 'rename', name: '重试' });
    desktop.snapshot.mockRejectedValueOnce(Error('disk full'));
    await vi.advanceTimersByTimeAsync(15000);
    expect(editor.recoveryTime.value).toBe(timestamp);
    expect(editor.recoveryError.value).toContain('disk full');
    await vi.advanceTimersByTimeAsync(15000);
    expect(editor.recoveryError.value).toBe('');
    expect(editor.recoveryTime.value).not.toBe(timestamp);
  });
  it('allows a window with failed initial session creation to close', async () => {
    const { desktop, close } = await setup(true);
    close();
    await vi.advanceTimersByTimeAsync(0);
    expect(desktop.finishClose).toHaveBeenCalledWith({ handle: null, version: 0 });
  });
  it('allows explicit discard after editing without a successfully created session', async () => {
    const { desktop, close } = await setup(true);
    editor.edit({ type: 'set-bpm', bpm: 180 });
    close();
    editor.confirmReplacement.value!('discard');
    await vi.advanceTimersByTimeAsync(0);
    expect(desktop.finishClose).toHaveBeenCalledWith({ handle: null, version: 0 });
  });
  it.each(['cancel', 'save'] as const)(
    'keeps dirty content and recovery when exit choice is %s and save path cancels',
    async (choice) => {
      const { desktop, close } = await setup();
      editor.edit({ type: 'rename', name: '保留编辑内容' });
      await vi.advanceTimersByTimeAsync(15000);
      close();
      editor.confirmReplacement.value!(choice);
      await vi.advanceTimersByTimeAsync(0);
      expect(editor.dirty.value).toBe(true);
      expect(editor.project.value.name).toBe('保留编辑内容');
      expect(desktop.finishClose).not.toHaveBeenCalled();
      expect(desktop.discardSessionRecovery).not.toHaveBeenCalled();
    },
  );
  it('a failed replacement leaves the old session active and recoverable', async () => {
    const { desktop, handle } = await setup();
    editor.edit({ type: 'rename', name: '当前工程' });
    await vi.advanceTimersByTimeAsync(15000);
    desktop.newProject.mockResolvedValueOnce({ ok: false, error: 'ENOSPC' });
    const replacing = editor.newDocument('无法建立', { width: 100, height: 100 });
    editor.confirmReplacement.value!('discard');
    expect(await replacing).toBe(false);
    expect(editor.session.value?.handle).toBe(handle);
    expect(desktop.discardSessionRecovery).not.toHaveBeenCalled();
    expect(editor.recoveryTime.value).toBeTruthy();
  });
});
