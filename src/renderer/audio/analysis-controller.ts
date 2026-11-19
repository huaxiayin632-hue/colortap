import { computed, shallowRef, watch, type Ref, type ShallowRef } from 'vue';
import type { EditCommand } from '../../application/history';
import type { AnalysisProgress } from '../../core/audio-analysis';
import { musicAnalysis } from '../../core/note-alignment';
import type { Project } from '../../shared/models';
import { AudioAnalysisTask, type AnalysisResult } from './audio-analysis-task';

interface AnalysisHost {
  project: ShallowRef<Project>;
  buffer: ShallowRef<AudioBuffer | null>;
  busy: Ref<boolean>;
  commit(command: EditCommand): boolean;
  seek(timeUs: number): void;
  notify(text: string, kind?: 'info' | 'warning' | 'error' | 'success'): void;
}
export function createAudioAnalysis(
  host: AnalysisHost,
  task: Pick<AudioAnalysisTask, 'analyze' | 'cancel'> = new AudioAnalysisTask(),
) {
  const progress = shallowRef<AnalysisProgress | null>(null);
  const pending = shallowRef<AnalysisResult | null>(null);
  const selectedOnset = shallowRef<number | null>(null);
  const result = computed(() => musicAnalysis(host.project.value));
  const running = computed(() => progress.value !== null);
  // Identity only covers an unfinished request/publication, never project revisions.
  let request: object | null = null;
  function cancel() {
    request = null;
    task.cancel();
    pending.value = null;
    progress.value = null;
  }
  const stopSource = watch(
    [
      () => host.project.value.id,
      () => host.project.value.music?.assetId,
      () =>
        host.project.value.music
          ? host.project.value.assets[host.project.value.music.assetId]?.sha256
          : undefined,
      () => host.buffer.value,
    ],
    () => {
      cancel();
      selectedOnset.value = null;
    },
    { flush: 'sync' },
  );
  // File operations own busy. Publish after they finish so save cannot mark an unsaved result saved.
  const stopPublish = watch(
    [pending, host.busy],
    () => {
      const value = pending.value;
      if (!value || host.busy.value) return;
      const p = host.project.value;
      if (
        p.music?.assetId === value.source.assetId &&
        p.assets[value.source.assetId]?.sha256 === value.source.sha256
      ) {
        if (
          host.commit({
            type: 'set-audio-analysis',
            assetId: value.source.assetId,
            sha256: value.source.sha256,
            analysis: value.analysis,
          })
        )
          host.notify(
            `分析完成：${value.analysis.onsets.length} 个起音。谱面与已采用节奏保持原样。`,
            'success',
          );
      }
      pending.value = null;
      progress.value = null;
      request = null;
    },
    { flush: 'post' },
  );
  async function analyze() {
    const p = host.project.value,
      buffer = host.buffer.value;
    const asset = p.music && p.assets[p.music.assetId];
    if (!buffer || !asset || host.busy.value) return;
    cancel();
    const current = (request = {});
    progress.value = { phase: 'copy', fraction: 0 };
    try {
      const value = await task.analyze(
        buffer,
        { assetId: asset.id, sha256: asset.sha256 },
        {},
        (value) => {
          if (request === current) progress.value = value;
        },
      );
      if (request === current) pending.value = value;
    } catch (error) {
      if (request !== current) return;
      request = null;
      progress.value = null;
      if (!(error instanceof Error && error.name === 'AbortError'))
        host.notify(error instanceof Error ? error.message : '音频分析失败', 'error');
    }
  }
  function selectOnset(timeUs: number) {
    selectedOnset.value = timeUs;
    host.seek(timeUs);
  }
  return {
    result,
    progress,
    running,
    selectedOnset,
    analyze,
    cancel,
    selectOnset,
    dispose() {
      stopSource();
      stopPublish();
      cancel();
    },
  };
}
