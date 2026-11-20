<script setup lang="ts">
import { computed } from 'vue';
import type { Editor } from '../state/editor';
import { defaultMixer, type SoundCue, type AudioBus } from '../../shared/models';
import { soundBus } from '../../core/sound';
import CommitInput from '../panels/CommitInput.vue';
import NumberField from '../panels/NumberField.vue';
const props = defineProps<{ editor: Editor }>();
const p = computed(() => props.editor.project.value),
  selected = computed(() => p.value.sounds[props.editor.selectedSoundId.value ?? '']);
const assets = props.editor.soundAssets;
const disabled = computed(
  () => props.editor.busy.value || props.editor.chart.mode.value !== 'edit',
);
const mixer = computed(() => p.value.mixer ?? defaultMixer());
const channels: { id: AudioBus; label: string }[] = [
  { id: 'music', label: 'Music · 背景音乐' },
  { id: 'hit', label: 'Hit SFX · 打击' },
  { id: 'animation', label: 'Animation SFX · 演出' },
];
const triggerOptions = computed(() => [
  { value: 'timeline', label: '音乐时间 · 自动触发' },
  ...Object.values(p.value.notes)
    .filter((n) => n.kind !== 'hold')
    .flatMap((n, i) =>
      (n.kind === 'circle'
        ? ['hit', 'miss']
        : ['slider-start', 'slider-complete', 'slider-fail', 'tick']
      ).map((event) => ({
        value: `note|${n.id}|${event}`,
        label: `${n.kind === 'circle' ? 'Circle' : 'Slider'} #${i + 1} · ${{ hit: '命中成功', miss: 'Miss', 'slider-start': '起点命中', 'slider-complete': '完成成功', 'slider-fail': '追踪失败', tick: '有效追踪节点' }[event]}`,
      })),
    ),
  ...Object.values(p.value.reveals).flatMap((c) =>
    (c.effect.kind === 'outline'
      ? ['reveal-start', 'outline-start', 'outline-complete', 'layer-reveal']
      : ['reveal-start', 'layer-reveal']
    ).map((event) => ({
      value: `reveal|${c.id}|${event}`,
      label: `${p.value.layers[c.layerId]?.name} · ${{ 'reveal-start': '演出开始', 'outline-start': '白线开始', 'outline-complete': '白线完成', 'layer-reveal': c.effect.kind === 'fan' ? (c.effect.mode === 'close' ? '扇形收拢完成' : '扇形展开完成') : '整层显现完成' }[event]}`,
    })),
  ),
]);
function label(c: SoundCue) {
  return (
    (p.value.assets[c.assetId]?.label ?? p.value.assets[c.assetId]?.originalName ?? '音效') +
    ' · ' +
    (c.trigger.kind === 'timeline' ? '时间事件' : '条件 / 演出事件')
  );
}
function patch(value: Partial<SoundCue>) {
  if (selected.value)
    props.editor.edit({ type: 'put-sound', cue: { ...selected.value, ...value } });
}
function triggerValue(c: SoundCue) {
  const t = c.trigger;
  return t.kind === 'timeline'
    ? 'timeline'
    : 'noteId' in t
      ? `note|${t.noteId}|${t.kind === 'slider-tick' ? 'tick' : t.event}`
      : `reveal|${t.revealId}|${t.kind}`;
}
function setTrigger(value: string) {
  const [kind, id, event] = value.split('|');
  let trigger: SoundCue['trigger'];
  if (kind === 'timeline')
    trigger = {
      kind: 'timeline',
      at: { basis: 'time', timeUs: props.editor.playback.value.timeUs },
    };
  else if (kind === 'note')
    trigger =
      event === 'tick'
        ? { kind: 'slider-tick', noteId: id, intervalTicks: 240 }
        : {
            kind: 'note',
            noteId: id,
            event: event as Extract<SoundCue['trigger'], { kind: 'note' }>['event'],
          };
  else trigger = { kind: event as 'reveal-start', revealId: id };
  patch({ trigger, bus: kind === 'note' ? 'hit' : 'animation' });
}
function create(kind: 'time' | 'note' | 'reveal') {
  const assetId = props.editor.selectedSoundAssetId.value ?? assets.value[0]?.id;
  if (!assetId) return;
  const note = props.editor.chart.selectedNote.value,
    reveal = props.editor.reveals.selected.value;
  let trigger: SoundCue['trigger'] = {
    kind: 'timeline',
    at: { basis: 'time', timeUs: props.editor.playback.value.timeUs },
  };
  if (kind === 'note' && note)
    trigger = {
      kind: 'note',
      noteId: note.id,
      event: note.kind === 'slider' ? 'slider-start' : 'hit',
    };
  if (kind === 'reveal' && reveal) trigger = { kind: 'reveal-start', revealId: reveal.id };
  const cue: SoundCue = {
    id: crypto.randomUUID(),
    assetId,
    trigger,
    delayUs: 0,
    gain: 1,
    pan: 0,
    bus: kind === 'note' ? 'hit' : 'animation',
    enabled: true,
  };
  if (props.editor.edit({ type: 'put-sound', cue })) props.editor.selectedSoundId.value = cue.id;
}
function mix(bus: AudioBus, field: 'gain' | 'muted', value: number | boolean) {
  const next = structuredClone(mixer.value);
  Object.assign(next[bus], { [field]: value });
  props.editor.edit({ type: 'set-mixer', mixer: next });
}
function remove() {
  if (selected.value) props.editor.edit({ type: 'delete-sound', id: selected.value.id });
}
function copy() {
  if (selected.value) props.editor.copySound(selected.value.id);
}
</script>
<template>
  <section class="property-section" aria-label="音效配置">
    <h2>音效与混音</h2>
    <div class="mixer-row" v-for="channel in channels" :key="channel.id">
      <label
        >{{ channel.label
        }}<CommitInput
          type="range"
          min="0"
          max="100"
          :aria-label="`${channel.id} 通道音量`"
          :value="mixer[channel.id].gain * 100"
          @commit="mix(channel.id, 'gain', Number($event) / 100)" /></label
      ><label class="checkbox-label"
        ><input
          type="checkbox"
          :aria-label="`${channel.id} 通道静音`"
          :checked="mixer[channel.id].muted"
          @change="mix(channel.id, 'muted', ($event.target as HTMLInputElement).checked)"
        />静音</label
      >
    </div>
    <div class="note-actions">
      <button :disabled="disabled" @click="editor.importSound()">导入音效</button
      ><button @click="editor.sounds.stopAll()">停止试听</button>
    </div>
    <label class="stacked-label"
      >素材<select aria-label="绑定音效素材" v-model="editor.selectedSoundAssetId.value">
        <option v-for="a in assets" :key="a.id" :value="a.id">
          {{ a.label ?? a.originalName }}
        </option>
      </select></label
    >
    <div class="note-actions">
      <button :disabled="disabled || !assets.length" @click="create('time')">添加时间音效</button
      ><button
        :disabled="disabled || !assets.length || !editor.chart.selectedNote.value"
        @click="create('note')"
      >
        绑定选中音符</button
      ><button
        :disabled="disabled || !assets.length || !editor.reveals.selected.value"
        @click="create('reveal')"
      >
        绑定选中演出
      </button>
    </div>
    <div class="sound-cue-list">
      <button
        v-for="cue in Object.values(p.sounds)"
        :key="cue.id"
        class="sound-select"
        :class="{ selected: selected?.id === cue.id }"
        :data-sound-id="cue.id"
        @click="editor.selectedSoundId.value = cue.id"
      >
        {{ label(cue) }}
      </button>
    </div>
    <template v-if="selected">
      <label class="stacked-label"
        >触发来源<select
          aria-label="音效触发来源"
          :disabled="disabled"
          :value="triggerValue(selected)"
          @change="setTrigger(($event.target as HTMLSelectElement).value)"
        >
          <option v-for="o in triggerOptions" :value="o.value" :key="o.value">{{ o.label }}</option>
        </select></label
      >
      <label class="stacked-label"
        >音效素材<select
          aria-label="片段音效素材"
          :disabled="disabled"
          :value="selected.assetId"
          @change="patch({ assetId: ($event.target as HTMLSelectElement).value })"
        >
          <option v-for="a in assets" :key="a.id" :value="a.id">
            {{ a.label ?? a.originalName }}
          </option>
        </select></label
      >
      <label class="stacked-label"
        >通道<select
          aria-label="音效通道"
          :disabled="disabled"
          :value="soundBus(selected)"
          @change="
            patch({ bus: ($event.target as HTMLSelectElement).value as 'hit' | 'animation' })
          "
        >
          <option value="hit">Hit SFX</option>
          <option value="animation">Animation SFX</option>
        </select></label
      >
      <label v-if="selected.trigger.kind === 'timeline'" class="stacked-label"
        >时间 / 秒<NumberField
          aria-label="音效时间"
          type="number"
          :precision="6"
          min="0"
          step="0.001"
          :disabled="disabled"
          :value="editor.tempo.value.resolve(selected.trigger.at) / 1e6"
          @commit="
            patch({
              trigger: {
                kind: 'timeline',
                at: { basis: 'time', timeUs: Math.max(0, Math.round(Number($event) * 1e6)) },
              },
            })
          "
      /></label>
      <label v-if="selected.trigger.kind === 'slider-tick'" class="stacked-label"
        >追踪节点间隔<select
          aria-label="追踪音效间隔"
          :disabled="disabled"
          :value="selected.trigger.intervalTicks"
          @change="
            patch({
              trigger: {
                ...selected.trigger,
                intervalTicks: Number(($event.target as HTMLSelectElement).value),
              },
            })
          "
        >
          <option :value="960">1 拍</option>
          <option :value="480">1/2 拍</option>
          <option :value="240">1/4 拍</option>
          <option :value="120">1/8 拍</option>
          <option :value="60">1/16 拍</option>
        </select></label
      >
      <div class="two-fields">
        <label
          >音量 / %<NumberField
            aria-label="音效音量"
            type="number"
            :precision="1"
            step="1"
            min="0"
            max="100"
            :disabled="disabled"
            :value="selected.gain * 100"
            @commit="patch({ gain: Number($event) / 100 })" /></label
        ><label
          >声像 / %<NumberField
            aria-label="音效声像"
            type="number"
            :precision="1"
            step="1"
            min="-100"
            max="100"
            :disabled="disabled"
            :value="selected.pan * 100"
            @commit="patch({ pan: Number($event) / 100 })"
        /></label>
      </div>
      <label class="stacked-label"
        >延迟 / 毫秒<NumberField
          aria-label="音效延迟"
          type="number"
          :precision="3"
          min="0"
          step="1"
          :disabled="disabled"
          :value="selected.delayUs / 1000"
          @commit="patch({ delayUs: Math.round(Number($event) * 1000) })"
      /></label>
      <label class="checkbox-label"
        ><input
          aria-label="启用音效片段"
          type="checkbox"
          :disabled="disabled"
          :checked="selected.enabled !== false"
          @change="patch({ enabled: ($event.target as HTMLInputElement).checked })"
        />启用片段</label
      >
      <div class="note-actions">
        <button @click="editor.auditionSound(selected.assetId, selected.id)">试听片段</button
        ><button :disabled="disabled" @click="copy">复制音效片段</button
        ><button :disabled="disabled" @click="remove">删除音效片段</button>
      </div>
    </template>
    <p class="help-text">
      试玩中的条件音效跟随真实命中；预览模拟成功。时间音效始终按音乐时间触发。隐藏时间轴轨道只改变编辑显示。
    </p>
    <output
      class="help-text"
      data-testid="sound-status"
      :data-voices="editor.soundStats.value.voices"
      :data-fires="editor.soundStats.value.recent.length"
      >活动音效 {{ editor.soundStats.value.voices }} · 已解码
      {{ editor.soundStats.value.buffers }}</output
    >
  </section>
</template>
