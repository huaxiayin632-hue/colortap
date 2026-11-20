<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import type { Editor } from '../state/editor';
import type { TempoCandidate } from '../../shared/audio-analysis';
import type { TimingMap } from '../../shared/models';
import NumberField from '../panels/NumberField.vue';

const props = defineProps<{ editor: Editor }>(),
  c = props.editor.chart,
  a = props.editor.analysis;
const readonly = computed(() => props.editor.busy.value || c.mode.value !== 'edit');
const timing = computed(() => props.editor.project.value.timing);
const bpm = ref(timing.value.points[0].bpm),
  offsetMs = ref(timing.value.beatZeroUs / 1000);
function candidate(value: TempoCandidate) {
  bpm.value = value.bpm;
  offsetMs.value = value.phaseUs / 1000;
}
watch(timing, (value) => {
  bpm.value = value.points[0].bpm;
  offsetMs.value = value.beatZeroUs / 1000;
});
watch(
  a.result,
  (value) => {
    if (value?.suggestion) candidate(value.suggestion);
  },
  { immediate: true },
);
function number(value: string, set: (value: number) => void) {
  const n = Number(value);
  if (Number.isFinite(n)) set(n);
}
function setTiming(value: TimingMap) {
  props.editor.edit({ type: 'set-timing', timing: value });
}
function apply() {
  if (!(bpm.value > 0) || !Number.isFinite(offsetMs.value)) return;
  setTiming({
    ...timing.value,
    beatZeroUs: Math.round(offsetMs.value * 1000),
    points: timing.value.points.map((p, i) => (i === 0 ? { ...p, bpm: bpm.value } : p)),
  });
}
function patchPoint(id: string, field: 'tick' | 'bpm', value: string) {
  number(value, (n) =>
    setTiming({
      ...timing.value,
      points: timing.value.points
        .map((p) =>
          p.id === id ? { ...p, [field]: field === 'tick' ? Math.round(n * 960) : n } : p,
        )
        .sort((a, b) => a.tick - b.tick),
    }),
  );
}
function addPoint() {
  const tick = Math.max(
    0,
    Math.round(c.tempo.value.timeToTick(props.editor.playback.value.timeUs)),
  );
  if (timing.value.points.some((p) => p.tick === tick)) {
    props.editor.notify('该拍已有 BPM 点，可直接修改', 'info');
    return;
  }
  const previous =
    timing.value.points.filter((p) => p.tick < tick).at(-1) ?? timing.value.points[0];
  setTiming({
    ...timing.value,
    points: [...timing.value.points, { ...previous, id: crypto.randomUUID(), tick }].sort(
      (a, b) => a.tick - b.tick,
    ),
  });
}
const target = ref<'head' | 'tail'>('head');
const plan = computed(() => c.alignmentPlan(target.value));
const matched = computed(() => plan.value.filter((p) => p.toUs !== null).length);
const changes = computed(() => plan.value.filter((p) => p.edit).length);
const labels = {
  'quiet-audio': '包含长静音',
  'insufficient-rhythm': '节奏证据不足',
  'tempo-change': '检测到变速，请分段校正',
  'metrical-ambiguity': '存在半速／倍速歧义',
};
</script>
<template>
  <section class="property-section analysis-panel" aria-label="音乐卡点辅助">
    <h2>音乐卡点辅助</h2>
    <div class="note-actions">
      <button
        :disabled="!editor.buffer.value || editor.busy.value || a.running.value"
        @click="a.analyze()"
      >
        {{ a.result.value ? '重新分析音乐' : '分析音乐' }}
      </button>
      <button v-if="a.running.value" @click="a.cancel()">取消分析</button>
    </div>
    <p v-if="a.progress.value" role="status" data-testid="analysis-progress">
      {{ { copy: '复制音频', spectrum: '检测起音', rhythm: '拟合节奏' }[a.progress.value.phase] }}
      {{ Math.round(a.progress.value.fraction * 100) }}%<span
        v-if="a.progress.value.phase === 'rhythm' && a.progress.value.fraction === 1"
      >
        · 正在提交结果</span
      >
    </p>
    <p class="help-text">
      分析只更新建议，不移动音符。蓝灰为波形、蓝色为节拍网格、橙色为起音。点击起音可精确定位。
    </p>
    <p v-if="a.result.value" data-testid="analysis-summary">
      {{ a.result.value.onsets.length }} 个起音 · {{ a.result.value.algorithm }}
    </p>
    <p v-for="warning in a.result.value?.warnings" :key="warning" class="help-text">
      {{ labels[warning] }}
    </p>
    <div class="analysis-candidates" v-if="a.result.value?.tempos.length">
      <span>节奏候选（点击只载入草稿）</span>
      <button
        v-for="(item, index) in a.result.value.tempos"
        :key="index"
        :disabled="readonly"
        @click="candidate(item)"
      >
        {{ item.bpm.toFixed(3) }} BPM · 支持 {{ item.support.toFixed(2) }}
      </button>
    </div>
    <div class="two-fields">
      <label
        >初始 BPM<NumberField
          aria-label="建议 BPM"
          type="number"
          :precision="3"
          :live="false"
          min="0.001"
          step="0.001"
          :disabled="readonly"
          :value="bpm"
          @commit="
            number($event, (n) => {
              if (n > 0) bpm = n;
            })
          "
      /></label>
      <label
        >Offset / 毫秒<NumberField
          aria-label="建议 Offset"
          type="number"
          :precision="3"
          :live="false"
          step="0.001"
          :disabled="readonly"
          :value="offsetMs"
          @commit="number($event, (n) => (offsetMs = n))"
      /></label>
    </div>
    <div class="note-actions">
      <button :disabled="readonly" @click="bpm /= 2">半速</button
      ><button :disabled="readonly" @click="bpm *= 2">倍速</button>
      <button
        :disabled="readonly || !editor.playback.value.ready"
        @click="offsetMs = editor.playback.value.timeUs / 1000"
      >
        播放头作第零拍
      </button>
      <button
        :disabled="readonly || a.selectedOnset.value === null"
        @click="offsetMs = a.selectedOnset.value! / 1000"
      >
        起音作第零拍
      </button>
    </div>
    <p v-if="a.selectedOnset.value !== null">
      选定起音：{{ (a.selectedOnset.value / 1e6).toFixed(6) }} 秒
    </p>
    <button :disabled="readonly" @click="apply">采用 BPM/Offset</button>
    <p class="help-text">
      采用后，按节拍保存的音符、时长和演出随网格联动；固定时间内容保持位置。仅修改初始
      BPM，后续变速点保留。候选相位不代表小节第一拍，也不补偿设备延迟。
    </p>
  </section>
  <section class="property-section" aria-label="变速点">
    <h2>已采用节奏</h2>
    <div v-for="(point, index) in timing.points" :key="point.id" class="tempo-point">
      <label
        >拍位置（0 起）<NumberField
          :aria-label="`节奏点 ${index + 1} 拍位置`"
          type="number"
          :precision="3"
          min="0"
          step="0.001"
          :disabled="readonly || index === 0"
          :value="point.tick / 960"
          @commit="patchPoint(point.id, 'tick', $event)"
      /></label>
      <label
        >BPM<NumberField
          :aria-label="`节奏点 ${index + 1} BPM`"
          type="number"
          :precision="3"
          min="0.001"
          step="0.001"
          :disabled="readonly"
          :value="point.bpm"
          @commit="patchPoint(point.id, 'bpm', $event)"
      /></label>
      <button
        :aria-label="`删除节奏点 ${index + 1}`"
        :disabled="readonly || index === 0"
        @click="setTiming({ ...timing, points: timing.points.filter((p) => p.id !== point.id) })"
      >
        ×
      </button>
    </div>
    <button :disabled="readonly || !editor.playback.value.ready" @click="addPoint">
      在播放头添加变速点
    </button>
    <details v-if="a.result.value?.regions.some((r) => r.tempos.length)">
      <summary>检测分段参考</summary>
      <p
        v-for="region in a.result.value.regions.filter((r) => r.tempos.length)"
        :key="region.startUs"
        class="help-text"
      >
        {{ (region.startUs / 1e6).toFixed(1) }}–{{ (region.endUs / 1e6).toFixed(1) }} 秒：{{
          region.tempos.map((t) => t.bpm.toFixed(2)).join(' / ')
        }}
        BPM
      </p>
    </details>
  </section>
  <section class="property-section" aria-label="起音对齐">
    <h2>起音对齐</h2>
    <label
      >搜索范围 / 毫秒<NumberField
        aria-label="起音吸附范围"
        type="number"
        :precision="3"
        :live="false"
        min="0"
        max="500"
        step="1"
        :value="c.onsetToleranceUs.value / 1000"
        @commit="
          number($event, (n) => {
            if (n >= 0 && n <= 500) c.onsetToleranceUs.value = Math.round(n * 1000);
          })
        "
    /></label>
    <label class="stacked-label"
      >对齐位置<select v-model="target" aria-label="对齐位置">
        <option value="head">音符起点</option>
        <option value="tail">长音符尾端</option>
      </select></label
    >
    <p class="help-text">
      智能起音仅在范围内吸附；范围外保持原位置，Alt
      暂停吸附。选择音符本身不会移动。起点对齐保留原时长类型；尾端对齐使用固定秒时长。
    </p>
    <p data-testid="alignment-summary">
      已选 {{ c.selected.value.length }} 个 · 匹配 {{ matched }} 个 · 未匹配
      {{ plan.length - matched }} 个 · 待修改 {{ changes }} 个
    </p>
    <ul class="alignment-preview" v-if="plan.length">
      <li v-for="entry in plan.slice(0, 20)" :key="entry.id" :data-note-id="entry.id">
        {{ (entry.fromUs / 1e6).toFixed(6) }} 秒 →
        {{
          entry.toUs === null
            ? '范围内无起音'
            : (entry.toUs / 1e6).toFixed(6) +
              ' 秒（' +
              ((entry.toUs - entry.fromUs) / 1000).toFixed(3) +
              ' ms）'
        }}<small v-if="entry.edit && target === 'head' && entry.endBeforeUs !== entry.fromUs"
          >结束：{{ (entry.endBeforeUs / 1e6).toFixed(6) }} →
          {{ (entry.endAfterUs / 1e6).toFixed(6) }} 秒</small
        >
      </li>
    </ul>
    <p v-if="plan.length > 20" class="help-text">
      另有 {{ plan.length - 20 }} 个；应用范围包含全部所选音符。
    </p>
    <button :disabled="readonly || !changes" @click="c.alignSelected(target)">
      对齐所选（一次撤销）
    </button>
    <p class="help-text">
      组拖动只吸附抓取的音符，其余跟随；节拍模式按整数 tick
      舍入。精确人工校正可关闭吸附后输入音符时间。
    </p>
  </section>
</template>
