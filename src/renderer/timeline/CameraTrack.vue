<script setup lang="ts">
import { computed, ref, watchEffect } from 'vue';
import type { Editor } from '../state/editor';
import { spanUs } from '../../core/chart';
const props = defineProps<{ editor: Editor; pixelsPerSecond: number }>(),
  emit = defineEmits<{ resize: [number] }>();
const c = props.editor.camera,
  draft = ref<{ id: string; delta: number } | null>(null);
let drag: {
  id: string;
  x: number;
  start: number;
  end: number;
  shake: boolean;
  resize: boolean;
} | null = null;
const keys = computed(() =>
  Object.values(props.editor.project.value.camera.keys)
    .map((key) => ({ key, time: props.editor.tempo.value.resolve(key.at) }))
    .sort((a, b) => a.time - b.time),
);
const shakes = computed(() =>
  Object.values(props.editor.project.value.camera.shakes ?? {}).map((s) => ({
    s,
    start: props.editor.tempo.value.resolve(s.at),
    duration: spanUs(s.duration, s.at, props.editor.tempo.value),
  })),
);
watchEffect(() => emit('resize', shakes.value.length ? 78 : 48));
const x = (id: string, time: number, resize = false) =>
  ((time + (draft.value?.id === id && drag?.resize === resize ? draft.value.delta : 0)) / 1e6) *
  props.pixelsPerSecond;
function down(e: PointerEvent, id: string, shake = false, resize = false) {
  e.preventDefault();
  (e.currentTarget as HTMLElement).focus({ preventScroll: true });
  if (shake) {
    c.selectedId.value = null;
    c.selectedShake.value = id;
  } else c.choose(id);
  if (props.editor.chart.mode.value !== 'edit') return;
  props.editor.pause();
  const p = props.editor.project.value,
    at = shake ? p.camera.shakes![id].at : p.camera.keys[id].at,
    start = props.editor.tempo.value.resolve(at),
    end = shake
      ? start + spanUs(p.camera.shakes![id].duration, at, props.editor.tempo.value)
      : start;
  drag = { id, x: e.clientX, start, end, shake, resize };
  draft.value = { id, delta: 0 };
  (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
}
function move(e: PointerEvent) {
  if (!drag) return;
  const from = drag.resize ? drag.end : drag.start;
  let target = Math.max(
    drag.resize ? drag.start + 1000 : 0,
    from + ((e.clientX - drag.x) / props.pixelsPerSecond) * 1e6,
  );
  if (props.editor.chart.snap.value && !e.altKey)
    target = props.editor.tempo.value.snap(target, props.editor.chart.divisions.value);
  draft.value = { id: drag.id, delta: Math.round(target - from) };
}
function up(e: PointerEvent, cancel = false) {
  if (!drag) return;
  const old = drag;
  move(e);
  const delta = draft.value!.delta;
  drag = null;
  draft.value = null;
  if (cancel) return;
  if (Math.abs(e.clientX - old.x) < 3) {
    props.editor.seek(old.start);
    return;
  }
  if (old.shake) {
    const shake = structuredClone(props.editor.project.value.camera.shakes![old.id]);
    if (old.resize)
      shake.duration = { basis: 'time', durationUs: Math.max(1000, old.end - old.start + delta) };
    else shake.at = { basis: 'time', timeUs: Math.max(0, old.start + delta) };
    props.editor.edit({ type: 'put-shake', shake });
  } else {
    const key = structuredClone(props.editor.project.value.camera.keys[old.id]);
    key.at = { basis: 'time', timeUs: Math.max(0, old.start + delta) };
    props.editor.edit({ type: 'put-camera-key', key });
  }
}
function remove(id: string, shake = false) {
  props.editor.edit(shake ? { type: 'delete-shake', id } : { type: 'delete-camera-key', id });
}
function shakeWidth(id: string, duration: number) {
  return Math.max(
    40,
    ((duration + (draft.value?.id === id && drag?.resize ? draft.value.delta : 0)) / 1e6) *
      props.pixelsPerSecond,
  );
}
</script>
<template>
  <div
    class="production-track camera-track"
    :style="{ height: shakes.length ? 78 + 'px' : 48 + 'px' }"
    data-testid="camera-track"
  >
    <span v-if="!keys.length && !shakes.length" class="track-hint">在镜头面板按节拍添加关键帧</span>
    <div
      v-for="(entry, i) in keys.slice(0, -1)"
      :key="'line' + entry.key.id"
      class="camera-segment"
      :style="{
        left: x(entry.key.id, entry.time) + 'px',
        width: ((keys[i + 1].time - entry.time) / 1e6) * pixelsPerSecond + 'px',
      }"
    />
    <button
      v-for="entry in keys"
      :key="entry.key.id"
      class="timeline-camera-key"
      :class="{ selected: c.selectedId.value === entry.key.id }"
      :data-camera-id="entry.key.id"
      :data-time-us="entry.time"
      :title="`${(entry.time / 1e6).toFixed(3)}秒 · ${entry.key.zoom.toFixed(2)}×`"
      :style="{ left: x(entry.key.id, entry.time) + 'px' }"
      @pointerdown.stop="down($event, entry.key.id)"
      @pointermove.stop="move"
      @pointerup.stop="up($event)"
      @pointercancel.stop="up($event, true)"
      @keydown.delete.prevent.stop="remove(entry.key.id)"
      @keydown.ctrl.d.prevent.stop="
        c.choose(entry.key.id);
        c.copy();
      "
    >
      ◆</button
    ><button
      v-for="entry in shakes"
      :key="entry.s.id"
      class="timeline-shake"
      :data-shake-id="entry.s.id"
      :style="{
        left: x(entry.s.id, entry.start) + 'px',
        width: shakeWidth(entry.s.id, entry.duration) + 'px',
      }"
      @pointerdown.stop="down($event, entry.s.id, true)"
      @pointermove.stop="move"
      @pointerup.stop="up($event)"
      @pointercancel.stop="up($event, true)"
      @keydown.delete.prevent.stop="remove(entry.s.id, true)"
    >
      震动<span class="duration-handle" @pointerdown.stop="down($event, entry.s.id, true, true)"
        >▏</span
      >
    </button>
  </div>
</template>
