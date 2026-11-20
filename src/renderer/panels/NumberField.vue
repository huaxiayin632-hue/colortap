<script lang="ts">
import type { InjectionKey } from 'vue';

export interface NumberGesture {
  begin(): void;
  end(commit: boolean): void;
}
export const numberGestureKey: InjectionKey<NumberGesture> = Symbol('numberGesture');
</script>

<script setup lang="ts">
import { computed, inject, nextTick, onBeforeUnmount, ref, useAttrs, watch } from 'vue';
import { evaluateNumberInput, formatNumber } from '../../core/number-input';

defineOptions({ inheritAttrs: false });
const props = withDefaults(
  defineProps<{ value: string | number; precision?: number; type?: string; live?: boolean }>(),
  { precision: 3, live: true },
);
const emit = defineEmits<{ commit: [value: string]; focus: [] }>();
const attrs = useAttrs();
const gesture = inject(numberGestureKey, null);
const inputElement = ref<HTMLInputElement>();
const focused = ref(false);
const draft = ref(String(props.value));
const displayValue = computed(() => {
  const text = String(props.value);
  const numeric = Number(text);
  return text.trim() && Number.isFinite(numeric) ? formatNumber(numeric, props.precision) : text;
});
const scrubDisplayValue = ref<number | null>(null);
const inputValue = computed(() =>
  scrubbing.value && !props.live && scrubDisplayValue.value !== null
    ? formatNumber(scrubDisplayValue.value, props.precision)
    : focused.value
      ? draft.value
      : displayValue.value,
);
let edited = false;
let pointerId: number | null = null;
let startX = 0;
let startValue = 0;
let startStep = 1;
let minimum = -Infinity;
let maximum = Infinity;
const scrubbing = ref(false);
let latestValue = 0;
let lastEmitted = 0;
let animationFrame = 0;
let finishAfterFrame = false;

watch(
  () => [props.value, props.precision],
  () => {
    if (!focused.value || !edited) draft.value = displayValue.value;
  },
);

function focus(): void {
  if (!edited) draft.value = displayValue.value;
  focused.value = true;
  emit('focus');
}

function rounded(value: number): number {
  return Number(formatNumber(value, props.precision));
}

function clamp(value: number): number {
  return rounded(Math.min(maximum, Math.max(minimum, value)));
}

function commitValue(value: number): void {
  const number = clamp(value);
  draft.value = String(number);
  edited = false;
  if (number !== Number(props.value)) {
    emit('commit', String(number));
    void nextTick().then(() => {
      if (!edited) draft.value = displayValue.value;
    });
  }
}

async function commitText(): Promise<void> {
  if (edited) {
    edited = false;
    const current = Number(props.value);
    const value = Number.isFinite(current) ? evaluateNumberInput(draft.value, current) : null;
    if (value !== null && value !== current) emit('commit', String(value));
  }
  await nextTick();
  if (!edited) draft.value = displayValue.value;
}

function input(event: Event): void {
  edited = true;
  draft.value = (event.target as HTMLInputElement).value;
}

function blur(): void {
  focused.value = false;
  void commitText();
}

function stepValue(): number {
  const value = Number(inputElement.value?.getAttribute('step') ?? attrs.step ?? 1);
  return Number.isFinite(value) && value > 0 ? value : 1;
}

function changeByStep(amount: number): void {
  const current = Number(props.value);
  if (Number.isFinite(current)) {
    const draftValue = focused.value && edited ? evaluateNumberInput(draft.value, current) : null;
    const base = draftValue ?? current;
    minimum = attributeNumber('min', -Infinity);
    maximum = attributeNumber('max', Infinity);
    commitValue(base + amount);
  }
}

function keydown(event: KeyboardEvent): void {
  if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return;
  event.preventDefault();
  const multiplier = event.shiftKey ? 10 : event.altKey ? 0.1 : 1;
  changeByStep((event.key === 'ArrowUp' ? 1 : -1) * stepValue() * multiplier);
}

function wheel(event: WheelEvent): void {
  if (!focused.value) return;
  event.preventDefault();
  changeByStep(
    (event.deltaY < 0 ? 1 : -1) * stepValue() * (event.shiftKey ? 10 : event.altKey ? 0.1 : 1),
  );
}

function attributeNumber(name: 'min' | 'max', fallback: number): number {
  const attribute = inputElement.value?.getAttribute(name);
  if (attribute === null || attribute === undefined) return fallback;
  const value = Number(attribute);
  return Number.isFinite(value) ? value : fallback;
}

function scrubValue(event: PointerEvent): number {
  const multiplier = event.shiftKey ? 10 : event.altKey ? 0.1 : 1;
  return clamp(startValue + (event.clientX - startX) * startStep * multiplier);
}

function emitPreview(): void {
  if (latestValue !== lastEmitted) {
    lastEmitted = latestValue;
    emit('commit', String(latestValue));
  }
}

function finishScrub(commit: boolean): void {
  if (animationFrame) cancelAnimationFrame(animationFrame);
  animationFrame = 0;
  finishAfterFrame = false;
  const input = inputElement.value;
  const activePointer = pointerId;
  pointerId = null;
  if (input && activePointer !== null && input.hasPointerCapture(activePointer))
    input.releasePointerCapture(activePointer);
  if (scrubbing.value) {
    scrubbing.value = false;
    scrubDisplayValue.value = null;
    window.removeEventListener('keydown', escapeScrub, { capture: true });
    if (props.live) gesture?.end(commit);
  }
}

function queuePreview(): void {
  if (animationFrame) return;
  animationFrame = requestAnimationFrame(() => {
    animationFrame = 0;
    emitPreview();
    if (finishAfterFrame) finishScrub(true);
  });
}

function pointerdown(event: PointerEvent): void {
  const input = inputElement.value;
  const current = Number(props.value);
  if (event.button !== 0 || focused.value || !input || input.disabled || !Number.isFinite(current))
    return;
  event.preventDefault();
  pointerId = event.pointerId;
  startX = event.clientX;
  startValue = current;
  startStep = stepValue();
  minimum = attributeNumber('min', -Infinity);
  maximum = attributeNumber('max', Infinity);
  latestValue = current;
  lastEmitted = current;
  scrubbing.value = false;
  scrubDisplayValue.value = null;
  finishAfterFrame = false;
  input.setPointerCapture(event.pointerId);
}

function pointermove(event: PointerEvent): void {
  if (event.pointerId !== pointerId) return;
  const delta = event.clientX - startX;
  if (!scrubbing.value && Math.abs(delta) > 3) {
    scrubbing.value = true;
    window.addEventListener('keydown', escapeScrub, { capture: true });
    if (props.live) gesture?.begin();
  }
  if (!scrubbing.value) return;
  latestValue = scrubValue(event);
  if (!props.live) {
    scrubDisplayValue.value = latestValue;
    return;
  }
  if (gesture) queuePreview();
}

function pointerup(event: PointerEvent): void {
  if (event.pointerId !== pointerId) return;
  if (!scrubbing.value) {
    finishScrub(false);
    inputElement.value?.focus();
    inputElement.value?.select();
    return;
  }
  latestValue = scrubValue(event);
  pointerId = null;
  if (!props.live) {
    if (latestValue !== startValue) emit('commit', String(latestValue));
    finishScrub(true);
  } else if (!gesture) {
    emitPreview();
    finishScrub(true);
  } else if (animationFrame || latestValue !== lastEmitted) {
    finishAfterFrame = true;
    queuePreview();
  } else finishScrub(true);
}

function cancelScrub(event: PointerEvent): void {
  if (event.pointerId !== pointerId) return;
  finishScrub(false);
}

function escapeScrub(event: KeyboardEvent): void {
  if (event.key !== 'Escape' || !scrubbing.value) return;
  event.stopImmediatePropagation();
  event.preventDefault();
  finishScrub(false);
}

onBeforeUnmount(() => {
  if (pointerId !== null || scrubbing.value) finishScrub(false);
  window.removeEventListener('keydown', escapeScrub, { capture: true });
});
</script>

<template>
  <input
    ref="inputElement"
    class="number-field"
    :class="{ 'is-scrubbing': scrubbing }"
    type="text"
    inputmode="decimal"
    v-bind="$attrs"
    :value="inputValue"
    @input="input"
    @focus="focus"
    @change="commitText"
    @blur="blur"
    @keydown="keydown"
    @wheel="wheel"
    @pointerdown="pointerdown"
    @pointermove="pointermove"
    @pointerup="pointerup"
    @pointercancel="cancelScrub"
    @lostpointercapture="cancelScrub"
  />
</template>
