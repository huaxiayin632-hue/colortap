<script setup lang="ts">
import { computed, ref, watchEffect } from 'vue';
import type { Editor } from '../state/editor';
import { nominalSoundTime } from '../../core/sound';
const props = defineProps<{ editor: Editor; pixelsPerSecond: number }>(),
  emit = defineEmits<{ resize: [number] }>();
const draft = ref<{ id: string; delta: number } | null>(null);
let drag: { id: string; x: number; start: number } | null = null;
const clips = computed(() => {
  const ends: number[] = [],
    p = props.editor.project.value,
    tempo = props.editor.tempo.value;
  return Object.values(p.sounds)
    .map((cue) => ({ cue, start: nominalSoundTime(p, cue, tempo) }))
    .sort((a, b) => a.start - b.start)
    .map(({ cue, start }) => {
      const asset = p.assets[cue.assetId],
        width = Math.max(110, ((asset.audio?.durationUs ?? 100000) / 1e6) * props.pixelsPerSecond),
        x = (start / 1e6) * props.pixelsPerSecond;
      let lane = ends.findIndex((end) => end + 3 <= x);
      if (lane < 0) lane = ends.length;
      ends[lane] = x + width;
      const t = cue.trigger,
        layer = 'revealId' in t ? p.layers[p.reveals[t.revealId].layerId]?.name : undefined;
      return {
        cue,
        start,
        x: x + (draft.value?.id === cue.id ? (draft.value.delta / 1e6) * props.pixelsPerSecond : 0),
        width,
        lane,
        label: `${t.kind === 'timeline' ? '时间' : '? 条件/演出'} · ${layer ?? ('noteId' in t ? p.notes[t.noteId].kind : '')} · ${asset.label ?? asset.originalName}`,
      };
    });
});
const height = computed(() =>
  Math.max(46, (Math.max(0, ...clips.value.map((c) => c.lane)) + 1) * 27 + 8),
);
watchEffect(() => emit('resize', height.value));
function down(e: PointerEvent, id: string, start: number) {
  e.preventDefault();
  props.editor.selectedSoundId.value = id;
  (e.currentTarget as HTMLElement).focus({ preventScroll: true });
  if (props.editor.chart.mode.value !== 'edit') return;
  props.editor.pause();
  drag = { id, x: e.clientX, start };
  draft.value = { id, delta: 0 };
  (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
}
function move(e: PointerEvent) {
  if (!drag) return;
  let to = Math.max(0, drag.start + ((e.clientX - drag.x) / props.pixelsPerSecond) * 1e6);
  if (props.editor.chart.snap.value && !e.altKey)
    to = props.editor.tempo.value.snap(to, props.editor.chart.divisions.value);
  draft.value = { id: drag.id, delta: Math.round(to - drag.start) };
}
function up(e: PointerEvent, cancel = false) {
  if (!drag) return;
  const old = drag;
  move(e);
  const d = draft.value!.delta;
  drag = null;
  draft.value = null;
  if (cancel) return;
  if (Math.abs(e.clientX - old.x) < 3) {
    props.editor.seek(old.start);
    return;
  }
  const cue = structuredClone(props.editor.project.value.sounds[old.id]);
  if (cue.trigger.kind === 'timeline')
    cue.trigger.at = { basis: 'time', timeUs: Math.max(0, old.start + d - cue.delayUs) };
  else cue.delayUs = Math.max(0, cue.delayUs + d);
  props.editor.edit({ type: 'put-sound', cue });
}
function copy(id: string) {
  props.editor.copySound(id);
}
</script>
<template>
  <div
    class="production-track sound-track"
    :style="{ height: height + 'px' }"
    data-testid="sound-track"
  >
    <span v-if="!clips.length" class="track-hint">导入音效并添加时间或命中绑定</span
    ><button
      v-for="c in clips"
      :key="c.cue.id"
      class="timeline-sound"
      :class="{
        selected: editor.selectedSoundId.value === c.cue.id,
        disabled: c.cue.enabled === false,
      }"
      :data-sound-id="c.cue.id"
      :data-time-us="c.start"
      :title="c.label"
      :style="{ left: c.x + 'px', top: 5 + c.lane * 27 + 'px', width: c.width + 'px' }"
      @pointerdown.stop="down($event, c.cue.id, c.start)"
      @pointermove.stop="move"
      @pointerup.stop="up($event)"
      @pointercancel.stop="up($event, true)"
      @keydown.delete.prevent.stop="editor.edit({ type: 'delete-sound', id: c.cue.id })"
      @keydown.ctrl.d.prevent.stop="copy(c.cue.id)"
    >
      {{ c.label }}
    </button>
  </div>
</template>
