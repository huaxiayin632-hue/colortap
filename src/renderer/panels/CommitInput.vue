<script setup lang="ts">
import { nextTick, ref, watch } from 'vue';

defineOptions({ inheritAttrs: false });
const props = withDefaults(defineProps<{ value: string | number; type?: string }>(), {
  type: 'text',
});
const emit = defineEmits<{ commit: [value: string]; focus: [] }>();
const draft = ref(String(props.value));
let focused = false;
let edited = false;
watch(
  () => props.value,
  (value) => {
    if (!focused || !edited) draft.value = String(value);
  },
);
function focus(): void {
  focused = true;
  emit('focus');
}
async function commit(): Promise<void> {
  const changed = edited;
  edited = false;
  if (changed && draft.value !== String(props.value)) emit('commit', draft.value);
  await nextTick();
  // The parent may reject an invalid edit. Always read back its authoritative value.
  if (!edited) draft.value = String(props.value);
}
function input(event: Event): void {
  edited = true;
  draft.value = (event.target as HTMLInputElement).value;
}
function blur(): void {
  focused = false;
  void commit();
}
</script>

<template>
  <input
    v-bind="$attrs"
    :type="type"
    :value="draft"
    @input="input"
    @focus="focus"
    @change="commit"
    @blur="blur"
  />
</template>
