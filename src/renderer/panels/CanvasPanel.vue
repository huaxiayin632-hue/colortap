<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from 'vue';
import type { Editor } from '../state/editor';
import { EditorStage } from '../canvas/stage';

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
        <button aria-label="缩小画布" @click="editor.setZoom(editor.zoom.value / 1.25)">−</button>
        <span class="zoom-value" data-testid="zoom-value"
          >{{ (editor.zoom.value * 100).toFixed(1) }}%</span
        >
        <button aria-label="放大画布" @click="editor.setZoom(editor.zoom.value * 1.25)">+</button>
        <button @click="editor.fit()">适合窗口</button>
        <button @click="editor.setZoom(1)">原尺寸</button>
      </div>
    </header>
    <div ref="host" class="canvas-host" data-testid="canvas-host">
      <div v-if="failure" class="canvas-error">无法创建画布：{{ failure }}</div>
      <div v-else-if="!Object.keys(editor.project.value.layers).length" class="canvas-guidance">
        <span class="origin-mark">+</span>
        <span>拖动画布平移 · 滚轮缩放</span>
      </div>
      <div class="canvas-corner">
        {{ editor.project.value.output.size.width }} ×
        {{ editor.project.value.output.size.height }} 输出
      </div>
    </div>
    <footer class="canvas-footer">
      <span>点击选择 · 拖动移动 · 中键 / Alt 平移</span><span>滚轮缩放 · 高清分块按需加载</span>
    </footer>
  </section>
</template>
