<script setup lang="ts">
import { onBeforeUnmount, ref } from 'vue';

const props = withDefaults(
  defineProps<{
    label: string;
    vertical?: boolean;
    value: number;
    min?: number;
    max?: number;
    reverse?: boolean;
    disabled?: boolean;
  }>(),
  { min: 0, max: 1200 },
);
const emit = defineEmits<{ resize: [value: number]; start: []; end: [cancelled: boolean] }>();
const active = ref(false);
let drag: { element: HTMLElement; id: number; start: number; value: number } | null = null;
function end(cancel = false) {
  const previous = drag;
  drag = null;
  active.value = false;
  window.removeEventListener('blur', cancelDrag);
  window.removeEventListener('keydown', escape, true);
  if (!previous) return;
  emit('end', cancel);
  if (previous.element.hasPointerCapture(previous.id))
    previous.element.releasePointerCapture(previous.id);
}
function cancelDrag() {
  end(true);
}
function escape(event: KeyboardEvent) {
  if (event.key !== 'Escape') return;
  event.preventDefault();
  event.stopImmediatePropagation();
  cancelDrag();
}
function down(event: PointerEvent) {
  if (props.disabled || event.button !== 0 || drag) return;
  event.preventDefault();
  const element = event.currentTarget as HTMLElement;
  drag = {
    element,
    id: event.pointerId,
    start: props.vertical ? event.clientX : event.clientY,
    value: props.value,
  };
  emit('start');
  element.setPointerCapture(event.pointerId);
  active.value = true;
  window.addEventListener('blur', cancelDrag);
  window.addEventListener('keydown', escape, true);
}
function move(event: PointerEvent) {
  if (!drag || drag.id !== event.pointerId) return;
  const delta = (props.vertical ? event.clientX : event.clientY) - drag.start;
  emit('resize', drag.value + delta * (props.reverse ? -1 : 1));
}
function keydown(event: KeyboardEvent) {
  if (props.disabled) return;
  const minus = props.vertical ? 'ArrowLeft' : 'ArrowUp';
  const plus = props.vertical ? 'ArrowRight' : 'ArrowDown';
  if (![minus, plus, 'Home', 'End'].includes(event.key)) return;
  event.preventDefault();
  event.stopPropagation();
  emit(
    'resize',
    event.key === 'Home'
      ? props.min
      : event.key === 'End'
        ? props.max
        : props.value +
          (event.key === minus ? -1 : 1) * (props.reverse ? -1 : 1) * (event.shiftKey ? 40 : 10),
  );
}
onBeforeUnmount(() => end());
</script>

<template>
  <div
    class="panel-divider"
    :class="{ vertical, active, disabled }"
    role="separator"
    :tabindex="disabled ? -1 : 0"
    :aria-label="label"
    :aria-disabled="disabled"
    :aria-orientation="vertical ? 'vertical' : 'horizontal'"
    :aria-valuenow="Math.round(value)"
    :aria-valuemin="min"
    :aria-valuemax="max"
    :title="`${label} · 拖动或方向键调整，Esc 取消`"
    @pointerdown.stop="down"
    @pointermove.stop="move"
    @pointerup.stop="end()"
    @pointercancel.stop="cancelDrag"
    @lostpointercapture="cancelDrag"
    @keydown="keydown"
  />
</template>
