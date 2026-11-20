<script setup lang="ts">
import { computed } from 'vue';
import type { Editor } from '../state/editor';
import type { GameplayEvent } from '../../core/judgement';
import NumberField from '../panels/NumberField.vue';
const props = defineProps<{ editor: Editor }>(),
  c = props.editor.chart;
const rules = computed(() => props.editor.project.value.rules);
const disabled = computed(() => props.editor.busy.value || c.mode.value !== 'edit');
const labels = {
  pending: '等待',
  active: '追踪中',
  perfect: 'Perfect',
  good: 'Good',
  miss: 'Miss',
  complete: '完成',
  failed: '失败',
  skipped: '跳转略过',
};
const events: Record<GameplayEvent['kind'], string> = {
  'session-reset': '重置试玩',
  'circle-hit': 'Circle 命中',
  'circle-miss': 'Circle 未命中',
  'hold-start': '长按开始',
  'hold-progress': '有效长按',
  'hold-break': '长按中断',
  'hold-complete': '长按完成',
  'hold-fail': '长按失败',
  'slider-start': 'Slider 开始',
  'slider-progress': '有效追踪',
  'slider-break': '追踪中断',
  'slider-complete': 'Slider 完成',
  'slider-fail': 'Slider 失败',
};
function change(field: 'perfect' | 'good' | 'ratio' | 'hold-ratio', value: string): void {
  const next = structuredClone(rules.value),
    number = Number(value);
  if (field === 'ratio') next.sliderCompleteRatio = number / 100;
  else if (field === 'hold-ratio') next.holdCompleteRatio = number / 100;
  else {
    next.hitWindowsUs[field] = Math.round(number * 1000);
    next.hitWindowsUs.ok = Math.max(next.hitWindowsUs.ok, next.hitWindowsUs.good);
  }
  props.editor.edit({ type: 'set-rules', rules: next });
}
</script>
<template>
  <section
    v-if="c.mode.value === 'playtest'"
    class="property-section playtest-results"
    aria-label="试玩记录"
    :data-run-id="c.runtime.value?.runId"
  >
    <h2>试玩记录</h2>
    <div
      v-for="(result, id) in c.runtime.value?.results ?? {}"
      :key="id"
      class="result-item"
      :data-note-id="id"
      :data-result="result.status"
      :data-progress="result.progress"
    >
      <span
        >{{
          editor.project.value.notes[id]?.kind === 'circle'
            ? 'Circle'
            : editor.project.value.notes[id]?.kind === 'hold'
              ? '长按'
              : 'Slider'
        }}
        ·
        {{
          result.status === 'active' && editor.project.value.notes[id]?.kind === 'hold'
            ? '长按中'
            : labels[result.status]
        }}</span
      >
      <small v-if="result.errorUs !== undefined"
        >{{ result.errorUs >= 0 ? '+' : '' }}{{ (result.errorUs / 1000).toFixed(1) }} ms</small
      >
      <details v-if="editor.project.value.notes[id]?.kind !== 'circle' && result.intervals.length">
        <summary>有效 {{ (result.progress * 100).toFixed(1) }}% · 中断区间</summary>
        <p
          v-for="(interval, i) in result.intervals.filter((v) => !v.valid)"
          :key="i"
          class="help-text"
          :data-start-us="interval.startUs"
          :data-end-us="interval.endUs"
          :data-reason="interval.reason"
        >
          {{ (interval.startUs / 1000000).toFixed(3) }}–{{ (interval.endUs / 1000000).toFixed(3) }}
          秒 ·
          {{
            interval.reason === 'released'
              ? '松键'
              : interval.reason === 'late-head'
                ? '起点晚点'
                : '偏离路径'
          }}
        </p>
      </details>
    </div>
    <details class="gameplay-events">
      <summary>事件记录（最近 {{ c.events.value.length }} 条）</summary>
      <ol data-testid="gameplay-events">
        <li
          v-for="(event, i) in c.events.value"
          :key="`${event.runId}-${i}`"
          :data-kind="event.kind"
          :data-note-id="'noteId' in event ? event.noteId : undefined"
          :data-run-id="event.runId"
        >
          {{ (event.timeUs / 1000000).toFixed(3) }} · {{ events[event.kind] }}
        </li>
      </ol>
    </details>
  </section>
  <section class="property-section" aria-label="谱面判定设置">
    <h2>谱面判定</h2>
    <div class="two-fields">
      <label
        >Perfect ± ms<NumberField
          aria-label="Perfect 窗口"
          type="number"
          :precision="3"
          step="1"
          min="0"
          :disabled="disabled"
          :value="rules.hitWindowsUs.perfect / 1000"
          @commit="change('perfect', $event)" /></label
      ><label
        >Good ± ms<NumberField
          aria-label="Good 窗口"
          type="number"
          :precision="3"
          step="1"
          min="0"
          :disabled="disabled"
          :value="rules.hitWindowsUs.good / 1000"
          @commit="change('good', $event)"
      /></label>
    </div>
    <label class="stacked-label compact-label"
      >Slider 完成比例 / %<NumberField
        aria-label="Slider 完成比例"
        type="number"
        :precision="1"
        step="1"
        min="0"
        max="100"
        :disabled="disabled"
        :value="rules.sliderCompleteRatio * 100"
        @commit="change('ratio', $event)"
    /></label>
    <label
      v-if="Object.values(editor.project.value.notes).some((n) => n.kind === 'hold')"
      class="stacked-label compact-label"
      >长按完成比例 / %<NumberField
        aria-label="长按完成比例"
        type="number"
        :precision="1"
        step="1"
        min="0"
        max="100"
        :disabled="disabled"
        :value="(rules.holdCompleteRatio ?? 0.95) * 100"
        @commit="change('hold-ratio', $event)"
    /></label>
    <p class="help-text">
      超过 Good 窗口为 Miss。Slider 先点中起点，随后按住鼠标或 Z /
      X，跟随滑球。比例按音乐时长计算。跳转会重建判定会话；图层演出保留跳转点之前的真实操作，之后的记录丢弃。暂停后继续需重新按住。
    </p>
  </section>
</template>
