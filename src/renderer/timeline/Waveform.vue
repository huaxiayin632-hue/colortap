<script setup lang="ts">
import { onBeforeUnmount, ref, watch } from 'vue';
import WaveSurfer from 'wavesurfer.js';

const props = defineProps<{ buffer: AudioBuffer | null; pixelsPerSecond: number }>();
const host = ref<HTMLDivElement>();
const ready = ref(false);
const error = ref('');
let waveform: WaveSurfer | null = null;
let sequence = 0;

// Work in small batches so long songs do not monopolize the UI thread.
async function peaksFor(buffer: AudioBuffer, token: number): Promise<Float32Array | null> {
  const buckets = Math.min(16000, Math.max(1000, Math.ceil(buffer.duration * 100)));
  const peaks = new Float32Array(buckets * 2);
  for (let bucket = 0; bucket < buckets; bucket++) {
    const start = Math.floor((bucket * buffer.length) / buckets);
    const end = Math.floor(((bucket + 1) * buffer.length) / buckets);
    let min = 0,
      max = 0;
    for (let channel = 0; channel < buffer.numberOfChannels; channel++) {
      const samples = buffer.getChannelData(channel);
      for (let frame = start; frame < end; frame++) {
        const value = samples[frame];
        if (value < min) min = value;
        if (value > max) max = value;
      }
    }
    peaks[bucket * 2] = min;
    peaks[bucket * 2 + 1] = max;
    if (bucket % 64 === 0) {
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      if (token !== sequence) return null;
    }
  }
  return peaks;
}

watch(
  [host, () => props.buffer],
  async ([element, buffer]) => {
    const token = ++sequence;
    waveform?.destroy();
    waveform = null;
    ready.value = false;
    error.value = '';
    if (!element || !buffer) return;
    try {
      const peaks = await peaksFor(buffer, token);
      if (!peaks || token !== sequence) return;
      waveform = WaveSurfer.create({
        container: element,
        height: 58,
        waveColor: '#8fa9b0',
        progressColor: '#8fa9b0',
        cursorWidth: 0,
        interact: false,
        dragToSeek: false,
        autoScroll: false,
        hideScrollbar: true,
        fillParent: false,
        minPxPerSec: props.pixelsPerSecond,
        mediaControls: false,
        normalize: true,
      });
      waveform.on('error', (problem) => {
        if (token === sequence) error.value = problem.message;
      });
      // No URL and no WaveSurfer.play(): visualization uses our decoded samples only.
      await waveform.load('', [peaks], buffer.duration);
      if (token === sequence) ready.value = true;
    } catch (problem) {
      if (token === sequence)
        error.value = problem instanceof Error ? problem.message : '波形准备失败';
    }
  },
  { immediate: true },
);
watch(
  () => props.pixelsPerSecond,
  (value) => waveform?.zoom(value),
);
onBeforeUnmount(() => {
  sequence++;
  waveform?.destroy();
});
</script>

<template>
  <div class="waveform" :data-ready="ready" data-testid="waveform">
    <div ref="host" class="waveform-host" />
    <span v-if="!buffer" class="track-hint">导入音乐后显示波形</span>
    <span v-else-if="error" class="track-hint error-text">波形不可用：{{ error }}</span>
    <span v-else-if="!ready" class="track-hint">正在生成波形…</span>
  </div>
</template>
