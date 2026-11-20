<script setup lang="ts">
import type { FanReveal } from '../../shared/models';
import type { RevealController } from './controller';
import NumberField from '../panels/NumberField.vue';

const props = defineProps<{
  controller: RevealController;
  effect: FanReveal;
  disabled: boolean;
}>();
const degrees = (radians: number) => Number(((radians * 180) / Math.PI).toFixed(3));
function center(axis: 'x' | 'y', value: string) {
  props.controller.patchEffect({
    center: { ...props.effect.center, [axis]: Number(value) / 100 },
  });
}
</script>

<template>
  <div class="fan-properties">
    <div class="two-fields">
      <label
        >扇形模式<select
          aria-label="扇形模式"
          :disabled="disabled"
          :value="effect.mode"
          @change="controller.patchEffect({ mode: ($event.target as HTMLSelectElement).value })"
        >
          <option value="open">展开显现</option>
          <option value="close">收拢消失</option>
        </select></label
      >
      <label
        >扫动方向<select
          aria-label="扇形扫动方向"
          :disabled="disabled"
          :value="effect.direction"
          @change="
            controller.patchEffect({ direction: ($event.target as HTMLSelectElement).value })
          "
        >
          <option value="clockwise">顺时针</option>
          <option value="counterclockwise">逆时针</option>
        </select></label
      >
    </div>
    <div class="two-fields">
      <label
        >中心 X / %<NumberField
          aria-label="扇形中心 X"
          type="number"
          :precision="1"
          min="0"
          max="100"
          step="1"
          :disabled="disabled"
          :value="Number((effect.center.x * 100).toFixed(3))"
          @commit="center('x', $event)"
      /></label>
      <label
        >中心 Y / %<NumberField
          aria-label="扇形中心 Y"
          type="number"
          :precision="1"
          min="0"
          max="100"
          step="1"
          :disabled="disabled"
          :value="Number((effect.center.y * 100).toFixed(3))"
          @commit="center('y', $event)"
      /></label>
    </div>
    <div class="note-actions">
      <button :disabled="disabled" @click="controller.patchEffect({ center: { x: 0.5, y: 0.5 } })">
        图片中心
      </button>
      <button :disabled="disabled" @click="controller.patchEffect({ center: { x: 0.5, y: 1 } })">
        底边中心
      </button>
      <button :disabled="disabled" @click="controller.patchEffect({ center: { x: 0, y: 1 } })">
        左下角
      </button>
    </div>
    <div class="two-fields">
      <label
        >起始角 / 度<NumberField
          aria-label="扇形起始角"
          type="number"
          :precision="2"
          step="1"
          :disabled="disabled"
          :value="degrees(effect.startAngleRad)"
          @commit="controller.patchEffect({ startAngleRad: (Number($event) * Math.PI) / 180 })"
      /></label>
      <label
        >角度范围 / 度<NumberField
          aria-label="扇形角度范围"
          type="number"
          :precision="2"
          min="0"
          max="360"
          step="1"
          :disabled="disabled"
          :value="degrees(effect.sweepAngleRad)"
          @commit="controller.patchEffect({ sweepAngleRad: (Number($event) * Math.PI) / 180 })"
      /></label>
    </div>
    <p class="help-text">
      0° 朝右，90° 朝下。角度范围决定扇形区域，顺／逆时针改变扫动顺序。中心位置随图层变换。
    </p>
    <p v-if="effect.mode === 'close'" class="help-text">
      需要开场就显示时，取消勾选“演出开始前隐藏”；已有展开演出的图层可直接添加收拢。
    </p>
  </div>
</template>
