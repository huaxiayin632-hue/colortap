<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from 'vue';
import type { Editor } from '../state/editor';
import { formatTime } from '../../core/timing';
import Waveform from './Waveform.vue';

const props = defineProps<{ editor: Editor }>();
const scroller = ref<HTMLDivElement>();
const pixelsPerSecond = ref(44);
const snap = ref(true),
  divisions = ref(4);
const scrollLeft = ref(0),
  visibleWidth = ref(1000);
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
  const start = Math.max(0, Math.floor(tempo.timeToTick(startUs) / 960));
  const end = Math.ceil(tempo.timeToTick(endUs) / 960);
  const projectedBeat =
    (60 / props.editor.project.value.timing.points[0].bpm) * pixelsPerSecond.value;
  const stride = Math.max(1, Math.ceil(8 / projectedBeat));
  const result: { x: number; major: boolean; key: number }[] = [];
  for (let n = Math.floor(start / stride) * stride; n <= end; n += stride)
    result.push({
      x: (tempo.tickToTime(n * 960) / 1_000_000) * pixelsPerSecond.value,
      major: n % 4 === 0,
      key: n,
    });
  return result;
});
let scrubbing: { pointerId: number; resume: boolean } | null = null;
function seekAt(event: PointerEvent): void {
  if (!scroller.value || !props.editor.playback.value.ready) return;
  const rect = scroller.value.getBoundingClientRect();
  let timeUs = Math.round(
    ((event.clientX - rect.left + scroller.value.scrollLeft) / pixelsPerSecond.value) * 1_000_000,
  );
  if (snap.value && !event.altKey) timeUs = props.editor.tempo.value.snap(timeUs, divisions.value);
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
    visibleWidth.value = scroller.value?.clientWidth ?? 1000;
  });
  if (scroller.value) observer.observe(scroller.value);
});
onBeforeUnmount(() => observer?.disconnect());
</script>

<template>
  <section class="timeline-panel" aria-label="时间轴">
    <header class="timeline-toolbar">
      <strong>时间轴</strong>
      <span class="beat-readout">第 {{ beatLabel }} 拍</span>
      <label class="checkbox-label"><input v-model="snap" type="checkbox" />节拍吸附</label>
      <select v-model="divisions" aria-label="节拍细分">
        <option :value="1">1 拍</option>
        <option :value="2">1/2 拍</option>
        <option :value="4">1/4 拍</option>
        <option :value="8">1/8 拍</option>
        <option :value="16">1/16 拍</option>
      </select>
      <span class="toolbar-spacer" />
      <button @click="jumpToHead">定位播放头</button>
      <label class="timeline-zoom"
        >时间缩放<input
          aria-label="时间轴缩放"
          type="range"
          min="8"
          max="200"
          :value="pixelsPerSecond"
          @input="zoomAtHead(Number(($event.target as HTMLInputElement).value))"
      /></label>
    </header>
    <div class="timeline-tracks">
      <div class="track-labels">
        <div class="ruler-label">分 : 秒</div>
        <div class="music-label"><i class="track-dot music-dot" /><span>音乐</span></div>
        <div><i class="track-dot note-dot" /><span>谱面</span></div>
        <div><i class="track-dot layer-dot" /><span>图层演出</span></div>
        <div><i class="track-dot sound-dot" /><span>音效</span></div>
        <div><i class="track-dot camera-dot" /><span>镜头</span></div>
      </div>
      <div
        ref="scroller"
        class="timeline-scroll"
        data-testid="timeline-scroll"
        @scroll="scrollLeft = ($event.target as HTMLElement).scrollLeft"
        @pointerdown="down"
        @pointermove="move"
        @pointerup="up"
        @pointercancel="up"
      >
        <div class="timeline-content" :style="{ width: contentWidth + 'px' }">
          <div class="ruler" data-testid="timeline-ruler">
            <span v-for="mark in marks" :key="mark.x" :style="{ left: mark.x + 'px' }">{{
              mark.label
            }}</span>
          </div>
          <div class="beat-grid">
            <i
              v-for="line in beats"
              :key="line.key"
              :class="{ major: line.major }"
              :style="{ left: line.x + 'px' }"
            />
          </div>
          <div class="music-track">
            <div
              :style="{
                width: (editor.playback.value.durationUs / 1_000_000) * pixelsPerSecond + 'px',
              }"
              class="waveform-width"
            >
              <Waveform
                v-if="editor.buffer.value"
                :buffer="editor.buffer.value"
                :pixels-per-second="pixelsPerSecond"
              />
            </div>
            <span v-if="!editor.buffer.value" class="track-hint">导入音乐后可点击或拖动定位</span>
          </div>
          <div class="future-track"><span>Circle / Slider 在后续阶段接入</span></div>
          <div class="future-track" />
          <div class="future-track" />
          <div class="future-track" />
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
