<script setup lang="ts">
import { computed, ref } from 'vue';
import type { Editor } from '../state/editor';
import { endUs } from '../../core/chart';
const props = defineProps<{ editor: Editor; pixelsPerSecond: number }>();
const c = props.editor.chart,
  draft = ref<{ id: string; delta: number; kind: 'move' | 'duration' } | null>(null);
let drag: { id: string; x: number; start: number; end: number; kind: 'move' | 'duration' } | null =
  null;
const notes = computed(() =>
  Object.values(c.document.value.notes)
    .sort((a, b) => c.tempo.value.resolve(a.at) - c.tempo.value.resolve(b.at))
    .map((note, index) => {
      const start = c.tempo.value.resolve(note.at),
        end = endUs(note, c.tempo.value),
        d = draft.value;
      const offset = d?.kind === 'move' && c.selected.value.includes(note.id) ? d.delta : 0;
      return {
        note,
        index,
        start,
        end,
        x: (Math.max(0, start + offset) / 1000000) * props.pixelsPerSecond,
        width: Math.max(
          18,
          ((end - start + (d?.kind === 'duration' && d.id === note.id ? d.delta : 0)) / 1000000) *
            props.pixelsPerSecond,
        ),
      };
    }),
);
function down(event: PointerEvent, id: string, kind: 'move' | 'duration'): void {
  if (props.editor.busy.value) return;
  if (c.mode.value !== 'edit') {
    props.editor.seek(c.tempo.value.resolve(c.document.value.notes[id].at));
    return;
  }
  event.preventDefault();
  props.editor.pause();
  if (event.shiftKey) c.select(id, true);
  else if (!c.selected.value.includes(id)) c.select(id);
  if (!c.selected.value.includes(id)) return;
  const note = c.document.value.notes[id];
  drag = {
    id,
    x: event.clientX,
    start: c.tempo.value.resolve(note.at),
    end: endUs(note, c.tempo.value),
    kind,
  };
  (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
}
function delta(event: PointerEvent): number {
  if (!drag) return 0;
  const raw = ((event.clientX - drag.x) / props.pixelsPerSecond) * 1000000;
  if (drag.kind === 'move') {
    const anchor = c.shiftPlan(raw, drag.id, event.altKey).find((update) => update.id === drag!.id);
    return anchor?.at ? c.tempo.value.resolve(anchor.at) - drag.start : 0;
  }
  const anchor = drag.kind === 'duration' ? drag.end : drag.start;
  const snapped = c.tempo.value.resolve(c.resolveMoment(anchor + raw, event.altKey));
  return snapped - anchor;
}
function move(event: PointerEvent): void {
  if (drag) draft.value = { id: drag.id, kind: drag.kind, delta: delta(event) };
}
function up(event: PointerEvent, cancelled = false): void {
  if (!drag) return;
  const d = delta(event),
    old = drag;
  drag = null;
  draft.value = null;
  if (cancelled) return;
  if (Math.abs(event.clientX - old.x) <= 3) {
    props.editor.seek(old.start);
    return;
  }
  if (old.kind === 'move')
    c.shiftNotes(((event.clientX - old.x) / props.pixelsPerSecond) * 1e6, old.id, event.altKey);
  else {
    const note = structuredClone(props.editor.project.value.notes[old.id]);
    if (note.kind !== 'circle') {
      const end = Math.max(old.start + 1000, old.end + d);
      note.duration =
        c.snapMode.value === 'grid' && !event.altKey
          ? {
              basis: 'beat',
              ticks: Math.max(
                1,
                Math.round(c.tempo.value.timeToTick(end) - c.tempo.value.timeToTick(old.start)),
              ),
            }
          : { basis: 'time', durationUs: end - old.start };
      c.setNote(note);
    }
  }
}
</script>
<template>
  <div
    class="note-track"
    data-testid="note-track"
    @pointerdown.stop
    @pointermove.stop="move"
    @pointerup.stop="up($event)"
    @pointercancel.stop="up($event, true)"
  >
    <span v-if="!notes.length" class="track-hint">选 Circle / Slider 工具，在画布放置音符</span>
    <button
      v-for="entry in notes"
      :key="entry.note.id"
      class="timeline-note"
      :class="{
        selected: c.selected.value.includes(entry.note.id),
        slider: entry.note.kind === 'slider',
        hold: entry.note.kind === 'hold',
      }"
      :data-note-id="entry.note.id"
      :data-kind="entry.note.kind"
      :data-time-us="entry.start"
      :data-end-us="entry.end"
      :aria-label="`${entry.note.kind === 'circle' ? 'Circle' : entry.note.kind === 'hold' ? '长按' : 'Slider'} ${entry.index + 1} 时间轴`"
      :style="{ left: entry.x + 'px', width: entry.width + 'px' }"
      :title="`${entry.note.kind} · ${(entry.start / 1000000).toFixed(3)} 秒，拖动修改时间`"
      @pointerdown.stop="down($event, entry.note.id, 'move')"
      @pointermove.stop="move"
      @pointerup.stop="up($event)"
      @pointercancel.stop="up($event, true)"
      @keydown.enter="
        c.select(entry.note.id);
        editor.seek(entry.start);
      "
    >
      {{ entry.index + 1
      }}<span
        v-if="entry.note.kind !== 'circle'"
        class="duration-handle"
        :aria-label="`调整 ${entry.note.kind === 'hold' ? '长按' : 'Slider'} ${entry.index + 1} 时长`"
        @pointerdown.stop="down($event, entry.note.id, 'duration')"
        >▏</span
      >
    </button>
  </div>
</template>
