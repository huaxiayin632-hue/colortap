<script setup lang="ts">
import { computed, ref } from 'vue';
import type { Easing } from '../../shared/models';
import NumberField from '../panels/NumberField.vue';
const props = defineProps<{ value: Easing; disabled: boolean }>(),
  emit = defineEmits<{ change: [Easing] }>();
const draft = ref<[number, number, number, number] | null>(null),
  values = computed<[number, number, number, number]>(
    () =>
      draft.value ??
      (typeof props.value === 'object' ? props.value.cubicBezier : [0.42, 0, 0.58, 1]),
  );
function axis(index: number, value: number) {
  const next = [...values.value] as [number, number, number, number];
  next[index] = Math.max(0, Math.min(1, value));
  emit('change', { cubicBezier: next });
}
let drag: { index: number; rect: DOMRect } | null = null;
function down(event: PointerEvent, index: number) {
  if (props.disabled) return;
  event.preventDefault();
  const svg = (event.target as SVGElement).closest('svg')!;
  drag = { index, rect: svg.getBoundingClientRect() };
  draft.value = [...values.value] as [number, number, number, number];
  svg.setPointerCapture(event.pointerId);
}
function move(event: PointerEvent) {
  if (!drag) return;
  const a = [...values.value] as [number, number, number, number];
  a[drag.index] = Math.max(0, Math.min(1, (event.clientX - drag.rect.left) / drag.rect.width));
  a[drag.index + 1] = Math.max(
    0,
    Math.min(1, 1 - (event.clientY - drag.rect.top) / drag.rect.height),
  );
  draft.value = a;
}
function up() {
  if (!drag) return;
  drag = null;
  if (draft.value) emit('change', { cubicBezier: [...draft.value] });
  draft.value = null;
}
</script>
<template>
  <label class="stacked-label"
    >缓动<select
      aria-label="镜头缓动"
      :disabled="disabled"
      :value="typeof value === 'string' ? value : 'custom'"
      @change="
        emit(
          'change',
          ($event.target as HTMLSelectElement).value === 'custom'
            ? { cubicBezier: [0.42, 0, 0.58, 1] }
            : (($event.target as HTMLSelectElement).value as Easing),
        )
      "
    >
      <option value="linear">Linear</option>
      <option value="ease-in">Ease In</option>
      <option value="ease-out">Ease Out</option>
      <option value="ease-in-out">Ease In Out</option>
      <option value="custom">自定义贝塞尔</option>
    </select></label
  >
  <template v-if="typeof value === 'object'">
    <svg
      viewBox="0 0 200 120"
      class="easing-graph"
      aria-label="贝塞尔缓动控制图"
      @pointermove="move"
      @pointerup="up"
      @pointercancel="up"
    >
      <path
        :d="`M0 120 C${values[0] * 200} ${120 - values[1] * 120} ${values[2] * 200} ${120 - values[3] * 120} 200 0`"
        fill="none"
        stroke="#82c9d1"
        stroke-width="2"
      />
      <path
        :d="`M0 120 L${values[0] * 200} ${120 - values[1] * 120} M200 0 L${values[2] * 200} ${120 - values[3] * 120}`"
        stroke="#9c849e"
      />
      <circle
        v-for="i in [0, 2]"
        :key="i"
        :cx="values[i] * 200"
        :cy="120 - values[i + 1] * 120"
        r="5"
        fill="#e9b76f"
        @pointerdown="down($event, i)"
      />
    </svg>
    <div class="two-fields">
      <label v-for="(name, i) in ['X1', 'Y1', 'X2', 'Y2']" :key="name"
        >{{ name
        }}<NumberField
          :aria-label="`镜头缓动${name}`"
          type="number"
          :precision="3"
          min="0"
          max="1"
          step="0.05"
          :value="values[i]"
          :disabled="disabled"
          @commit="axis(i, Number($event))"
      /></label>
    </div>
  </template>
</template>
