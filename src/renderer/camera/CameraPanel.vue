<script setup lang="ts">
import { computed } from 'vue';
import type { Editor } from '../state/editor';
import { cameraEnabled } from '../../core/camera';
import CommitInput from '../panels/CommitInput.vue';
import EasingEditor from './EasingEditor.vue';
import { spanUs } from '../../core/chart';
const props = defineProps<{ editor: Editor }>(),
  c = props.editor.camera;
function copyShake() {
  const s = c.shake.value;
  if (s)
    props.editor.edit({
      type: 'put-shake',
      shake: {
        ...s,
        id: crypto.randomUUID(),
        at: { basis: 'time', timeUs: props.editor.tempo.value.resolve(s.at) + 500000 },
      },
    });
}
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
      <button :disabled="disabled" @click="c.add()">添加镜头关键帧</button
      ><button :disabled="disabled" @click="c.addShake()">添加节拍震动</button
      ><button :disabled="disabled" @click="c.reset()">重置镜头构图</button>
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
    <template v-if="key">
      <label class="stacked-label"
        >关键帧时间 / 秒<CommitInput
          aria-label="镜头关键帧时间"
          type="number"
          min="0"
          step="0.001"
          :disabled="disabled"
          :value="editor.tempo.value.resolve(key.at) / 1e6"
          @commit="c.patch({ at: { basis: 'time', timeUs: Math.round(Number($event) * 1e6) } })"
      /></label>
      <div class="two-fields">
        <label
          >X<CommitInput
            aria-label="镜头X"
            type="number"
            :disabled="disabled"
            :value="key.position.x"
            @commit="position('x', Number($event))" /></label
        ><label
          >Y<CommitInput
            aria-label="镜头Y"
            type="number"
            :disabled="disabled"
            :value="key.position.y"
            @commit="position('y', Number($event))" /></label
        ><label
          >缩放<CommitInput
            aria-label="镜头缩放"
            type="number"
            min="0.01"
            step="0.1"
            :disabled="disabled"
            :value="key.zoom"
            @commit="c.patch({ zoom: Number($event) })" /></label
        ><label
          >旋转 / 度<CommitInput
            aria-label="镜头旋转"
            type="number"
            step="1"
            :disabled="disabled"
            :value="(key.rotationRad * 180) / Math.PI"
            @commit="c.patch({ rotationRad: (Number($event) * Math.PI) / 180 })" /></label
        ><label
          >中心 X<CommitInput
            aria-label="镜头中心X"
            type="number"
            :disabled="disabled"
            :value="key.pivot?.x ?? p.stage.artworkSize.width / 2"
            @commit="pivot('x', Number($event))" /></label
        ><label
          >中心 Y<CommitInput
            aria-label="镜头中心Y"
            type="number"
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
        <button :disabled="disabled" @click="c.copy()">复制镜头关键帧</button
        ><button :disabled="disabled" @click="c.remove()">删除镜头关键帧</button>
      </div>
    </template>
    <h3>震动片段</h3>
    <div class="camera-key-list">
      <button
        v-for="s in Object.values(p.camera.shakes ?? {})"
        :key="s.id"
        :data-shake-id="s.id"
        @click="
          c.selectedId.value = null;
          c.selectedShake.value = s.id;
        "
      >
        {{ (editor.tempo.value.resolve(s.at) / 1e6).toFixed(3) }} 秒 · 震动
      </button>
    </div>
    <template v-if="shake">
      <div class="two-fields">
        <label
          >时间 / 秒<CommitInput
            aria-label="震动时间"
            type="number"
            min="0"
            step="0.001"
            :disabled="disabled"
            :value="editor.tempo.value.resolve(shake.at) / 1e6"
            @commit="
              c.patchShake({ at: { basis: 'time', timeUs: Math.round(Number($event) * 1e6) } })
            " /></label
        ><label
          >时长 / 秒<CommitInput
            aria-label="震动时长"
            type="number"
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
          >水平幅度<CommitInput
            aria-label="震动水平幅度"
            type="number"
            :disabled="disabled"
            :value="shake.amplitude.x"
            @commit="
              c.patchShake({ amplitude: { ...shake.amplitude, x: Number($event) } })
            " /></label
        ><label
          >垂直幅度<CommitInput
            aria-label="震动垂直幅度"
            type="number"
            :disabled="disabled"
            :value="shake.amplitude.y"
            @commit="
              c.patchShake({ amplitude: { ...shake.amplitude, y: Number($event) } })
            " /></label
        ><label
          >旋转幅度 / 度<CommitInput
            aria-label="震动旋转幅度"
            type="number"
            :disabled="disabled"
            :value="(shake.rotationRad * 180) / Math.PI"
            @commit="c.patchShake({ rotationRad: (Number($event) * Math.PI) / 180 })" /></label
        ><label
          >频率 / Hz<CommitInput
            aria-label="震动频率"
            type="number"
            min="1"
            :disabled="disabled"
            :value="shake.frequencyHz"
            @commit="c.patchShake({ frequencyHz: Number($event) })"
        /></label>
      </div>
      <div class="note-actions">
        <button :disabled="disabled" @click="copyShake">复制震动</button
        ><button :disabled="disabled" @click="editor.edit({ type: 'delete-shake', id: shake.id })">
          删除震动
        </button>
      </div>
    </template>
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
