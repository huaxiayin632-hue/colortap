<script setup lang="ts">
import { computed, onMounted, onBeforeUnmount, ref } from 'vue';
import type { Editor } from '../state/editor';
import { formatTime } from '../../core/timing';
import LayerPanel from '../panels/LayerPanel.vue';
import SfxLibrary from '../audio/SfxLibrary.vue';
import PanelDivider from './PanelDivider.vue';
import { sectionIds, sectionSizes, type SectionId, type WorkspaceLayout } from './layout';
const props = defineProps<{ editor: Editor; layout: WorkspaceLayout }>();
const emit = defineEmits<{
  toggle: [];
  resizeStart: [];
  resizeEnd: [cancelled: boolean];
  sectionToggle: [id: SectionId];
  weights: [values: Partial<Record<SectionId, number>>];
}>();
const editor = props.editor;
const audioAssets = computed(() =>
  Object.values(editor.project.value.assets)
    .filter((asset) => asset.kind === 'audio' && asset.audioRole !== 'sfx')
    .sort(
      (a, b) => Number(b.id === editor.music.value?.id) - Number(a.id === editor.music.value?.id),
    ),
);

const host = ref<HTMLElement>();
const height = ref(400);
const sizes = computed(() => sectionSizes(props.layout, height.value));
const labels = { layers: '图层', assets: '素材', sounds: '音效素材' };
const counts = computed(() => ({
  layers: Object.keys(editor.project.value.layers).length,
  assets: audioAssets.value.length,
  sounds: editor.soundAssets.value.length,
}));
let observer: ResizeObserver;
onMounted(() => {
  observer = new ResizeObserver(() => {
    if (host.value?.clientHeight) height.value = host.value.clientHeight;
  });
  if (host.value) observer.observe(host.value);
});
onBeforeUnmount(() => observer?.disconnect());
function pair(index: number) {
  const before = sectionIds
    .slice(0, index + 1)
    .filter((id) => !props.layout.sections[id].collapsed)
    .at(-1);
  const after = sectionIds.slice(index + 1).find((id) => !props.layout.sections[id].collapsed);
  return before && after ? ([before, after] as const) : null;
}
function resize(index: number, value: number) {
  const ids = pair(index);
  if (!ids) return;
  const [before, after] = ids;
  const totalSize = sizes.value[before] + sizes.value[after] - 64;
  const free = totalSize - 72;
  if (free <= 0) return;
  const totalWeight = props.layout.sections[before].weight + props.layout.sections[after].weight;
  const fraction = Math.max(
    0.01 / totalWeight,
    Math.min(1 - 0.01 / totalWeight, (value - 68) / free),
  );
  emit('weights', { [before]: totalWeight * fraction, [after]: totalWeight * (1 - fraction) });
}
</script>
<template>
  <aside class="left-panel" aria-label="图层与素材">
    <header class="panel-header resource-header">
      <strong>资源</strong><button aria-label="收起左栏" @click="emit('toggle')">‹</button>
    </header>
    <div ref="host" class="resource-sections">
      <template v-for="(id, index) in sectionIds" :key="id">
        <section class="resource-section" :data-section="id" :style="{ height: sizes[id] + 'px' }">
          <header class="panel-header section-header">
            <button
              class="section-toggle"
              :aria-label="(layout.sections[id].collapsed ? '展开' : '收起') + labels[id] + '区块'"
              :aria-expanded="!layout.sections[id].collapsed"
              @click="emit('sectionToggle', id)"
            >
              <span aria-hidden="true">{{ layout.sections[id].collapsed ? '▸' : '▾' }}</span>
              {{ labels[id] }}</button
            ><span class="count">{{ counts[id] }}</span>
          </header>
          <div v-show="!layout.sections[id].collapsed" class="resource-section-body">
            <LayerPanel v-if="id === 'layers'" :editor="editor" />
            <template v-else-if="id === 'assets'">
              <div class="asset-area">
                <template v-if="audioAssets.length">
                  <div
                    v-for="asset in audioAssets"
                    :key="asset.id"
                    class="asset-item"
                    :class="{ current: asset.id === editor.music.value?.id }"
                  >
                    <span class="asset-symbol">♫</span>
                    <div class="asset-description">
                      <strong :title="asset.originalName">{{ asset.originalName }}</strong>
                      <small
                        >{{ asset.id === editor.music.value?.id ? '当前音乐 · ' : ''
                        }}{{ formatTime(asset.audio?.durationUs ?? 0) }} ·
                        {{ (asset.byteLength / 1024 / 1024).toFixed(2) }} MB</small
                      >
                    </div>
                    <button
                      class="delete-button"
                      :aria-label="`删除音频 ${asset.originalName}`"
                      title="从工程移除音频，可撤销"
                      :disabled="editor.busy.value || editor.chart.mode.value !== 'edit'"
                      @click="editor.deleteAudio(asset.id)"
                    >
                      删除
                    </button>
                  </div>
                </template>
                <div v-else class="asset-empty">
                  <p>先为工程添加一首音乐</p>
                  <button :disabled="editor.busy.value" @click="editor.importMusic()">
                    导入音乐
                  </button>
                </div>
              </div>
            </template>
            <SfxLibrary v-else :editor="editor" />
          </div>
        </section>
        <PanelDivider
          v-if="index < 2"
          :label="labels[id] + '下方分隔条'"
          :disabled="!pair(index)"
          :value="sizes[pair(index)?.[0] ?? id]"
          :min="68"
          :max="height"
          @resize="resize(index, $event)"
          @start="emit('resizeStart')"
          @end="emit('resizeEnd', $event)"
        />
      </template>
    </div>
    <div class="left-footer">素材原文件随工程保存</div>
  </aside>
</template>
