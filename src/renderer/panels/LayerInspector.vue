<script setup lang="ts">
import { computed } from 'vue';
import type { Editor } from '../state/editor';
import { isLocked } from '../../core/layers';
import CommitInput from './CommitInput.vue';
const props = defineProps<{ editor: Editor }>();
const layer = computed(() => props.editor.selectedLayer.value);
const locked = computed(() =>
  Boolean(
    layer.value &&
    (props.editor.busy.value ||
      props.editor.chart.mode.value !== 'edit' ||
      isLocked(props.editor.project.value, layer.value.id)),
  ),
);
function transform(field: 'position' | 'scale' | 'rotation', axis: 'x' | 'y', value: string): void {
  const l = layer.value;
  if (!l) return;
  const number = Number(value);
  if (!Number.isFinite(number) || (field === 'scale' && number === 0)) {
    props.editor.notify('请输入有效数值；缩放不能为零', 'warning');
    return;
  }
  const t = structuredClone(l.transform);
  if (field === 'rotation') t.rotationRad = (number * Math.PI) / 180;
  else t[field][axis] = number;
  props.editor.edit({ type: 'set-layer', id: l.id, patch: { transform: t } });
}
const source = computed(() =>
  layer.value && layer.value.kind !== 'group'
    ? props.editor.project.value.pixelSources[layer.value.pixelSourceId]
    : undefined,
);
</script>
<template>
  <section v-if="layer" class="property-section layer-inspector" aria-label="图层属性">
    <h2>
      {{ layer.kind === 'group' ? '分组' : '图层' }}属性
      <span v-if="locked" class="muted">· 已锁定</span>
    </h2>
    <label class="checkbox-label reveal-checkbox"
      ><input
        type="checkbox"
        aria-label="图层演出初始可见"
        :checked="layer.initialReveal === 1"
        :disabled="editor.busy.value || editor.chart.mode.value !== 'edit'"
        @change="
          editor.edit({
            type: 'set-layer',
            id: layer.id,
            patch: { initialReveal: ($event.target as HTMLInputElement).checked ? 1 : 0 },
          })
        "
      />演出初始可见</label
    >
    <label class="stacked-label"
      >名称<CommitInput
        aria-label="图层名称"
        :value="layer.name"
        :disabled="editor.busy.value || editor.chart.mode.value !== 'edit'"
        @commit="editor.edit({ type: 'set-layer', id: layer.id, patch: { name: $event } })"
    /></label>
    <div class="two-fields">
      <label
        >X 位置<CommitInput
          aria-label="图层 X"
          type="number"
          :value="layer.transform.position.x"
          :disabled="locked"
          @commit="transform('position', 'x', $event)" /></label
      ><label
        >Y 位置<CommitInput
          aria-label="图层 Y"
          type="number"
          :value="layer.transform.position.y"
          :disabled="locked"
          @commit="transform('position', 'y', $event)"
      /></label>
    </div>
    <div class="two-fields">
      <label
        >X 缩放<CommitInput
          aria-label="图层缩放 X"
          type="number"
          step="0.1"
          :value="layer.transform.scale.x"
          :disabled="locked"
          @commit="transform('scale', 'x', $event)" /></label
      ><label
        >Y 缩放<CommitInput
          aria-label="图层缩放 Y"
          type="number"
          step="0.1"
          :value="layer.transform.scale.y"
          :disabled="locked"
          @commit="transform('scale', 'y', $event)"
      /></label>
    </div>
    <div class="two-fields">
      <label
        >旋转 / 度<CommitInput
          aria-label="图层旋转"
          type="number"
          :value="Number(((layer.transform.rotationRad * 180) / Math.PI).toFixed(4))"
          :disabled="locked"
          @commit="transform('rotation', 'x', $event)" /></label
      ><label
        >不透明度 / %<CommitInput
          aria-label="图层不透明度"
          type="number"
          min="0"
          max="100"
          :value="Number((layer.opacity * 100).toFixed(2))"
          :disabled="locked"
          @commit="
            editor.edit({
              type: 'set-layer',
              id: layer.id,
              patch: { opacity: Number($event) / 100 },
            })
          "
      /></label>
    </div>
    <p v-if="source" class="help-text">
      原图层 {{ source.originalBounds.width }} × {{ source.originalBounds.height
      }}<br />透明边缘裁剪 {{ source.cropRect.width }} × {{ source.cropRect.height }}<br />{{
        source.levels.length
      }}
      级预览 · 原始像素保留
    </p>
    <p class="help-text">
      点击画布选中，拖动移动。中键或 Alt＋拖动平移画布。拖动图层行可调整顺序；拖到分组中央可移入。
    </p>
  </section>
</template>
