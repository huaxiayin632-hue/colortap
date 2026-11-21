<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { useCommands } from '../commands/registry';
import type { Editor } from '../state/editor';
import { formatTime, minimumLoopUs, type LoopRange } from '../../core/timing';
import { onsetIndex, type SnapMode } from '../../core/note-alignment';
import Waveform from './Waveform.vue';
import NoteTrack from './NoteTrack.vue';
import RevealTrack from './RevealTrack.vue';
import SoundTrack from './SoundTrack.vue';
import CameraTrack from './CameraTrack.vue';
import { defaultTracks, type TrackId, type TrackLayout } from '../../shared/models';

const loopDraft = ref<LoopRange | null>(null);
const emit = defineEmits<{ collapse: [] }>();
const props = defineProps<{ editor: Editor }>();
const scroller = ref<HTMLDivElement>();
const labelScroller = ref<HTMLElement>();
const commands = useCommands();
const preferences = commands.timelinePreferences;
const pixelsPerSecond = computed(() => preferences.value.zoom);
const suspended = ref(false),
  interacting = ref(false);
let expectedScroll = 0;
function suspendFollow() {
  suspended.value = true;
}
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
  if (!source.clientWidth) return;
  const target = fromLabels ? scroller.value : labelScroller.value;
  if (target && Math.abs(target.scrollTop - source.scrollTop) > 0.5)
    target.scrollTop = source.scrollTop;
  if (!fromLabels) {
    if (Math.abs(source.scrollLeft - expectedScroll) > 1) suspendFollow();
    scrollLeft.value = source.scrollLeft;
    expectedScroll = source.scrollLeft;
  }
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
const beatLabel = computed(() => {
  const position = props.editor.tempo.value.barBeat(props.editor.playback.value.timeUs);
  return `${position.bar} : ${position.beat}`;
});
const marks = computed(() => {
  if (preferences.value.ruler === 'bars') {
    const lines = props.editor.tempo.value.barMarks(
      (scrollLeft.value / pixelsPerSecond.value) * 1e6,
      ((scrollLeft.value + visibleWidth.value) / pixelsPerSecond.value) * 1e6,
      75e6 / pixelsPerSecond.value,
    );
    let lastX = -Infinity;
    return lines
      .filter((line) => {
        const x = (line.timeUs / 1e6) * pixelsPerSecond.value;
        if (x - lastX < 70) return false;
        lastX = x;
        return true;
      })
      .map((line) => ({
        x: (line.timeUs / 1e6) * pixelsPerSecond.value,
        label: `${line.bar}:${line.beat}`,
      }));
  }
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
const shownLoop = computed(() => loopDraft.value ?? props.editor.loopRange.value);
let loopDrag: { pointerId: number; fixed: number; offsetX: number } | null = null;
function timeAtX(event: MouseEvent, offsetX = 0) {
  const el = scroller.value!;
  const raw =
    ((event.clientX - offsetX - el.getBoundingClientRect().left + el.scrollLeft) /
      pixelsPerSecond.value) *
    1e6;
  const time = props.editor.tempo.value.resolve(
    props.editor.chart.resolveMoment(raw, event.altKey),
  );
  return Math.round(Math.max(0, Math.min(props.editor.playback.value.durationUs, time)));
}
function loopDown(event: PointerEvent, endpoint?: 'startUs' | 'endUs') {
  if (event.button !== 0 || !props.editor.playback.value.ready || props.editor.busy.value) return;
  event.preventDefault();
  event.stopPropagation();
  const original = props.editor.loopRange.value,
    at = timeAtX(event);
  loopDrag = {
    pointerId: event.pointerId,
    fixed: endpoint && original ? original[endpoint === 'startUs' ? 'endUs' : 'startUs'] : at,
    offsetX:
      endpoint && original
        ? event.clientX -
          scroller.value!.getBoundingClientRect().left +
          scroller.value!.scrollLeft -
          (original[endpoint] / 1e6) * pixelsPerSecond.value
        : 0,
  };
  loopDraft.value = endpoint && original ? { ...original } : { startUs: at, endUs: at };
  scroller.value!.setPointerCapture(event.pointerId);
}
function loopMove(event: PointerEvent) {
  if (loopDrag?.pointerId !== event.pointerId) return;
  const at = timeAtX(event, loopDrag.offsetX),
    fixed = loopDrag.fixed;
  loopDraft.value = { startUs: Math.min(at, fixed), endUs: Math.max(at, fixed) };
}
function loopUp(event: PointerEvent, cancel = false) {
  if (loopDrag?.pointerId !== event.pointerId) return;
  const next = loopDraft.value;
  loopDrag = null;
  loopDraft.value = null;
  if (scroller.value?.hasPointerCapture(event.pointerId))
    scroller.value.releasePointerCapture(event.pointerId);
  if (!cancel && next && next.endUs - next.startUs >= minimumLoopUs) props.editor.setLoop(next);
  else if (!cancel) props.editor.notify('循环区间至少需要 0.1 秒', 'warning');
}
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
  if (event.button !== 0 || isScrollbar(event) || !props.editor.playback.value.ready) return;
  scrubbing = { pointerId: event.pointerId, resume: props.editor.playback.value.playing };
  props.editor.pause();
  scroller.value?.setPointerCapture(event.pointerId);
  seekAt(event);
}
function move(event: PointerEvent): void {
  if (loopDrag) loopMove(event);
  else if (scrubbing?.pointerId === event.pointerId) seekAt(event);
}
function up(event: PointerEvent, cancelled = false): void {
  if (loopDrag) {
    loopUp(event, cancelled);
    return;
  }
  if (scrubbing?.pointerId !== event.pointerId) return;
  const resume = scrubbing.resume;
  scrubbing = null;
  if (scroller.value?.hasPointerCapture(event.pointerId))
    scroller.value.releasePointerCapture(event.pointerId);
  if (resume && !cancelled) void props.editor.togglePlay();
}
function setScroll(left: number) {
  const el = scroller.value;
  if (!el || !el.clientWidth) return;
  el.scrollLeft = Math.max(0, Math.min(Math.max(0, el.scrollWidth - el.clientWidth), left));
  expectedScroll = scrollLeft.value = el.scrollLeft;
}
async function zoomAt(value: number, anchorX = visibleWidth.value / 2) {
  const el = scroller.value;
  if (!el || !el.clientWidth) return;
  suspendFollow();
  const seconds = (el.scrollLeft + anchorX) / pixelsPerSecond.value;
  preferences.value.zoom = Math.max(8, Math.min(200, value));
  await nextTick();
  setScroll(seconds * pixelsPerSecond.value - anchorX);
}
function wheel(event: WheelEvent) {
  if (interacting.value) {
    if (event.ctrlKey || event.shiftKey) event.preventDefault();
    return;
  }
  const el = scroller.value;
  if (!el || !el.clientWidth) return;
  const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? el.clientWidth : 1;
  if (event.ctrlKey) {
    event.preventDefault();
    event.stopPropagation();
    const anchor = Math.max(
      0,
      Math.min(el.clientWidth, event.clientX - el.getBoundingClientRect().left),
    );
    void zoomAt(pixelsPerSecond.value * Math.exp(-event.deltaY * unit * 0.002), anchor);
  } else if (event.shiftKey) {
    event.preventDefault();
    event.stopPropagation();
    suspendFollow();
    setScroll(
      el.scrollLeft +
        (Math.abs(event.deltaX) > Math.abs(event.deltaY) ? event.deltaX : event.deltaY) * unit,
    );
  } else if (event.deltaX || event.deltaY) suspendFollow();
}
let pan: { pointerId: number; x: number; left: number } | null = null;
function isScrollbar(event: MouseEvent) {
  const el = scroller.value;
  if (!el) return false;
  const box = el.getBoundingClientRect();
  return event.clientX >= box.left + el.clientWidth || event.clientY >= box.top + el.clientHeight;
}
function pointerHeld() {
  interacting.value = true;
}
function pointerStart(event: PointerEvent) {
  if (event.button !== 0 && event.button !== 1) return;
  scroller.value?.focus({ preventScroll: true });
  interacting.value = true;
  if (event.button === 1) {
    event.preventDefault();
    event.stopPropagation();
    suspendFollow();
    pan = { pointerId: event.pointerId, x: event.clientX, left: scroller.value!.scrollLeft };
    scroller.value!.setPointerCapture(event.pointerId);
  } else if (isScrollbar(event)) suspendFollow();
}
function pointerMove(event: PointerEvent) {
  if (pan?.pointerId !== event.pointerId) return;
  event.preventDefault();
  event.stopPropagation();
  setScroll(pan.left - (event.clientX - pan.x));
}
function endPan(event?: PointerEvent) {
  if (event && pan && pan.pointerId !== event.pointerId) return;
  const id = pan?.pointerId;
  pan = null;
  interacting.value = false;
  if (id !== undefined && scroller.value?.hasPointerCapture(id))
    scroller.value.releasePointerCapture(id);
}
function lostCapture(event: PointerEvent) {
  endPan(event);
  if (loopDrag?.pointerId === event.pointerId) loopUp(event, true);
  if (scrubbing?.pointerId === event.pointerId) up(event, true);
}
function blur() {
  endPan();
  const loopId = loopDrag?.pointerId;
  loopDrag = null;
  loopDraft.value = null;
  if (loopId !== undefined && scroller.value?.hasPointerCapture(loopId))
    scroller.value.releasePointerCapture(loopId);
  if (scrubbing) {
    const id = scrubbing.pointerId;
    scrubbing = null;
    if (scroller.value?.hasPointerCapture(id)) scroller.value.releasePointerCapture(id);
  }
}
function reveal(timeUs: number) {
  const el = scroller.value;
  if (!el?.clientWidth) return;
  const x = (timeUs / 1e6) * pixelsPerSecond.value;
  const page = Math.max(1, el.clientWidth - 32);
  if (x < el.scrollLeft || x > el.scrollLeft + el.clientWidth - 20)
    setScroll(Math.floor(x / page) * page);
}
function jumpToHead() {
  suspended.value = false;
  setScroll(headX.value - visibleWidth.value / 3);
}
watch(
  () => preferences.value.follow,
  () => {
    suspended.value = false;
    if (preferences.value.follow) reveal(props.editor.playback.value.timeUs);
  },
);
watch([headX, visibleWidth, () => props.editor.playback.value.playing], () => {
  if (
    preferences.value.follow &&
    !suspended.value &&
    !interacting.value &&
    props.editor.playback.value.playing
  )
    reveal(props.editor.playback.value.timeUs);
});
watch(
  () => props.editor.project.value.id,
  async () => {
    blur();
    suspended.value = false;
    await nextTick();
    setScroll(0);
  },
);
watch(contentWidth, async () => {
  await nextTick();
  setScroll(scrollLeft.value);
});
let observer: ResizeObserver | null = null;
onMounted(() => {
  commands.timeline.value = {
    canNavigate: () =>
      !interacting.value && !scrubbing && !pan && !loopDrag && Boolean(scroller.value?.clientWidth),
    reveal,
    locate: jumpToHead,
  };
  observer = new ResizeObserver(() => {
    // Hidden panels retain their viewport until they become visible again.
    if (scroller.value?.clientWidth) {
      visibleWidth.value = scroller.value.clientWidth;
      setScroll(scrollLeft.value);
    }
  });
  if (scroller.value) observer.observe(scroller.value);
  window.addEventListener('pointerdown', pointerHeld, true);
  window.addEventListener('pointerup', endPan, true);
  window.addEventListener('pointercancel', endPan, true);
  window.addEventListener('blur', blur);
});
onBeforeUnmount(() => {
  observer?.disconnect();
  blur();
  commands.timeline.value = null;
  window.removeEventListener('pointerdown', pointerHeld, true);
  window.removeEventListener('pointerup', endPan, true);
  window.removeEventListener('pointercancel', endPan, true);
  window.removeEventListener('blur', blur);
});
</script>

<template>
  <section class="timeline-panel" aria-label="时间轴">
    <header class="timeline-toolbar">
      <button aria-label="收起时间轴" @click="emit('collapse')">▾</button><strong>时间轴</strong
      ><span class="beat-readout" title="小节 : 拍；首拍前向前延伸编号，拍号变化另起小节">{{
        beatLabel
      }}</span>
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
        <option :value="3">1/3 拍</option>
        <option :value="6">1/6 拍</option>
        <option :value="12">1/12 拍</option>
      </select>
      <label
        >标尺<select
          aria-label="时间标尺"
          :value="preferences.ruler"
          @change="commands.run('timeline.ruler.' + ($event.target as HTMLSelectElement).value)"
        >
          <option value="time">分:秒</option>
          <option value="bars">小节:拍</option>
        </select></label
      >
      <span class="toolbar-spacer" />
      <button
        aria-label="播放头跟随"
        :aria-pressed="preferences.follow"
        :data-follow-state="!preferences.follow ? 'off' : suspended ? 'paused' : 'on'"
        title="翻页跟随；手动浏览后暂停，定位播放头或重新开启可恢复"
        @click="commands.run('timeline.follow')"
      >
        {{ !preferences.follow ? '跟随关闭' : suspended ? '跟随已暂停' : '跟随开启' }}
      </button>
      <button @click="commands.run('timeline.locate')">定位播放头</button
      ><label class="timeline-zoom"
        >时间缩放<input
          aria-label="时间轴缩放"
          type="range"
          min="8"
          max="200"
          :value="pixelsPerSecond"
          @input="zoomAt(Number(($event.target as HTMLInputElement).value))"
      /></label>
    </header>
    <div class="loop-toolbar">
      <button
        aria-label="循环播放"
        :aria-pressed="editor.loopEnabled.value && !editor.loopSuspended.value"
        :disabled="!commands.enabled('play.loop')"
        @click="commands.run('play.loop')"
      >
        {{
          editor.loopSuspended.value
            ? '循环已暂停 · 重新启用'
            : editor.loopEnabled.value
              ? '循环开启'
              : '循环关闭'
        }}
      </button>
      <button :disabled="!editor.loopRange.value" @click="commands.run('play.loopClear')">
        清除循环
      </button>
      <span v-if="editor.loopRange.value"
        >A {{ formatTime(editor.loopRange.value.startUs) }} — B
        {{ formatTime(editor.loopRange.value.endUs) }}</span
      >
      <span v-else>在标尺下拖选区间 · 至少 0.1 秒</span>
      <span v-if="editor.loopSuspended.value">已定位到区间外</span>
      <output
        data-testid="practice-state"
        :data-cycle="editor.playback.value.cycle"
        :data-rate="editor.playback.value.rate"
        :data-loop="editor.loopEnabled.value && !editor.loopSuspended.value"
        >{{
          editor.loopEnabled.value && !editor.loopSuspended.value
            ? '第 ' + (editor.playback.value.cycle + 1) + ' 轮'
            : ''
        }}</output
      >
    </div>
    <div class="timeline-tracks production-tracks" @wheel.capture="wheel">
      <div class="track-labels">
        <div class="ruler-label practice-ruler-label">
          {{ preferences.ruler === 'time' ? '分 : 秒' : '小节 : 拍' }}
        </div>
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
        tabindex="0"
        aria-label="时间轴导航"
        :data-zoom="pixelsPerSecond"
        :data-scroll-left="scrollLeft"
        :data-ruler="preferences.ruler"
        @pointerdown.capture="pointerStart"
        @pointermove.capture="pointerMove"
        @lostpointercapture.capture="lostCapture"
        @auxclick.middle.prevent
        @scroll="syncScroll($event)"
        @pointerdown="down"
        @pointermove="move"
        @pointerup="up"
        @pointercancel="up($event, true)"
      >
        <div
          class="timeline-content"
          :style="{
            width: contentWidth + 'px',
            height: 54 + layout.order.reduce((sum, id) => sum + rowHeight(id), 0) + 'px',
          }"
        >
          <div class="ruler" data-testid="timeline-ruler">
            <span v-for="mark in marks" :key="mark.x" :style="{ left: mark.x + 'px' }">{{
              mark.label
            }}</span>
          </div>
          <div
            class="loop-lane"
            data-testid="loop-lane"
            @pointerdown.stop="loopDown($event)"
            @contextmenu.prevent.stop
          >
            <span class="loop-hint">拖选循环 A–B · Alt 暂时不吸附</span>
            <div
              v-if="shownLoop"
              class="loop-range"
              :class="{ enabled: editor.loopEnabled.value && !editor.loopSuspended.value }"
              :style="{
                left: (shownLoop.startUs / 1e6) * pixelsPerSecond + 'px',
                width: ((shownLoop.endUs - shownLoop.startUs) / 1e6) * pixelsPerSecond + 'px',
              }"
              :data-start-us="shownLoop.startUs"
              :data-end-us="shownLoop.endUs"
            >
              <button
                aria-label="调整循环起点"
                class="loop-end start"
                @pointerdown.stop="loopDown($event, 'startUs')"
              >
                A
              </button>
              <span>{{ ((shownLoop.endUs - shownLoop.startUs) / 1e6).toFixed(2) }} 秒</span>
              <button
                aria-label="调整循环终点"
                class="loop-end end"
                @pointerdown.stop="loopDown($event, 'endUs')"
              >
                B
              </button>
            </div>
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

<style>
.loop-toolbar {
  display: flex;
  align-items: center;
  gap: 10px;
  min-height: 30px;
  flex-shrink: 0;
  padding: 2px 10px;
  font-size: 11px;
  flex-wrap: wrap;
  border-bottom: 1px solid var(--border);
}
.loop-toolbar button {
  font-size: 11px;
}
.loop-toolbar button[aria-pressed='true'] {
  background: #3b5a64;
}
.loop-toolbar output {
  margin-left: auto;
  color: var(--muted);
}
.track-labels .practice-ruler-label {
  height: 54px;
  min-height: 54px;
}
.loop-lane {
  position: sticky;
  top: 28px;
  height: 26px;
  background: #252c33;
  border-bottom: 1px solid #586470;
  z-index: 3;
  cursor: crosshair;
}
.loop-hint {
  font-size: 10px;
  color: #82909b;
  margin-left: 10px;
}
.loop-range {
  position: absolute;
  top: 2px;
  bottom: 2px;
  min-width: 2px;
  background: #5e707a;
  border: 1px solid #8faab7;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 10px;
  white-space: nowrap;
}
.loop-range.enabled {
  background: #3c6b70;
  border-color: #91d7db;
}
.loop-end {
  position: absolute;
  top: -1px;
  height: 22px;
  width: 14px;
  padding: 0;
  font-size: 10px;
  background: #698d94;
  cursor: ew-resize;
}
.loop-end.start {
  left: -1px;
}
.loop-end.end {
  right: -1px;
}
.production-tracks .beat-grid {
  top: 54px;
}
.playback-rate {
  display: flex;
  align-items: center;
  gap: 4px;
  font-size: 11px;
}
.playback-rate select {
  width: 66px;
}

.timeline-toolbar {
  height: auto;
  min-height: 39px;
  flex-shrink: 0;
  flex-wrap: wrap;
  gap: 6px 10px;
  padding: 4px 10px;
}
.timeline-toolbar button[aria-pressed='true'] {
  background: #3b5a64;
  color: #ddf6fc;
}
.timeline-scroll:focus-visible {
  outline: 1px solid var(--accent);
  outline-offset: -2px;
}
</style>
