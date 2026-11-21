<script setup lang="ts">
import { useCommands } from '../commands/registry';
const commands = useCommands();
import { computed, ref } from 'vue';
import type { Editor } from '../state/editor';
import type { Layer } from '../../shared/models';
import { isLocked } from '../../core/layers';
const props = defineProps<{ editor: Editor }>();
const readOnly = computed(
  () => props.editor.busy.value || props.editor.chart.mode.value !== 'edit',
);
const dragging = ref<string | null>(null),
  over = ref('');
const rows = computed(() => {
  const p = props.editor.project.value,
    result: { layer: Layer; depth: number; parentId: string | null }[] = [];
  function visit(ids: string[], depth: number, parentId: string | null) {
    for (const id of [...ids].reverse()) {
      const layer = p.layers[id];
      result.push({ layer, depth, parentId });
      if (layer.kind === 'group' && layer.expanded !== false)
        visit(layer.childrenBottomToTop, depth + 1, id);
    }
  }
  visit(p.rootLayersBottomToTop, 0, null);
  return result;
});
function start(event: DragEvent, id: string): void {
  if (readOnly.value || isLocked(props.editor.project.value, id)) {
    event.preventDefault();
    return;
  }
  dragging.value = id;
  event.dataTransfer?.setData('application/x-rhythm-layer', id);
  if (event.dataTransfer) event.dataTransfer.effectAllowed = 'move';
}
function zone(event: DragEvent, layer: Layer): 'above' | 'below' | 'inside' {
  const rect = (event.currentTarget as HTMLElement).getBoundingClientRect(),
    ratio = (event.clientY - rect.top) / rect.height;
  return ratio < 0.3
    ? 'above'
    : ratio > 0.7
      ? 'below'
      : layer.kind === 'group'
        ? 'inside'
        : 'above';
}
function drop(event: DragEvent, layer: Layer, parentId: string | null): void {
  const id = dragging.value ?? event.dataTransfer?.getData('application/x-rhythm-layer');
  if (!id || id === layer.id) return;
  const location = zone(event, layer),
    p = props.editor.project.value;
  const siblings = parentId
    ? (p.layers[parentId] as Extract<Layer, { kind: 'group' }>).childrenBottomToTop
    : p.rootLayersBottomToTop;
  props.editor.edit({
    type: 'move-layer',
    id,
    parentId: location === 'inside' ? layer.id : parentId,
    index:
      location === 'inside' && layer.kind === 'group'
        ? layer.childrenBottomToTop.length
        : siblings.indexOf(layer.id) + (location === 'above' ? 1 : 0),
  });
  dragging.value = null;
  over.value = '';
}
</script>
<template>
  <div class="layer-actions">
    <button @click="commands.run('import.image')" :disabled="!commands.enabled('import.image')">
      ＋ 导入 PSD / PNG</button
    ><button
      title="将选中图层上移一层"
      aria-label="图层上移"
      @click="commands.run('layer.up', { kind: 'layer', ids: [editor.selectedLayerId.value!] })"
      :disabled="
        !commands.enabled('layer.up', { kind: 'layer', ids: [editor.selectedLayerId.value!] })
      "
    >
      ↑</button
    ><button
      title="将选中图层下移一层"
      aria-label="图层下移"
      @click="commands.run('layer.down', { kind: 'layer', ids: [editor.selectedLayerId.value!] })"
      :disabled="
        !commands.enabled('layer.down', { kind: 'layer', ids: [editor.selectedLayerId.value!] })
      "
    >
      ↓
    </button>
    <button
      class="delete-button"
      title="删除选中图层或整个分组，可撤销（Delete）"
      aria-label="删除选中图层或分组"
      @click="
        commands.run('object.delete', { kind: 'layer', ids: [editor.selectedLayerId.value!] })
      "
      :disabled="
        !commands.enabled('object.delete', { kind: 'layer', ids: [editor.selectedLayerId.value!] })
      "
    >
      删除
    </button>
  </div>
  <div class="layer-area" role="tree" aria-label="PSD 图层树">
    <div
      v-for="{ layer, depth, parentId } in rows"
      :key="layer.id"
      class="layer-row"
      role="treeitem"
      :aria-selected="editor.selectedLayerId.value === layer.id"
      :aria-expanded="layer.kind === 'group' ? layer.expanded !== false : undefined"
      :data-layer-id="layer.id"
      :data-layer-name="layer.name"
      :class="{
        active: editor.selectedLayerId.value === layer.id,
        hidden: !layer.enabled,
        drop: over === layer.id,
      }"
      :style="{ paddingLeft: `${5 + depth * 13}px` }"
      :draggable="!readOnly && !isLocked(editor.project.value, layer.id)"
      tabindex="0"
      @click="editor.selectLayer(layer.id)"
      @keydown.enter="!$event.isComposing && !$event.repeat && editor.selectLayer(layer.id)"
      @dragstart="start($event, layer.id)"
      @dragend="
        dragging = null;
        over = '';
      "
      @dragover.prevent="
        $event.dataTransfer && ($event.dataTransfer.dropEffect = 'move');
        over = layer.id;
      "
      @dragleave="over = ''"
      @drop.prevent.stop="drop($event, layer, parentId)"
    >
      <button
        v-if="layer.kind === 'group'"
        class="tree-toggle"
        :disabled="readOnly"
        :aria-label="`${layer.expanded === false ? '展开' : '折叠'} ${layer.name}`"
        @click.stop="
          editor.edit({
            type: 'set-group-expanded',
            id: layer.id,
            expanded: layer.expanded === false,
          })
        "
      >
        {{ layer.expanded === false ? '▸' : '▾' }}</button
      ><span v-else class="tree-toggle tree-leaf">▧</span>
      <span class="layer-name" :title="layer.name">{{ layer.name }}</span>
      <button
        :aria-label="`${layer.enabled ? '隐藏' : '显示'} ${layer.name}`"
        @click.stop="commands.run('layer.visible', { kind: 'layer', ids: [layer.id] })"
        :disabled="!commands.enabled('layer.visible', { kind: 'layer', ids: [layer.id] })"
      >
        {{ layer.enabled ? '◉' : '○' }}
      </button>
      <button
        :aria-label="`${layer.locked ? '解锁' : '锁定'} ${layer.name}`"
        @click.stop="commands.run('layer.lock', { kind: 'layer', ids: [layer.id] })"
        :disabled="!commands.enabled('layer.lock', { kind: 'layer', ids: [layer.id] })"
      >
        {{ layer.locked ? '▣' : '▫' }}
      </button>
    </div>
    <div v-if="!rows.length" class="empty-layers">
      <p>还没有插画图层</p>
      <span>导入 PSD 保留分组和原坐标<br />也可以添加独立 PNG 图层</span>
    </div>
    <div
      v-if="dragging"
      class="root-drop"
      @dragover.prevent
      @drop.prevent="
        editor.edit({ type: 'move-layer', id: dragging!, parentId: null, index: 0 });
        dragging = null;
      "
    >
      移至根目录最底层
    </div>
  </div>
</template>
