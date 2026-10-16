<script setup lang="ts">
import { nextTick, ref, watch } from 'vue';

defineOptions({ inheritAttrs: false });
const props = withDefaults(defineProps<{ value: string | number; type?: string }>(), {
  type: 'text',
});
const emit = defineEmits<{ commit: [value: string]; focus: [] }>();
const draft = ref(String(props.value));
let focused = false;
watch(
  () => props.value,
  (value) => {
    if (!focused) draft.value = String(value);
  },
);
function focus(): void {
  focused = true;
  emit('focus');
}
async function commit(): Promise<void> {
  if (draft.value !== String(props.value)) emit('commit', draft.value);
  await nextTick();
  // The parent may reject an invalid edit. Always read back its authoritative value.
  draft.value = String(props.value);
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
    @input="draft = ($event.target as HTMLInputElement).value"
    @focus="focus"
    @change="commit"
    @blur="blur"
  />
</template>
