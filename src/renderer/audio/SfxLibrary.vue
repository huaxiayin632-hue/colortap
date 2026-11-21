<script setup lang="ts">
import { computed } from 'vue';
import type { Editor } from '../state/editor';
import CommitInput from '../panels/CommitInput.vue';
const props = defineProps<{ editor: Editor }>();
const assets = props.editor.soundAssets;
const disabled = computed(
  () => props.editor.busy.value || props.editor.chart.mode.value !== 'edit',
);
</script>
<template>
  <section class="sfx-library" aria-label="音效素材库">
    <button class="sfx-import" :disabled="disabled" @click="editor.importSound()">＋ 音效</button>
    <div class="sfx-asset-list">
      <p v-if="!assets.length" class="help-text">导入 WAV / MP3 / OGG，再给音符或演出绑定。</p>
      <div
        v-for="asset in assets"
        :key="asset.id"
        class="sfx-asset"
        :data-asset-id="asset.id"
        :class="{ selected: editor.selectedSoundAssetId.value === asset.id }"
      >
        <CommitInput
          :aria-label="`音效名称 ${asset.id}`"
          :disabled="disabled"
          :value="asset.label ?? asset.originalName"
          @commit="editor.edit({ type: 'rename-audio', id: asset.id, label: $event })"
        />
        <div class="note-actions">
          <button @click="editor.auditionSound(asset.id)" :aria-label="`试听音效 ${asset.id}`">
            试听</button
          ><button @click="editor.selectedSoundAssetId.value = asset.id">绑定</button
          ><button :disabled="disabled" @click="editor.importSound(asset.id)">替换</button
          ><button
            :disabled="disabled"
            @click="editor.edit({ type: 'delete-sfx-reference', id: asset.id })"
          >
            删除引用
          </button>
        </div>
      </div>
    </div>
  </section>
</template>
