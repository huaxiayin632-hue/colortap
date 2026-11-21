<script setup lang="ts">
import { computed, ref, watchEffect } from 'vue';
import type { Editor } from '../state/editor';
import { effectLabels, nominalClipRange, outlineStages, clamp01 } from '../../core/reveal';
import { endUs } from '../../core/chart';
import { outlineDrawProgress } from '../../core/easing';
const props = defineProps<{
  editor: Editor;
  pixelsPerSecond: number;
  track?: 'layers' | 'outlines';
}>();
const emit = defineEmits<{ resize: [number] }>();
const r = props.editor.reveals;
const delta = ref(0);
type Stage = 'effect' | 'outline' | 'layer';
let drag: {
  id: string;
  x: number;
  start: number;
  end: number;
  duration: boolean;
  stage: Stage;
} | null = null;
const clips = computed(() => {
  const ends: number[] = [];
  const noteLabels = new Map(
    Object.values(props.editor.project.value.notes)
      .sort(
        (a, b) => props.editor.tempo.value.resolve(a.at) - props.editor.tempo.value.resolve(b.at),
      )
      .map((n, index) => [
        n.id,
        `${n.kind === 'hold' ? '长按' : n.kind === 'circle' ? 'Circle' : 'Slider'} #${index + 1}`,
      ]),
  );
  return Object.values(props.editor.project.value.reveals)
    .flatMap((clip) => {
      const stages = outlineStages(props.editor.project.value, clip);
      return stages
        ? [
            { clip, start: stages.drawStart, end: stages.drawEnd, stage: 'outline' as Stage },
            { clip, start: stages.layerStart, end: stages.layerEnd, stage: 'layer' as Stage },
          ]
        : [
            {
              clip,
              ...nominalClipRange(props.editor.project.value, clip),
              stage: 'effect' as Stage,
            },
          ];
    })
    .filter((entry) =>
      props.track === 'outlines'
        ? entry.stage === 'outline'
        : props.track === 'layers'
          ? entry.stage !== 'outline'
          : true,
    )
    .sort((a, b) => a.start - b.start)
    .map((entry) => {
      const x = (entry.start / 1e6) * props.pixelsPerSecond,
        width = Math.max(90, ((entry.end - entry.start) / 1e6) * props.pixelsPerSecond);
      let lane = ends.findIndex((end) => end + 4 <= x);
      if (lane < 0) lane = ends.length;
      ends[lane] = x + width;
      return {
        ...entry,
        noteLabel:
          entry.clip.trigger.kind === 'note'
            ? noteLabels.get(entry.clip.trigger.noteId)
            : '音乐时间',
        lane,
        x:
          x +
          (drag?.id === entry.clip.id && drag.stage === entry.stage && !drag.duration
            ? (delta.value / 1e6) * props.pixelsPerSecond
            : 0),
        width:
          width +
          (drag?.id === entry.clip.id && drag.stage === entry.stage && drag.duration
            ? (delta.value / 1e6) * props.pixelsPerSecond
            : 0),
      };
    });
});
const height = computed(() =>
  Math.max(62, (Math.max(0, ...clips.value.map((e) => e.lane)) + 1) * 27 + 8),
);
watchEffect(() => emit('resize', height.value));
function down(event: PointerEvent, id: string, duration = false, stage: Stage = 'effect') {
  if (event.button !== 0) return;
  event.preventDefault();
  (event.currentTarget as HTMLElement).focus({ preventScroll: true });
  r.choose(id);
  const clip = props.editor.project.value.reveals[id],
    stages = outlineStages(props.editor.project.value, clip),
    range =
      stage === 'layer' && stages
        ? { start: stages.layerStart, end: stages.layerEnd }
        : nominalClipRange(props.editor.project.value, clip);
  drag = { id, x: event.clientX, start: range.start, end: range.end, duration, stage };
  delta.value = 0;
  (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
}
function move(event: PointerEvent) {
  if (drag && props.editor.chart.mode.value === 'edit')
    delta.value = Math.round(((event.clientX - drag.x) / props.pixelsPerSecond) * 1e6);
}
function up(event: PointerEvent, cancelled = false) {
  if (!drag) return;
  const old = drag,
    d = delta.value,
    clip = props.editor.project.value.reveals[old.id];
  drag = null;
  delta.value = 0;
  if (cancelled) return;
  if (Math.abs(event.clientX - old.x) < 3 || props.editor.chart.mode.value !== 'edit') {
    props.editor.seek(old.start);
    return;
  }
  const tempo = props.editor.tempo.value,
    snap = props.editor.chart.snap.value && !event.altKey;
  const target = snap
    ? tempo.snap((old.duration ? old.end : old.start) + d, props.editor.chart.divisions.value)
    : (old.duration ? old.end : old.start) + d;
  if (old.stage === 'layer' && clip.effect.kind === 'outline') {
    if (old.duration)
      r.patchEffect({
        layer: { ...clip.effect.layer, durationUs: Math.max(0, Math.round(target - old.start)) },
      });
    else {
      const draw = nominalClipRange(props.editor.project.value, clip);
      const origin =
        clip.progress.kind === 'elapsed'
          ? draw.start
          : tempo.resolve(props.editor.project.value.notes[clip.progress.noteId].at);
      const duration =
        clip.progress.kind === 'elapsed'
          ? draw.duration
          : endUs(props.editor.project.value.notes[clip.progress.noteId], tempo) - origin;
      r.patchEffect({
        layer: {
          ...clip.effect.layer,
          threshold:
            duration > 0
              ? outlineDrawProgress(clamp01((target - origin) / duration), clip.easing)
              : 0,
        },
      });
    }
  } else if (old.duration && clip.progress.kind === 'elapsed')
    r.patch({
      progress: {
        kind: 'elapsed',
        duration: { basis: 'time', durationUs: Math.max(1000, target - old.start) },
      },
    });
  else if (!old.duration) {
    if (clip.trigger.kind === 'timeline')
      r.patch({
        trigger: {
          kind: 'timeline',
          at: { basis: 'time', timeUs: Math.max(0, Math.round(target - (clip.delayUs ?? 0))) },
        },
      });
    else r.patch({ delayUs: Math.max(0, Math.round((clip.delayUs ?? 0) + target - old.start)) });
  }
}
</script>
<template>
  <div
    class="reveal-track"
    :data-testid="track === 'outlines' ? 'outline-track' : 'reveal-track'"
    :style="{ height: height + 'px', overflow: 'visible' }"
    @pointerdown.stop
    @pointermove.stop="move"
    @pointerup.stop="up($event)"
    @pointercancel.stop="up($event, true)"
  >
    <div class="reveal-lanes" :style="{ height: height + 'px' }">
      <span v-if="!clips.length" class="track-hint">在右侧添加音符与图层绑定</span>
      <button
        v-for="entry in clips"
        :key="entry.clip.id + entry.stage"
        class="timeline-reveal"
        :class="{
          selected: r.selectedId.value === entry.clip.id,
          'outline-phase': entry.stage === 'outline',
          'layer-phase': entry.stage === 'layer',
        }"
        :data-reveal-id="entry.clip.id"
        :data-stage="entry.stage"
        :data-time-us="entry.start"
        :data-end-us="entry.end"
        :style="{
          left: entry.x + 'px',
          width: Math.max(30, entry.width) + 'px',
          top: 5 + entry.lane * 27 + 'px',
        }"
        :title="`${editor.project.value.layers[entry.clip.layerId]?.name} · ${entry.stage === 'outline' ? '① 白线描绘' : entry.stage === 'layer' ? '② 整层显现' : effectLabels[entry.clip.effect.kind]} · ${entry.noteLabel} · ${(entry.start / 1e6).toFixed(3)} 秒${entry.clip.progress.kind === 'slider-follow' ? '（按成功追踪估计；试玩取决于实际阈值时间）' : ''}`"
        @pointerdown.stop="down($event, entry.clip.id, false, entry.stage)"
        @pointermove.stop="move"
        @pointerup.stop="up($event)"
        @pointercancel.stop="up($event, true)"
        @click="
          if ($event.detail === 0) {
            r.choose(entry.clip.id);
            editor.seek(entry.start);
          }
        "
      >
        {{ editor.project.value.layers[entry.clip.layerId]?.name }} ·
        {{
          entry.stage === 'outline'
            ? '① 描线'
            : entry.stage === 'layer'
              ? '② 整层'
              : effectLabels[entry.clip.effect.kind].split(' · ')[0]
        }}
        · {{ entry.clip.trigger.kind === 'note' ? '? 条件 · ' : '' }}{{ entry.noteLabel }}
        <span
          v-if="
            (entry.stage !== 'layer' && entry.clip.progress.kind === 'elapsed') ||
            (entry.stage === 'layer' &&
              entry.clip.effect.kind === 'outline' &&
              entry.clip.effect.layer.kind !== 'instant')
          "
          class="duration-handle"
          aria-label="调整显现时长"
          @pointerdown.stop="down($event, entry.clip.id, true, entry.stage)"
          >▏</span
        >
      </button>
    </div>
  </div>
</template>
