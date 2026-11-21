import { computed, ref, shallowRef } from 'vue';
import {
  EditHistory,
  type EditCommand,
  type ChartCommand,
  type RevealCommand,
  type ProductionCommand,
} from '../../application/history';
import { FrameRecorder } from '../../core/performance';
import { ResourcePool } from '../../core/resources';
import { PlaybackTake } from '../../core/playback';
import { createProject, type Project, type Size, type Vec2 } from '../../shared/models';
import type { ImageImport, ImageImportProgress } from '../../shared/images';
import { inverse, isLocked, parents, point, worldMatrix } from '../../core/layers';
import {
  unwrap,
  type ProcessSample,
  type ProjectSession,
  type RecoveryEntry,
} from '../../shared/ipc';
import { AudioTransport } from '../audio/transport';
import { SoundEngine } from '../audio/sound-engine';
import { createAudioAnalysis } from '../audio/analysis-controller';
import { defaultMixer } from '../../shared/models';
import { createCamera } from '../camera/controller';
import type { EditorStage } from '../canvas/stage';
import { createChart } from '../chart/controller';
import { createReveals } from '../reveals/controller';
import { validTarget, type CommandTarget } from '../commands/context';

export function createEditor() {
  const commandTarget = shallowRef<CommandTarget>(null);
  function claimTarget(target: CommandTarget) {
    commandTarget.value = target;
  }
  let history = new EditHistory(createProject());
  let committed = history.committed,
    version = 0;
  let snapshottedVersion = -1,
    snapshotPending = false;
  const recoveryEntries = shallowRef<RecoveryEntry[]>([]);
  const showRecovery = ref(false);
  const recoveryTime = ref<string | null>(null);
  const recoveryError = ref('');
  const recoveryWriting = ref(false);
  const confirmationKind = ref<'replace' | 'exit'>('replace');
  let recoveryTimer: ReturnType<typeof setInterval> | undefined;
  let removeClose: (() => void) | undefined;
  const project = shallowRef(history.current);
  const session = shallowRef<ProjectSession | null>(null);
  const busy = ref(false),
    dirty = ref(false),
    canUndo = ref(false),
    canRedo = ref(false);
  const notice = ref({
    text: '正在准备编辑器…',
    kind: 'info' as 'info' | 'error' | 'success' | 'warning',
  });
  const resources = new ResourcePool();
  const transport = new AudioTransport(resources);
  const buffer = shallowRef<AudioBuffer | null>(null);
  const playback = ref(transport.snapshot());
  const frameRecorder = new FrameRecorder();
  const performanceSample = shallowRef<ProcessSample | null>(null);
  const performanceHistory: ProcessSample[] = [];
  const fps = ref(0);
  const stage = shallowRef<EditorStage | null>(null);
  const zoom = ref(1);
  const selectedLayerId = ref<string | null>(null);
  const selectedLayer = computed(() =>
    selectedLayerId.value ? project.value.layers[selectedLayerId.value] : undefined,
  );
  const imageProgress = shallowRef<ImageImportProgress | null>(null);
  const lastImport = shallowRef<ImageImport | null>(null);
  const importWarnings = ref<string[]>([]);
  const sceneRevision = ref(0);
  let removeProgress: (() => void) | undefined;
  let dragProject: Project | null = null;
  const confirmReplacement = shallowRef<((choice: 'save' | 'discard' | 'cancel') => void) | null>(
    null,
  );
  let gestureActive = false;
  let lastGestureCommand: EditCommand | ChartCommand | RevealCommand | ProductionCommand | null =
    null;
  let raf = 0,
    sampleTimer: ReturnType<typeof setInterval> | undefined;
  let lastFPS = 0;
  let playbackRequest = 0;
  const music = computed(() =>
    project.value.music ? project.value.assets[project.value.music.assetId] : undefined,
  );
  const take = new PlaybackTake();
  const chart = createChart({
    take,
    onSelect: (ids) => claimTarget(ids.length ? { kind: 'notes', ids: [...ids] } : null),
    sourceOnly: () => !reveals.audition.value && reveals.override.value === null,
    revealOverride: () =>
      reveals.selectedId.value && reveals.override.value !== null
        ? { clipId: reveals.selectedId.value, progress: reveals.override.value }
        : null,
    project: () => history.current,
    time: () => transport.snapshot().timeUs,
    playing: () => transport.snapshot().playing,
    commit: edit,
    pause,
    seek,
    play: togglePlay,
    selectLayer,
    notify,
  });
  const tempo = chart.tempo;
  const analysis = createAudioAnalysis({ project, buffer, busy, commit: edit, seek, notify });
  const reveals = createReveals({
    project: () => history.current,
    chart,
    commit: edit,
    notify,
    onSelect: (id) => claimTarget({ kind: 'reveal', ids: [id] }),
  });
  const sounds = new SoundEngine(transport, take, (message) => notify(message, 'warning'));
  const selectedSoundId = ref<string | null>(null),
    selectedSoundAssetId = ref<string | null>(null);
  const soundAssets = computed(() => {
    const used = new Set(Object.values(project.value.sounds).map((cue) => cue.assetId));
    return Object.values(project.value.assets).filter(
      (asset) => asset.kind === 'audio' && (asset.audioRole === 'sfx' || used.has(asset.id)),
    );
  });
  const soundStats = shallowRef(sounds.metrics());
  let soundVersion = -1;
  const unsubscribeSounds = chart.subscribe((e) => {
    if (e.kind === 'session-reset') sounds.reset(e.timeUs);
  });
  const camera = createCamera({
    onSelect: (kind, id) => claimTarget({ kind, ids: [id] }),
    project: () => history.current,
    time: () => transport.snapshot().timeUs,
    edit,
    mode: () => chart.mode.value,
    snap: () => chart.snap.value,
    divisions: () => chart.divisions.value,
    pause,
    selectedLayer: () => selectedLayerId.value,
  });

  function notify(text: string, kind: 'info' | 'error' | 'success' | 'warning' = 'info'): void {
    notice.value = { text, kind };
  }
  function syncMusicGain(): void {
    const mix = project.value.mixer ?? defaultMixer();
    transport.setGain(mix.music.muted ? 0 : (project.value.music?.gain ?? 0.8) * mix.music.gain);
  }
  function refresh(): void {
    const next = transport.snapshot();
    chart.update(next.timeUs);
    reveals.update(next.timeUs);
    camera.update(next.timeUs);
    sounds.update(next.timeUs, next.playing, chart.mode.value);
    if (soundVersion !== sounds.revision) {
      soundVersion = sounds.revision;
      soundStats.value = sounds.metrics();
    }
    if (
      Object.keys(next).some(
        (key) => next[key as keyof typeof next] !== playback.value[key as keyof typeof next],
      )
    )
      playback.value = next;
  }
  function publish(): void {
    if (history.committed !== committed) {
      committed = history.committed;
      version++;
    }
    project.value = history.current;
    chart.setProject(history.current);
    reveals.setProject(history.current);
    camera.setProject(history.current);
    if (!validTarget(project.value, commandTarget.value)) claimTarget(null);
    dirty.value = history.dirty;
    canUndo.value = history.canUndo;
    canRedo.value = history.canRedo;
    syncMusicGain();
    if (session.value) sounds.setProject(project.value, session.value.handle);
    if (selectedSoundId.value && !project.value.sounds[selectedSoundId.value])
      selectedSoundId.value = null;
    if (selectedSoundAssetId.value && !project.value.assets[selectedSoundAssetId.value])
      selectedSoundAssetId.value = null;
    if (selectedLayerId.value && !project.value.layers[selectedLayerId.value]) selectLayer(null);
    if (session.value) stage.value?.setScene(project.value, session.value.handle);
    if (session.value)
      void window.desktop.setDirty({ handle: session.value.handle, dirty: dirty.value, version });
  }
  async function run<T>(operation: () => Promise<T>): Promise<T | undefined> {
    if (busy.value) return;
    busy.value = true;
    try {
      return await operation();
    } catch (error) {
      notify(error instanceof Error ? error.message : '操作失败，请重试', 'error');
      return undefined;
    } finally {
      busy.value = false;
      refresh();
    }
  }
  function edit(command: EditCommand | ChartCommand | RevealCommand | ProductionCommand): boolean {
    if (busy.value) return false;
    if (
      chart.mode.value !== 'edit' &&
      command.type !== 'set-gain' &&
      command.type !== 'set-mixer' &&
      command.type !== 'set-audio-analysis'
    ) {
      notify('请先切回编辑模式再修改工程', 'warning');
      return false;
    }
    const effectiveCommand =
      command.type === 'delete-layer'
        ? {
            ...command,
            atUs: transport.snapshot().timeUs,
            sourceOnly: !reveals.audition.value && reveals.override.value === null,
            revealOverride:
              reveals.selectedId.value && reveals.override.value !== null
                ? { clipId: reveals.selectedId.value, progress: reveals.override.value }
                : null,
          }
        : command;
    try {
      if (gestureActive) {
        history.preview(effectiveCommand);
        lastGestureCommand = effectiveCommand;
      } else history.execute(effectiveCommand);
      publish();
      return true;
    } catch (error) {
      if (!gestureActive) notify(error instanceof Error ? error.message : '输入值无效', 'error');
      return false;
    }
  }
  function beginGesture(): void {
    if (gestureActive) endGesture(false);
    gestureActive = true;
    lastGestureCommand = null;
  }
  function endGesture(commit: boolean): void {
    if (!gestureActive) return;
    gestureActive = false;
    const command = lastGestureCommand;
    lastGestureCommand = null;
    if (commit && command) history.execute(command);
    else history.cancelPreview();
    publish();
  }
  async function syncMusic(): Promise<void> {
    if (!session.value) return;
    const asset = music.value;
    if (!asset) {
      transport.unload();
      buffer.value = null;
      refresh();
      return;
    }
    if (transport.assetId === asset.id) {
      syncMusicGain();
      return;
    }
    const bytes = unwrap(
      await window.desktop.readAsset({ handle: session.value.handle, assetId: asset.id }),
    );
    const prepared = await transport.prepare(asset, bytes);
    transport.adopt(prepared);
    syncMusicGain();
    buffer.value = transport.buffer;
    refresh();
  }
  async function adopt(next: ProjectSession): Promise<void> {
    unwrap(
      await window.desktop.activateSession({
        handle: next.handle,
        version: next.recovery?.version ?? 0,
        dirty: Boolean(next.recovery),
      }),
    );
    analysis.cancel();
    chart.setMode('edit');
    const previous = session.value;
    transport.unload();
    buffer.value = null;
    history = new EditHistory(next.project, Boolean(next.recovery));
    committed = history.committed;
    version = next.recovery?.version ?? 0;
    snapshottedVersion = next.recovery?.version ?? -1;
    recoveryTime.value = next.recovery?.savedAt ?? null;
    recoveryError.value = '';
    claimTarget(null);
    session.value = next;
    selectLayer(null);
    lastImport.value = null;
    importWarnings.value = Object.values(next.project.sourceDocuments).flatMap(
      (source) => source.warnings ?? [],
    );
    publish();
    stage.value?.setArtwork(next.project.stage.artworkSize, true);
    chart.setTool(Object.keys(next.project.notes).length ? 'select' : 'layers');
    if (previous) unwrap(await window.desktop.closeSession(previous.handle));
    if (next.warnings.length) notify(next.warnings.join('；'), 'warning');
    else
      notify(
        next.recovery
          ? '已恢复快照，请正式保存工程'
          : next.filePath
            ? '工程已打开'
            : '新工程已准备好，可以导入音乐',
        'success',
      );
    try {
      await syncMusic();
    } catch (error) {
      notify(error instanceof Error ? error.message : '音乐加载失败', 'warning');
    }
  }
  async function snapshot(): Promise<void> {
    if (
      busy.value ||
      gestureActive ||
      snapshotPending ||
      (!history.dirty && !recoveryTime.value) ||
      !session.value ||
      version === snapshottedVersion
    )
      return;
    const handle = session.value.handle,
      captured = committed,
      capturedVersion = version;
    snapshotPending = true;
    recoveryWriting.value = true;
    try {
      const entry = unwrap(
        await window.desktop.snapshot({ handle, project: captured, version: capturedVersion }),
      );
      if (session.value?.handle === handle && entry) {
        snapshottedVersion = capturedVersion;
        recoveryTime.value = entry.savedAt;
        recoveryError.value = '';
      }
    } catch (error) {
      if (session.value?.handle === handle) {
        recoveryError.value = `自动恢复保存失败：${error instanceof Error ? error.message : '请重试'}`;
        notify(recoveryError.value + '。上一次完整快照仍保留，请尽快正式保存。', 'warning');
      }
    } finally {
      snapshotPending = false;
      recoveryWriting.value = false;
    }
  }
  async function save(saveAs = false): Promise<boolean> {
    endGesture(false);
    if (!session.value) return false;
    const handle = session.value.handle,
      savedHistory = history,
      captured = committed,
      savedVersion = version;
    const result = unwrap(
      await window.desktop.saveProject({
        handle,
        project: captured,
        saveAs,
        version: savedVersion,
      }),
    );
    if (!result) return false;
    if (session.value?.handle !== handle || history !== savedHistory) return false;
    session.value = { ...session.value, filePath: result.filePath };
    history.markSaved(captured);
    if (version === savedVersion) {
      recoveryTime.value = null;
      recoveryError.value = '';
    }
    publish();
    notify(result.warning ?? '工程和素材已保存', result.warning ? 'warning' : 'success');
    return !history.dirty;
  }
  async function allowReplacement(kind: 'replace' | 'exit' = 'replace'): Promise<boolean> {
    if (!dirty.value) return true;
    confirmationKind.value = kind;
    const choice = await new Promise<'save' | 'discard' | 'cancel'>((resolve) => {
      confirmReplacement.value = resolve;
    });
    confirmReplacement.value = null;
    if (choice === 'cancel') return false;
    if (choice === 'save') return save();
    return true;
  }
  async function discardCurrentRecovery(): Promise<void> {
    if (!session.value) return;
    unwrap(await window.desktop.discardSessionRecovery({ handle: session.value.handle, version }));
    recoveryTime.value = null;
  }
  async function requestClose(): Promise<void> {
    if (busy.value) {
      notify('正在处理当前操作，请完成后再关闭窗口', 'warning');
      return;
    }
    endGesture(false);
    pause();
    await run(async () => {
      if (!(await allowReplacement('exit'))) return;
      await discardCurrentRecovery();
      unwrap(
        await window.desktop.finishClose({
          handle: session.value?.handle ?? null,
          version: session.value ? version : 0,
        }),
      );
    });
  }
  async function restoreRecovery(entry: RecoveryEntry): Promise<void> {
    endGesture(false);
    await run(async () => {
      if (!(await allowReplacement())) return;
      const next = unwrap(
        await window.desktop.restoreRecovery({ id: entry.id, token: entry.token }),
      );
      await replaceWith(next);
      recoveryEntries.value = recoveryEntries.value.filter((item) => item.id !== entry.id);
      showRecovery.value = false;
    });
  }
  async function replaceWith(next: ProjectSession): Promise<void> {
    try {
      await discardCurrentRecovery();
    } catch (error) {
      await window.desktop.closeSession(next.handle);
      throw error;
    }
    await adopt(next);
  }
  async function discardRecovery(entry: RecoveryEntry): Promise<void> {
    await run(async () => {
      unwrap(await window.desktop.discardRecovery({ id: entry.id, token: entry.token }));
      recoveryEntries.value = recoveryEntries.value.filter((item) => item.id !== entry.id);
      if (!recoveryEntries.value.length) showRecovery.value = false;
    });
  }
  async function newDocument(name: string, size: Size): Promise<boolean> {
    endGesture(false);
    return (
      (await run(async () => {
        if (!(await allowReplacement())) return false;
        const document = createProject(name, size);
        const next = unwrap(await window.desktop.newProject(document));
        await replaceWith(next);
        return true;
      })) ?? false
    );
  }
  async function open(): Promise<void> {
    endGesture(false);
    await run(async () => {
      if (!(await allowReplacement())) return;
      const next = unwrap(await window.desktop.openProject());
      if (next) {
        await replaceWith(next);
      }
    });
  }
  async function importMusic(): Promise<void> {
    await run(async () => {
      if (!session.value) return;
      chart.setMode('edit');
      const handle = session.value.handle;
      const asset = unwrap(await window.desktop.importMusic(handle));
      if (!asset) return;
      notify('正在解码音乐并准备波形…');
      try {
        const bytes = unwrap(await window.desktop.readAsset({ handle, assetId: asset.id }));
        const prepared = await transport.prepare(asset, bytes);
        try {
          history.execute({ type: 'set-music', asset: { ...asset, audio: prepared.metadata } });
        } catch (error) {
          prepared.lease.release();
          throw error;
        }
        transport.adopt(prepared);
        buffer.value = transport.buffer;
        publish();
        notify(`已导入 ${asset.originalName}`, 'success');
      } catch (error) {
        await window.desktop.discardImport({ handle, assetId: asset.id });
        throw error;
      }
    });
  }
  async function importSound(replaceId?: string): Promise<void> {
    await run(async () => {
      if (!session.value) return;
      chart.setMode('edit');
      const handle = session.value.handle,
        asset = unwrap(await window.desktop.importSound(handle));
      if (!asset) return;
      try {
        const bytes = unwrap(await window.desktop.readAsset({ handle, assetId: asset.id }));
        const lease = await transport.decode(asset, bytes),
          b = lease.value;
        const next = {
          ...asset,
          audioRole: 'sfx' as const,
          audio: {
            durationUs: Math.round(b.duration * 1e6),
            channels: b.numberOfChannels,
            sampleRate: b.sampleRate,
          },
        };
        lease.release();
        history.execute({ type: 'put-sfx-asset', asset: next, replaceId });
        publish();
        selectedSoundAssetId.value = next.id;
        notify(`已导入音效 ${asset.originalName}`, 'success');
      } catch (error) {
        await window.desktop.discardImport({ handle, assetId: asset.id });
        throw error;
      }
    });
  }
  async function auditionSound(assetId: string, cueId?: string): Promise<void> {
    try {
      const asset = project.value.assets[assetId];
      if (asset) await sounds.audition(asset, cueId ? project.value.sounds[cueId] : undefined);
    } catch (error) {
      notify(error instanceof Error ? error.message : '音效试听失败', 'error');
    }
  }
  function selectSound(id: string) {
    selectedSoundId.value = id;
    claimTarget({ kind: 'sound', ids: [id] });
  }
  function copySound(id: string): void {
    const cue = structuredClone(project.value.sounds[id]);
    cue.id = crypto.randomUUID();
    if (cue.trigger.kind === 'timeline')
      cue.trigger.at = { basis: 'time', timeUs: tempo.value.resolve(cue.trigger.at) + 500000 };
    else cue.delayUs += 125000;
    if (edit({ type: 'put-sound', cue })) selectSound(cue.id);
  }
  async function importImage(): Promise<void> {
    await run(async () => {
      if (!session.value) return;
      chart.setMode('edit');
      pause();
      imageProgress.value = {
        handle: session.value.handle,
        phase: '选择图片素材',
        completed: 0,
        total: 0,
      };
      try {
        const imported = unwrap(
          await window.desktop.importImage({
            handle: session.value.handle,
            tileSize: Math.min(1024, stage.value?.capabilities?.maxTextureSize ?? 1024),
          }),
        );
        if (!imported) return;
        const wasEmpty = Object.keys(project.value.layers).length === 0;
        history.execute({ type: 'import-image', imported });
        lastImport.value = imported;
        importWarnings.value = imported.warnings;
        publish();
        if (wasEmpty) stage.value?.setArtwork(project.value.stage.artworkSize, true);
        selectLayer(imported.rootLayersBottomToTop.at(-1) ?? null);
        notify(
          `已导入 ${imported.name}：${imported.metrics.rasterLayers} 个像素图层、${imported.metrics.groups} 个分组，耗时 ${(imported.metrics.elapsedMs / 1000).toFixed(2)} 秒${imported.warnings.length ? '（请查看兼容提示）' : ''}`,
          imported.warnings.length ? 'warning' : 'success',
        );
      } finally {
        imageProgress.value = null;
      }
    });
  }
  function selectLayer(id: string | null): void {
    if (id) {
      chart.selected.value = [];
      chart.nodeId.value = null;
      chart.setTool('layers');
    }
    if (id) claimTarget({ kind: 'layer', ids: [id] });
    else if (commandTarget.value?.kind === 'layer') claimTarget(null);
    selectedLayerId.value = id;
    stage.value?.select(id);
  }
  function moveSelected(id: string, delta: Vec2, commit: boolean): void {
    if (busy.value || isLocked(history.current, id)) return;
    dragProject ??= history.current;
    const layer = dragProject.layers[id];
    const parentId = parents(dragProject).get(id) ?? null;
    const inv = inverse(worldMatrix(dragProject, parentId)),
      zero = point(inv, { x: 0, y: 0 }),
      offset = point(inv, delta);
    const transform = {
      ...layer.transform,
      position: {
        x: layer.transform.position.x + offset.x - zero.x,
        y: layer.transform.position.y + offset.y - zero.y,
      },
    };
    if (commit) {
      dragProject = null;
      edit({ type: 'set-layer', id, patch: { transform } });
    } else if (session.value) {
      // Live drag changes rendering only. A single undoable edit is committed on pointer release.
      stage.value?.setScene(
        { ...dragProject, layers: { ...dragProject.layers, [id]: { ...layer, transform } } },
        session.value.handle,
      );
    }
  }
  async function travel(direction: 'undo' | 'redo'): Promise<void> {
    endGesture(false);
    if (chart.mode.value !== 'edit') return;
    await run(async () => {
      const oldAssetId = transport.assetId;
      history[direction]();
      publish();
      if (oldAssetId !== (project.value.music?.assetId ?? null)) {
        transport.unload();
        buffer.value = null;
      }
      await syncMusic();
    });
  }
  function deleteSelectedLayer(): void {
    const id = selectedLayerId.value;
    if (id) edit({ type: 'delete-layer', id });
  }
  async function deleteAudio(assetId: string): Promise<void> {
    if (chart.mode.value !== 'edit') return;
    await run(async () => {
      history.execute({ type: 'delete-audio', assetId });
      publish();
      await syncMusic();
      notify('音频已删除，可通过撤销恢复', 'success');
    });
  }
  async function togglePlay(): Promise<void> {
    if (busy.value) return;
    try {
      if (transport.snapshot().playing) pause();
      else {
        const request = ++playbackRequest;
        if (transport.snapshot().timeUs >= transport.snapshot().durationUs) {
          transport.seek(0);
          chart.reset(0);
        }
        await sounds.prepare();
        if (request !== playbackRequest) return;
        await transport.play();
      }
      refresh();
    } catch (error) {
      notify(error instanceof Error ? error.message : '无法播放音乐', 'error');
    }
  }
  function seek(timeUs: number): void {
    playbackRequest++;
    chart.release();
    transport.seek(timeUs);
    chart.reset(transport.snapshot().timeUs, 'seek');
    refresh();
  }
  function pause(): void {
    playbackRequest++;
    chart.release();
    transport.pause();
    sounds.pause(transport.snapshot().timeUs);
    refresh();
  }
  function fit(): void {
    stage.value?.fit();
  }
  function setZoom(value: number): void {
    stage.value?.setZoom(value);
  }
  async function exportPerformance(): Promise<void> {
    await run(async () => {
      const report = {
        format: 'rhythm-canvas-performance',
        version: 1,
        recordedAt: new Date().toISOString(),
        stage: 5,
        limitations: [
          '单次报告只代表所打开的工程和采样窗口；真实美术与合成测试必须分别比较',
          '帧率为界面 requestAnimationFrame 间隔统计',
          '纹理占用为受管资源核算，未计入驱动和 PixiJS 内部资源',
          '屏幕缓冲占用为单个 RGBA 缓冲估算，非总显存',
        ],
        project: {
          id: project.value.id,
          artworkSize: project.value.stage.artworkSize,
          output: project.value.output,
          layers: Object.keys(project.value.layers).length,
        },
        frames: frameRecorder.snapshot(),
        resources: resources.stats(),
        graphics: stage.value?.metrics() ?? null,
        lastImageImport: lastImport.value
          ? {
              name: lastImport.value.name,
              size: lastImport.value.size,
              metrics: lastImport.value.metrics,
              warnings: lastImport.value.warnings,
            }
          : null,
        audio: transport.snapshot(),
        sounds: sounds.metrics(),
        processes: performanceHistory,
      };
      const file = unwrap(await window.desktop.exportPerformance(JSON.stringify(report, null, 2)));
      if (file) notify(`性能记录已保存：${file}`, 'success');
    });
  }
  function frame(timestamp: number): void {
    if (document.hidden) frameRecorder.resume();
    else frameRecorder.frame(timestamp);
    // Refresh on every display frame. Comparing adjacent rAF intervals with 1000/60
    // drops alternating frames when the display reports e.g. 16.6 ms instead of 16.667 ms.
    // Judgement and animation positions still come from the audio clock, never frame counts.
    refresh();
    if (timestamp - lastFPS >= 1000) {
      fps.value = frameRecorder.snapshot().fps;
      lastFPS = timestamp;
    }
    raf = requestAnimationFrame(frame);
  }
  async function initialize(): Promise<void> {
    removeClose = window.desktop.onCloseRequested(() => {
      void requestClose();
    });
    removeProgress = window.desktop.onImageProgress((value) => {
      if (value.handle === session.value?.handle) imageProgress.value = value;
    });
    await run(async () => adopt(unwrap(await window.desktop.newProject(project.value))));
    await run(async () => {
      const recoveries = unwrap(await window.desktop.listRecoveries());
      recoveryEntries.value = recoveries.entries;
      showRecovery.value = Boolean(recoveries.entries.length);
      if (recoveries.warnings.length) {
        recoveryError.value = recoveries.warnings.join('；');
        notify(recoveryError.value, 'warning');
      }
    });
    recoveryTimer = setInterval(() => {
      void snapshot();
    }, 15000);
    raf = requestAnimationFrame(frame);
    const sample = async () => {
      const result = await window.desktop.processSample();
      if (result.ok) {
        performanceSample.value = result.value;
        performanceHistory.push(result.value);
        if (performanceHistory.length > 150) performanceHistory.shift();
      }
    };
    await sample();
    sampleTimer = setInterval(() => {
      void sample();
    }, 2000);
  }
  function attachStage(value: EditorStage): void {
    stage.value = value;
    value.setArtwork(project.value.stage.artworkSize, true);
    value.setChart(chart);
    value.setReveals(reveals);
    value.setCamera(camera);
    value.onChange = () => {
      zoom.value = value.viewport.zoom;
      sceneRevision.value++;
    };
    value.onSelect = selectLayer;
    value.onMoveLayer = moveSelected;
    value.onAssetError = (error) => notify(error, 'warning');
    if (session.value) value.setScene(project.value, session.value.handle);
    value.onContextLost = () => {
      pause();
      notify('图形设备连接中断，播放已暂停。画布恢复后可继续。', 'warning');
    };
    zoom.value = value.viewport.zoom;
  }
  async function dispose(): Promise<void> {
    analysis.dispose();
    playbackRequest++;
    unsubscribeSounds();
    sounds.dispose();
    cancelAnimationFrame(raf);
    clearInterval(sampleTimer);
    clearInterval(recoveryTimer);
    removeClose?.();
    removeProgress?.();
    chart.dispose();
    reveals.dispose();
    await transport.dispose();
    resources.dispose();
  }
  return {
    commandTarget,
    claimTarget,
    selectSound,
    chart,
    analysis,
    sounds,
    soundAssets,
    selectedSoundId,
    selectedSoundAssetId,
    soundStats,
    importSound,
    auditionSound,
    copySound,
    camera,
    reveals,
    project,
    session,
    busy,
    dirty,
    canUndo,
    canRedo,
    notice,
    music,
    buffer,
    playback,
    tempo,
    fps,
    zoom,
    performanceSample,
    resources,
    stage,
    confirmReplacement,
    confirmationKind,
    recoveryEntries,
    showRecovery,
    recoveryTime,
    recoveryError,
    recoveryWriting,
    restoreRecovery,
    discardRecovery,
    selectedLayerId,
    selectedLayer,
    selectLayer,
    deleteSelectedLayer,
    deleteAudio,
    imageProgress,
    lastImport,
    importWarnings,
    sceneRevision,
    initialize,
    attachStage,
    notify,
    edit,
    beginGesture,
    endGesture,
    newDocument,
    open,
    importMusic,
    importImage,
    cancelImageImport: () => window.desktop.cancelImageImport(),
    save: (as = false) => run(() => save(as)),
    undo: () => travel('undo'),
    redo: () => travel('redo'),
    togglePlay,
    seek,
    pause,
    fit,
    setZoom,
    exportPerformance,
    dispose,
  };
}
export type Editor = ReturnType<typeof createEditor>;
