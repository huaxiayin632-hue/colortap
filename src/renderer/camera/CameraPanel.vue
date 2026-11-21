<script setup lang="ts">
import { useCommands } from '../commands/registry';
const commands = useCommands();
import { computed } from 'vue';
import type { Editor } from '../state/editor';
import { cameraEnabled } from '../../core/camera';
import NumberField from '../panels/NumberField.vue';
import EasingEditor from './EasingEditor.vue';
import { spanUs } from '../../core/chart';
const props = defineProps<{ editor: Editor }>(),
  c = props.editor.camera;
const p = computed(() => props.editor.project.value),
  key = computed(() => c.key.value),
  shake = computed(() => c.shake.value),
  disabled = computed(() => props.editor.busy.value || props.editor.chart.mode.value !== 'edit');
const keys = computed(() =>
  Object.values(p.value.camera.keys).sort(
    (a, b) => props.editor.tempo.value.resolve(a.at) - props.editor.tempo.value.resolve(b.at),
  ),
);
function position(axis: 'x' | 'y', value: number) {
  if (key.value) c.patch({ position: { ...key.value.position, [axis]: value } });
}
function pivot(axis: 'x' | 'y', value: number) {
  if (key.value) c.patch({ pivot: { ...(key.value.pivot ?? key.value.position), [axis]: value } });
}
function tool(value: 'none' | 'pan' | 'pivot') {
  props.editor.chart.setTool('layers');
  props.editor.reveals.cancel();
  c.tool.value = value;
}
</script>
<template>
  <section class="property-section" aria-label="镜头配置">
    <h2>演出镜头</h2>
    <label class="checkbox-label"
      ><input
        type="checkbox"
        aria-label="启用演出镜头"
        :disabled="disabled"
        :checked="cameraEnabled(p)"
        @change="
          editor.edit({
            type: 'enable-camera',
            enabled: ($event.target as HTMLInputElement).checked,
          })
        "
      />启用镜头</label
    >
    <label class="checkbox-label"
      ><input type="checkbox" aria-label="显示镜头预览框" v-model="c.showFrame.value" />显示预览框 /
      缩放中心</label
    >
    <div class="note-actions">
      <button @click="commands.run('camera.add')" :disabled="!commands.enabled('camera.add')">
        添加镜头关键帧</button
      ><button @click="commands.run('camera.shake')" :disabled="!commands.enabled('camera.shake')">
        添加节拍震动</button
      ><button @click="commands.run('camera.reset')" :disabled="!commands.enabled('camera.reset')">
        重置镜头构图
      </button>
    </div>
    <div class="note-actions">
      <button
        :disabled="disabled"
        :aria-pressed="c.tool.value === 'pan'"
        @click="tool(c.tool.value === 'pan' ? 'none' : 'pan')"
      >
        画布拖动镜头</button
      ><button
        :disabled="disabled"
        :aria-pressed="c.tool.value === 'pivot'"
        @click="tool(c.tool.value === 'pivot' ? 'none' : 'pivot')"
      >
        画布设置缩放中心</button
      ><button :disabled="disabled || !editor.selectedLayerId.value" @click="c.focusLayer()">
        聚焦选中图层
      </button>
    </div>
    <p class="help-text">
      在目标音乐时间添加关键帧，再调整位置和缩放。缓动控制当前帧到下一帧的运动。镜头仅影响插画及白线，音符位置不受影响。
      开启镜头拖动工具后，滚轮缩放镜头，Shift + 滚轮旋转；Alt + 滚轮仍缩放编辑器视图。
    </p>
    <div class="camera-key-list">
      <button
        v-for="k in keys"
        :key="k.id"
        :data-camera-id="k.id"
        :class="{ selected: c.selectedId.value === k.id }"
        @click="
          c.choose(k.id);
          editor.seek(editor.tempo.value.resolve(k.at));
        "
      >
        {{ (editor.tempo.value.resolve(k.at) / 1e6).toFixed(3) }} 秒 · {{ k.zoom.toFixed(2) }}×
      </button>
    </div>
    <div
      v-if="key"
      @pointerdown.capture="editor.claimTarget({ kind: 'camera', ids: [key.id] })"
      @keydown.capture="
        $event.key !== 'Tab' && editor.claimTarget({ kind: 'camera', ids: [key.id] })
      "
    >
      <label class="stacked-label"
        >关键帧时间 / 秒<NumberField
          aria-label="镜头关键帧时间"
          type="number"
          :precision="6"
          min="0"
          step="0.001"
          :disabled="disabled"
          :value="editor.tempo.value.resolve(key.at) / 1e6"
          @commit="c.patch({ at: { basis: 'time', timeUs: Math.round(Number($event) * 1e6) } })"
      /></label>
      <div class="two-fields">
        <label
          >X<NumberField
            aria-label="镜头X"
            type="number"
            :precision="2"
            step="1"
            :disabled="disabled"
            :value="key.position.x"
            @commit="position('x', Number($event))" /></label
        ><label
          >Y<NumberField
            aria-label="镜头Y"
            type="number"
            :precision="2"
            step="1"
            :disabled="disabled"
            :value="key.position.y"
            @commit="position('y', Number($event))" /></label
        ><label
          >缩放<NumberField
            aria-label="镜头缩放"
            type="number"
            :precision="3"
            min="0.01"
            step="0.1"
            :disabled="disabled"
            :value="key.zoom"
            @commit="c.patch({ zoom: Number($event) })" /></label
        ><label
          >旋转 / 度<NumberField
            aria-label="镜头旋转"
            type="number"
            :precision="2"
            step="1"
            :disabled="disabled"
            :value="(key.rotationRad * 180) / Math.PI"
            @commit="c.patch({ rotationRad: (Number($event) * Math.PI) / 180 })" /></label
        ><label
          >中心 X<NumberField
            aria-label="镜头中心X"
            type="number"
            :precision="2"
            step="1"
            :disabled="disabled"
            :value="key.pivot?.x ?? p.stage.artworkSize.width / 2"
            @commit="pivot('x', Number($event))" /></label
        ><label
          >中心 Y<NumberField
            aria-label="镜头中心Y"
            type="number"
            :precision="2"
            step="1"
            :disabled="disabled"
            :value="key.pivot?.y ?? p.stage.artworkSize.height / 2"
            @commit="pivot('y', Number($event))"
        /></label>
      </div>
      <EasingEditor
        :value="key.easingToNext"
        :disabled="disabled"
        @change="c.patch({ easingToNext: $event })"
      />
      <div class="note-actions">
        <button
          @click="commands.run('object.duplicate', { kind: 'camera', ids: [key.id] })"
          :disabled="!commands.enabled('object.duplicate', { kind: 'camera', ids: [key.id] })"
        >
          复制镜头关键帧</button
        ><button
          @click="commands.run('object.delete', { kind: 'camera', ids: [key.id] })"
          :disabled="!commands.enabled('object.delete', { kind: 'camera', ids: [key.id] })"
        >
          删除镜头关键帧
        </button>
      </div>
    </div>
    <h3>震动片段</h3>
    <div class="camera-key-list">
      <button
        v-for="s in Object.values(p.camera.shakes ?? {})"
        :key="s.id"
        :data-shake-id="s.id"
        @click="c.chooseShake(s.id)"
      >
        {{ (editor.tempo.value.resolve(s.at) / 1e6).toFixed(3) }} 秒 · 震动
      </button>
    </div>
    <div
      v-if="shake"
      @pointerdown.capture="editor.claimTarget({ kind: 'shake', ids: [shake.id] })"
      @keydown.capture="
        $event.key !== 'Tab' && editor.claimTarget({ kind: 'shake', ids: [shake.id] })
      "
    >
      <div class="two-fields">
        <label
          >时间 / 秒<NumberField
            aria-label="震动时间"
            type="number"
            :precision="6"
            min="0"
            step="0.001"
            :disabled="disabled"
            :value="editor.tempo.value.resolve(shake.at) / 1e6"
            @commit="
              c.patchShake({ at: { basis: 'time', timeUs: Math.round(Number($event) * 1e6) } })
            " /></label
        ><label
          >时长 / 秒<NumberField
            aria-label="震动时长"
            type="number"
            :precision="6"
            min="0.01"
            step="0.1"
            :disabled="disabled"
            :value="spanUs(shake.duration, shake.at, editor.tempo.value) / 1e6"
            @commit="
              c.patchShake({
                duration: { basis: 'time', durationUs: Math.round(Number($event) * 1e6) },
              })
            " /></label
        ><label
          >水平幅度<NumberField
            aria-label="震动水平幅度"
            type="number"
            :precision="2"
            step="1"
            :disabled="disabled"
            :value="shake.amplitude.x"
            @commit="
              c.patchShake({ amplitude: { ...shake.amplitude, x: Number($event) } })
            " /></label
        ><label
          >垂直幅度<NumberField
            aria-label="震动垂直幅度"
            type="number"
            :precision="2"
            step="1"
            :disabled="disabled"
            :value="shake.amplitude.y"
            @commit="
              c.patchShake({ amplitude: { ...shake.amplitude, y: Number($event) } })
            " /></label
        ><label
          >旋转幅度 / 度<NumberField
            aria-label="震动旋转幅度"
            type="number"
            :precision="2"
            step="1"
            :disabled="disabled"
            :value="(shake.rotationRad * 180) / Math.PI"
            @commit="c.patchShake({ rotationRad: (Number($event) * Math.PI) / 180 })" /></label
        ><label
          >频率 / Hz<NumberField
            aria-label="震动频率"
            type="number"
            :precision="2"
            min="1"
            :disabled="disabled"
            :value="shake.frequencyHz"
            @commit="c.patchShake({ frequencyHz: Number($event) })"
        /></label>
      </div>
      <div class="note-actions">
        <button
          @click="commands.run('object.duplicate', { kind: 'shake', ids: [shake.id] })"
          :disabled="!commands.enabled('object.duplicate', { kind: 'shake', ids: [shake.id] })"
        >
          复制震动</button
        ><button
          @click="commands.run('object.delete', { kind: 'shake', ids: [shake.id] })"
          :disabled="!commands.enabled('object.delete', { kind: 'shake', ids: [shake.id] })"
        >
          删除震动
        </button>
      </div>
    </div>
    <output
      data-testid="camera-state"
      :data-x="c.pose.value.position.x"
      :data-y="c.pose.value.position.y"
      :data-zoom="c.pose.value.zoom"
      :data-rotation="c.pose.value.rotationRad"
      class="help-text"
      >当前 {{ c.pose.value.zoom.toFixed(2) }}× ·
      {{ ((c.pose.value.rotationRad * 180) / Math.PI).toFixed(1) }}°</output
    >
  </section>
</template>
