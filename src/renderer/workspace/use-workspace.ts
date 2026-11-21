import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import {
  fitLayout,
  layoutKey,
  presetLayout,
  readLayout,
  type PanelId,
  type PresetId,
} from './layout';

export function useWorkspace() {
  let stored: string | null = null;
  try {
    stored = localStorage.getItem(layoutKey);
  } catch {
    /* Use defaults if storage is unavailable. */
  }
  const layout = ref(readLayout(stored));
  const focus = ref(false);
  const storageError = ref(false);
  const viewport = ref({ width: window.innerWidth, height: window.innerHeight });
  const size = computed(() =>
    fitLayout(layout.value, viewport.value.width, viewport.value.height, focus.value),
  );
  function resize() {
    viewport.value = { width: window.innerWidth, height: window.innerHeight };
  }
  function persist() {
    try {
      localStorage.setItem(layoutKey, JSON.stringify(layout.value));
      storageError.value = false;
    } catch {
      storageError.value = true;
    }
  }
  // Coalesce pointer moves, and flush when the window closes.
  let timer: ReturnType<typeof setTimeout> | undefined;
  watch(
    layout,
    () => {
      clearTimeout(timer);
      timer = setTimeout(persist, 150);
    },
    { deep: true },
  );
  function flush() {
    clearTimeout(timer);
    persist();
  }
  onMounted(() => {
    window.addEventListener('resize', resize);
    window.addEventListener('pagehide', flush);
  });
  onBeforeUnmount(() => {
    flush();
    window.removeEventListener('resize', resize);
    window.removeEventListener('pagehide', flush);
  });
  function toggle(id: PanelId) {
    layout.value.collapsed[id] = !layout.value.collapsed[id];
  }
  function preset(id: PresetId) {
    focus.value = false;
    layout.value = presetLayout(id);
  }
  let beforeResize: typeof layout.value | null = null;
  function beginResize() {
    beforeResize = JSON.parse(JSON.stringify(layout.value));
  }
  function endResize(cancelled: boolean) {
    if (cancelled && beforeResize) layout.value = beforeResize;
    beforeResize = null;
  }
  function setSize(id: PanelId, value: number) {
    const min = id === 'left' ? 220 : id === 'right' ? 240 : 140;
    const max =
      id === 'timeline'
        ? viewport.value.height - 395
        : viewport.value.width -
          366 -
          size.value[id === 'left' ? 'right' : 'left'] -
          size.value[id === 'left' ? 'rightHandle' : 'leftHandle'];
    layout.value[id] = Math.max(min, Math.min(1200, max, value));
  }
  return { layout, size, focus, storageError, toggle, preset, setSize, beginResize, endResize };
}
