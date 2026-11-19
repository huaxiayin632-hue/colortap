<script setup lang="ts">
import { computed } from 'vue';
import type { Editor } from '../state/editor';
const props = defineProps<{ editor: Editor }>(),
  c = props.editor.chart;
const active = computed(() =>
  Object.entries(c.runtime.value?.results ?? {}).find(([, n]) => n.status === 'active'),
);
const feedback = computed(() =>
  c.feedback.value && c.timeUs.value - c.feedback.value.timeUs < 800000 ? c.feedback.value : null,
);
</script>
<template>
  <div v-if="c.mode.value !== 'edit'" class="chart-hud">
    <template v-if="c.mode.value === 'playtest'">
      <div class="judgement-counts" data-testid="judgement-counts">
        <span>Perfect {{ c.runtime.value?.counts.perfect ?? 0 }}</span
        ><span>Good {{ c.runtime.value?.counts.good ?? 0 }}</span
        ><span>Miss {{ c.runtime.value?.counts.miss ?? 0 }}</span
        ><span
          >Slider {{ c.runtime.value?.counts.complete ?? 0 }} /
          {{ c.runtime.value?.counts.failed ?? 0 }}</span
        ><span v-if="Object.values(editor.project.value.notes).some((n) => n.kind === 'hold')"
          >长按 {{ c.runtime.value?.counts.holdComplete ?? 0 }} /
          {{ c.runtime.value?.counts.holdFailed ?? 0 }}</span
        >
      </div>
      <div
        v-if="active"
        class="tracking-status"
        data-testid="tracking-status"
        :data-valid="active[1].valid"
      >
        {{
          editor.project.value.notes[active[0]]?.kind === 'hold'
            ? active[1].valid
              ? '有效长按'
              : '长按中断'
            : active[1].valid
              ? '有效追踪'
              : '追踪中断'
        }}
        · {{ (active[1].progress * 100).toFixed(1) }}%
      </div>
      <div
        v-if="feedback"
        class="judgement-feedback"
        :class="feedback.kind"
        data-testid="judgement-feedback"
        :data-grade="feedback.kind"
      >
        {{ feedback.label }}
      </div>
    </template>
    <div v-if="!editor.playback.value.playing" class="playtest-help">
      {{
        editor.playback.value.ready
          ? '空格 / 播放继续 · Z / X 或鼠标输入'
          : '先导入音乐，再开始播放'
      }}
    </div>
  </div>
</template>
