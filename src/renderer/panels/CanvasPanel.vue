<script setup lang="ts">
import { useCommands } from '../commands/registry';
const commands = useCommands();
import { onBeforeUnmount, onMounted, ref, watch } from 'vue';
import type { Editor } from '../state/editor';
import { EditorStage } from '../canvas/stage';
import ChartToolbar from '../chart/ChartToolbar.vue';
import ChartHud from '../chart/ChartHud.vue';

const props = defineProps<{ editor: Editor }>();
const host = ref<HTMLDivElement>();
const failure = ref('');
let stage: EditorStage | null = null;
onMounted(async () => {
  if (!host.value) return;
  stage = new EditorStage(host.value);
  try {
    await stage.initialize();
    props.editor.attachStage(stage);
  } catch (error) {
    failure.value = error instanceof Error ? error.message : '图形设备初始化失败';
    props.editor.notify(`画布初始化失败：${failure.value}`, 'error');
  }
});
watch(
  [
    () => props.editor.project.value.stage.artworkSize.width,
    () => props.editor.project.value.stage.artworkSize.height,
  ],
  ([width, height]) => stage?.setArtwork({ width, height }, true),
);
onBeforeUnmount(() => stage?.dispose());
</script>

<template>
  <section class="canvas-panel" aria-label="中央画布">
    <header class="panel-header canvas-header">
      <span
        >画布
        <span class="muted"
          >{{ editor.project.value.stage.artworkSize.width }} ×
          {{ editor.project.value.stage.artworkSize.height }}</span
        ></span
      >
      <div class="canvas-controls">
        <label v-if="editor.chart.mode.value === 'edit'" class="checkbox-label source-art-toggle"
          ><input
            aria-label="显示完整素材"
            type="checkbox"
            :checked="!editor.reveals.audition.value"
            @change="
              editor.reveals.override.value = null;
              editor.reveals.audition.value = !($event.target as HTMLInputElement).checked;
            "
          />完整素材</label
        >
        <button
          aria-label="缩小画布"
          @click="commands.run('view.out')"
          :disabled="!commands.enabled('view.out')"
        >
          −
        </button>
        <span class="zoom-value" data-testid="zoom-value"
          >{{ (editor.zoom.value * 100).toFixed(1) }}%</span
        >
        <button
          aria-label="放大画布"
          @click="commands.run('view.in')"
          :disabled="!commands.enabled('view.in')"
        >
          +
        </button>
        <button @click="commands.run('view.fit')" :disabled="!commands.enabled('view.fit')">
          适合窗口
        </button>
        <button @click="commands.run('view.actual')" :disabled="!commands.enabled('view.actual')">
          原尺寸
        </button>
      </div>
    </header>
    <ChartToolbar :editor="editor" />
    <div
      ref="host"
      class="canvas-host"
      data-testid="canvas-host"
      :data-tool="editor.chart.tool.value"
      :data-mode="editor.chart.mode.value"
    >
      <div v-if="failure" class="canvas-error">无法创建画布：{{ failure }}</div>
      <div
        v-else-if="
          !Object.keys(editor.project.value.layers).length &&
          !Object.keys(editor.project.value.notes).length &&
          editor.chart.tool.value === 'layers' &&
          editor.chart.mode.value === 'edit'
        "
        class="canvas-guidance"
      >
        <span class="origin-mark">+</span>
        <span>拖动画布平移 · 滚轮缩放</span>
      </div>
      <ChartHud :editor="editor" />
      <div class="canvas-corner">
        {{ editor.project.value.output.size.width }} ×
        {{ editor.project.value.output.size.height }} 输出
      </div>
    </div>
    <footer class="canvas-footer">
      <span>{{
        editor.chart.mode.value === 'edit'
          ? editor.chart.tool.value === 'circle'
            ? '点击添加 Circle · 时间跟随播放头'
            : editor.chart.tool.value === 'slider'
              ? '连续点击拐点 · Enter / 双击完成 · 也可拖动创建'
              : editor.chart.tool.value === 'path'
                ? editor.chart.appendMode.value
                  ? '点击画布追加拐点 · Esc 结束'
                  : '方形节点 · 圆形控制柄 · 双击添点'
                : '点击选择 · 拖动移动 · 中键 / Alt 平移'
          : '空格暂停 / 继续 · 鼠标或 Z / X 输入'
      }}</span
      ><span>滚轮缩放 · 高清分块按需加载</span>
    </footer>
  </section>
</template>
