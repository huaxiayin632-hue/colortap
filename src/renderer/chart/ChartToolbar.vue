<script setup lang="ts">
import type { Editor } from '../state/editor';
import type { ChartTool } from './controller';
defineProps<{ editor: Editor }>();
const tools: { id: ChartTool; label: string; key: string; help: string }[] = [
  { id: 'layers', label: '图层', key: 'L', help: '选择和移动插画图层' },
  { id: 'select', label: '选择', key: 'V', help: '选择、拖动音符；Shift 多选；空白处框选' },
  { id: 'circle', label: 'Circle', key: 'C', help: '点击画布，在播放头时间添加 Circle' },
  {
    id: 'slider',
    label: 'Slider',
    key: 'S',
    help: '钢笔：点击放锚点，按住拖出切线；Enter 或双击完成，Esc 取消',
  },
  { id: 'path', label: '路径', key: 'P', help: '选中 Slider，拖动方形节点或圆形控制柄；双击添点' },
];
</script>
<template>
  <div class="chart-toolbar" aria-label="谱面工具">
    <template v-if="editor.chart.mode.value === 'edit'">
      <button
        v-for="t in tools"
        :key="t.id"
        :aria-label="`${t.label} 工具`"
        :aria-pressed="editor.chart.tool.value === t.id"
        :title="`${t.help}（${t.key}）`"
        :disabled="editor.busy.value"
        @click="editor.chart.setTool(t.id)"
      >
        {{ t.label }}
      </button>
      <span class="toolbar-spacer" />
      <span class="note-count" data-testid="note-count"
        >{{ Object.keys(editor.project.value.notes).length }} 音符</span
      >
      <div v-if="editor.chart.tool.value === 'slider'" class="slider-drawing-actions">
        <span>{{
          editor.chart.sliderDraft.value?.nodes.length
            ? `已放置 ${editor.chart.sliderDraft.value.nodes.length} 个锚点 · 拖动调切线，Enter 完成`
            : '钢笔 · 点击放锚点，按住拖出曲线切线'
        }}</span>
        <button
          :disabled="(editor.chart.sliderDraft.value?.nodes.length ?? 0) < 2"
          @click="editor.chart.finishSlider()"
        >
          完成 Slider
        </button>
        <button @click="editor.chart.cancelGesture()">取消绘制</button>
      </div>
    </template>
    <template v-else>
      <span>{{
        editor.chart.mode.value === 'preview'
          ? '自动预览 · 滑球按音乐时间运动'
          : '鼠标 / Z、X · 点击 Circle · 按住跟随 Slider'
      }}</span>
      <span class="toolbar-spacer" />
      <button
        :disabled="!editor.playback.value.ready || editor.busy.value"
        @click="editor.chart.replay()"
      >
        从头试玩
      </button>
    </template>
  </div>
</template>
