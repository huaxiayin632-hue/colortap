<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from 'vue';
import type { Editor } from '../state/editor';
import { formatTime } from '../../core/timing';
import { onsetIndex, type SnapMode } from '../../core/note-alignment';
import Waveform from './Waveform.vue';
import NoteTrack from './NoteTrack.vue';
import RevealTrack from './RevealTrack.vue';
import SoundTrack from './SoundTrack.vue';
import CameraTrack from './CameraTrack.vue';
import { defaultTracks, type TrackId, type TrackLayout } from '../../shared/models';

const emit = defineEmits<{ collapse: [] }>();
const props = defineProps<{ editor: Editor }>();
const scroller = ref<HTMLDivElement>();
const labelScroller = ref<HTMLElement>();
const pixelsPerSecond = ref(44);
const divisions = props.editor.chart.divisions;
const scrollLeft = ref(0),
  visibleWidth = ref(1000);
const rowHeights = ref<Record<TrackId, number>>({
  music: 66,
  notes: 32,
  layers: 62,
  outlines: 62,
  sounds: 46,
  camera: 48,
});
function syncScroll(event: Event, fromLabels = false) {
  const source = event.target as HTMLElement;
  const target = fromLabels ? scroller.value : labelScroller.value;
  if (target && Math.abs(target.scrollTop - source.scrollTop) > 0.5)
    target.scrollTop = source.scrollTop;
  if (!fromLabels) scrollLeft.value = source.scrollLeft;
}
const layout = computed(() => props.editor.project.value.tracks ?? defaultTracks());
const labels: Record<TrackId, string> = {
  music: '背景音乐',
  notes: 'Circle / Slider',
  layers: '图层演出',
  outlines: '白线描绘',
  sounds: '音效',
  camera: '镜头',
};
const readonly = computed(
  () => props.editor.busy.value || props.editor.chart.mode.value !== 'edit',
);
const rowHeight = (id: TrackId) =>
  layout.value.hidden.includes(id) || layout.value.collapsed.includes(id)
    ? 26
    : rowHeights.value[id];
function trackPatch(patch: Partial<TrackLayout>) {
  props.editor.edit({ type: 'set-tracks', tracks: { ...layout.value, ...patch } });
}
function toggleTrack(id: TrackId, kind: 'collapsed' | 'hidden') {
  trackPatch({
    [kind]: layout.value[kind].includes(id)
      ? layout.value[kind].filter((x) => x !== id)
      : [...layout.value[kind], id],
  });
}
function reorder(id: TrackId, index: number) {
  const order = layout.value.order.filter((x) => x !== id);
  order.splice(Math.max(0, Math.min(order.length, index)), 0, id);
  trackPatch({ order });
}
function dropTrack(e: DragEvent, id: TrackId) {
  const source = e.dataTransfer?.getData('application/rhythm-track') as TrackId;
  if (layout.value.order.includes(source)) reorder(source, layout.value.order.indexOf(id));
}
const durationSeconds = computed(() =>
  Math.max(30, props.editor.playback.value.durationUs / 1_000_000),
);
const contentWidth = computed(() =>
  Math.max(visibleWidth.value, durationSeconds.value * pixelsPerSecond.value + 32),
);
const headX = computed(
  () => (props.editor.playback.value.timeUs / 1_000_000) * pixelsPerSecond.value,
);
const beat = computed(
  () => props.editor.tempo.value.timeToTick(props.editor.playback.value.timeUs) / 960,
);
const beatLabel = computed(() => {
  const count = Math.max(0, Math.floor(beat.value));
  return `${Math.floor(count / 4) + 1} : ${(count % 4) + 1}`;
});
const marks = computed(() => {
  const step =
    [0.1, 0.25, 0.5, 1, 2, 5, 10, 20, 30, 60, 120, 300, 600, 1800, 3600].find(
      (value) => value * pixelsPerSecond.value >= 70,
    ) ?? 3600;
  const start = Math.max(0, Math.floor(scrollLeft.value / pixelsPerSecond.value / step) * step);
  const end = Math.min(
    durationSeconds.value,
    (scrollLeft.value + visibleWidth.value) / pixelsPerSecond.value + step,
  );
  const result: { x: number; label: string }[] = [];
  for (let second = start; second <= end; second += step)
    result.push({
      x: second * pixelsPerSecond.value,
      label: formatTime(second * 1_000_000).slice(0, step < 1 ? 9 : 5),
    });
  return result;
});
const beats = computed(() => {
  const tempo = props.editor.tempo.value;
  const startUs = (scrollLeft.value / pixelsPerSecond.value) * 1_000_000;
  const endUs = Math.min(
    durationSeconds.value * 1_000_000,
    ((scrollLeft.value + visibleWidth.value) / pixelsPerSecond.value) * 1_000_000,
  );
  return tempo
    .grid(startUs, endUs, divisions.value, 4e6 / pixelsPerSecond.value)
    .map((line) => ({ ...line, x: (line.timeUs / 1e6) * pixelsPerSecond.value }));
});
const onsetMarks = computed(() => {
  const onsets = props.editor.analysis.result.value?.onsets ?? [];
  const start = (scrollLeft.value / pixelsPerSecond.value) * 1e6,
    end = ((scrollLeft.value + visibleWidth.value) / pixelsPerSecond.value) * 1e6;
  const result: { timeUs: number; strength: number; x: number; count: number }[] = [];
  for (let i = onsetIndex(onsets, start); i < onsets.length && onsets[i].timeUs <= end; i++) {
    const onset = onsets[i],
      x = (onset.timeUs / 1e6) * pixelsPerSecond.value,
      last = result.at(-1);
    if (last && Math.floor(x / 4) === Math.floor(last.x / 4)) {
      last.count++;
      if (onset.strength > last.strength) Object.assign(last, { ...onset, x });
    } else result.push({ ...onset, x, count: 1 });
  }
  return result;
});
let scrubbing: { pointerId: number; resume: boolean } | null = null;
function seekAt(event: PointerEvent): void {
  if (!scroller.value || !props.editor.playback.value.ready) return;
  const rect = scroller.value.getBoundingClientRect();
  let timeUs = Math.round(
    ((event.clientX - rect.left + scroller.value.scrollLeft) / pixelsPerSecond.value) * 1_000_000,
  );
  timeUs = props.editor.tempo.value.resolve(props.editor.chart.resolveMoment(timeUs, event.altKey));
  props.editor.seek(timeUs);
}
function down(event: PointerEvent): void {
  if (event.button !== 0 || !props.editor.playback.value.ready) return;
  scrubbing = { pointerId: event.pointerId, resume: props.editor.playback.value.playing };
  props.editor.pause();
  scroller.value?.setPointerCapture(event.pointerId);
  seekAt(event);
}
function move(event: PointerEvent): void {
  if (scrubbing?.pointerId === event.pointerId) seekAt(event);
}
function up(event: PointerEvent): void {
  if (scrubbing?.pointerId !== event.pointerId) return;
  const resume = scrubbing.resume;
  scrubbing = null;
  if (scroller.value?.hasPointerCapture(event.pointerId))
    scroller.value.releasePointerCapture(event.pointerId);
  if (resume) void props.editor.togglePlay();
}
async function zoomAtHead(value: number): Promise<void> {
  if (!scroller.value) return;
  const anchorSeconds =
    (scroller.value.scrollLeft + visibleWidth.value / 2) / pixelsPerSecond.value;
  pixelsPerSecond.value = value;
  await nextTick();
  scroller.value.scrollLeft = Math.max(0, anchorSeconds * value - visibleWidth.value / 2);
}
function jumpToHead(): void {
  if (scroller.value) scroller.value.scrollLeft = Math.max(0, headX.value - visibleWidth.value / 3);
}
let observer: ResizeObserver | null = null;
onMounted(() => {
  observer = new ResizeObserver(() => {
    // Hidden panels retain their viewport and scroll state until they become visible again.
    if (scroller.value?.clientWidth) visibleWidth.value = scroller.value.clientWidth;
  });
  if (scroller.value) observer.observe(scroller.value);
});
onBeforeUnmount(() => observer?.disconnect());
</script>

<template>
  <section class="timeline-panel" aria-label="时间轴">
    <header class="timeline-toolbar">
      <button aria-label="收起时间轴" @click="emit('collapse')">▾</button><strong>时间轴</strong
      ><span class="beat-readout">第 {{ beatLabel }} 拍</span>
      <label
        >音符吸附
        <select
          aria-label="音符吸附模式"
          :value="editor.chart.snapMode.value"
          @change="
            editor.chart.snapMode.value = ($event.target as HTMLSelectElement).value as SnapMode
          "
        >
          <option value="off">关闭</option>
          <option value="grid">节拍网格</option>
          <option value="onset">智能起音</option>
        </select>
      </label>
      <select v-model="divisions" aria-label="节拍细分">
        <option :value="1">1/4 音符 · 1 拍</option>
        <option :value="2">1/8 音符 · 1/2 拍</option>
        <option :value="4">1/16 音符 · 1/4 拍</option>
        <option :value="8">1/32 音符 · 1/8 拍</option>
        <option :value="16">1/64 音符 · 1/16 拍</option>
      </select>
      <span class="toolbar-spacer" /><button @click="jumpToHead">定位播放头</button
      ><label class="timeline-zoom"
        >时间缩放<input
          aria-label="时间轴缩放"
          type="range"
          min="8"
          max="200"
          :value="pixelsPerSecond"
          @input="zoomAtHead(Number(($event.target as HTMLInputElement).value))"
      /></label>
    </header>
    <div class="timeline-tracks production-tracks">
      <div class="track-labels">
        <div class="ruler-label">分 : 秒</div>
        <section
          ref="labelScroller"
          class="track-labels-viewport"
          @scroll="syncScroll($event, true)"
        >
          <section class="track-labels-content">
            <div
              v-for="(id, index) in layout.order"
              :key="id"
              class="timeline-label-row"
              :data-track-label="id"
              :style="{ height: rowHeight(id) + 'px' }"
              :draggable="!readonly"
              @dragstart="$event.dataTransfer?.setData('application/rhythm-track', id)"
              @dragover.prevent
              @drop.prevent="dropTrack($event, id)"
            >
              <button
                :disabled="readonly"
                :aria-label="`折叠轨道 ${id}`"
                @click="toggleTrack(id, 'collapsed')"
              >
                {{ layout.collapsed.includes(id) ? '▸' : '▾' }}</button
              ><span>{{ labels[id] }}</span>
              <nav>
                <button
                  :disabled="readonly || index === 0"
                  :aria-label="`上移轨道 ${id}`"
                  @click="reorder(id, index - 1)"
                >
                  ↑</button
                ><button
                  :disabled="readonly || index === layout.order.length - 1"
                  :aria-label="`下移轨道 ${id}`"
                  @click="reorder(id, index + 1)"
                >
                  ↓</button
                ><button
                  :disabled="readonly"
                  :aria-label="`隐藏轨道 ${id}`"
                  :aria-pressed="layout.hidden.includes(id)"
                  @click="toggleTrack(id, 'hidden')"
                >
                  {{ layout.hidden.includes(id) ? '○' : '●' }}
                </button>
              </nav>
            </div>
          </section>
        </section>
      </div>
      <div
        ref="scroller"
        class="timeline-scroll"
        data-testid="timeline-scroll"
        @scroll="syncScroll($event)"
        @pointerdown="down"
        @pointermove="move"
        @pointerup="up"
        @pointercancel="up"
      >
        <div
          class="timeline-content"
          :style="{
            width: contentWidth + 'px',
            height: 28 + layout.order.reduce((sum, id) => sum + rowHeight(id), 0) + 'px',
          }"
        >
          <div class="ruler" data-testid="timeline-ruler">
            <span v-for="mark in marks" :key="mark.x" :style="{ left: mark.x + 'px' }">{{
              mark.label
            }}</span>
          </div>
          <div class="beat-grid">
            <i
              v-for="line in beats"
              :key="line.tick"
              :class="{ major: line.major, subdivision: line.subdivision }"
              :data-tick="line.tick"
              :style="{ left: line.x + 'px' }"
            />
          </div>
          <div
            v-for="id in layout.order"
            :key="id"
            class="track-row"
            :data-track="id"
            :style="{ height: rowHeight(id) + 'px' }"
          >
            <div
              v-if="layout.hidden.includes(id) || layout.collapsed.includes(id)"
              class="track-summary"
            >
              {{ labels[id] }} ·
              {{ layout.hidden.includes(id) ? '临时隐藏（演出仍正常播放）' : '已折叠' }}
            </div>
            <template v-else>
              <div v-if="id === 'music'" class="music-track">
                <div
                  :style="{
                    width: (editor.playback.value.durationUs / 1e6) * pixelsPerSecond + 'px',
                  }"
                  class="waveform-width"
                >
                  <Waveform
                    v-if="editor.buffer.value"
                    :buffer="editor.buffer.value"
                    :pixels-per-second="pixelsPerSecond"
                  />
                </div>
                <span v-if="!editor.buffer.value" class="track-hint">导入音乐后可定位</span>
                <button
                  v-for="mark in onsetMarks"
                  :key="mark.timeUs"
                  class="onset-marker"
                  :class="{ selected: editor.analysis.selectedOnset.value === mark.timeUs }"
                  :style="{ left: mark.x + 'px' }"
                  :data-time-us="mark.timeUs"
                  :aria-label="`起音 ${(mark.timeUs / 1e6).toFixed(6)} 秒`"
                  :title="`${(mark.timeUs / 1e6).toFixed(6)} 秒 · 相对强度 ${mark.strength.toFixed(3)}${mark.count > 1 ? ' · 此列 ' + mark.count + ' 个起音' : ''}`"
                  @pointerdown.stop
                  @pointerup.stop
                  @click.stop="editor.analysis.selectOnset(mark.timeUs)"
                />
              </div>
              <NoteTrack
                v-else-if="id === 'notes'"
                :editor="editor"
                :pixels-per-second="pixelsPerSecond"
              />
              <RevealTrack
                v-else-if="id === 'layers' || id === 'outlines'"
                :editor="editor"
                :pixels-per-second="pixelsPerSecond"
                :track="id"
                @resize="rowHeights[id] = $event"
              />
              <SoundTrack
                v-else-if="id === 'sounds'"
                :editor="editor"
                :pixels-per-second="pixelsPerSecond"
                @resize="rowHeights.sounds = $event"
              />
              <CameraTrack
                v-else-if="id === 'camera'"
                :editor="editor"
                :pixels-per-second="pixelsPerSecond"
                @resize="rowHeights.camera = $event"
              />
            </template>
          </div>
          <div
            class="playhead"
            :style="{ left: headX + 'px' }"
            :data-time-us="editor.playback.value.timeUs"
            data-testid="playhead"
          >
            <i />
          </div>
        </div>
      </div>
    </div>
  </section>
</template>
