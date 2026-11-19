<script setup lang="ts">
import type { OutlineReveal } from '../../shared/models';
import type { RevealController } from './controller';
import CommitInput from '../panels/CommitInput.vue';
const props = defineProps<{
  controller: RevealController;
  effect: OutlineReveal;
  disabled: boolean;
  closed: boolean;
  following: boolean;
}>();
function drawing(patch: Partial<OutlineReveal['drawing']>) {
  props.controller.patchEffect({ drawing: { ...props.effect.drawing, ...patch } });
}
function stroke(patch: Partial<OutlineReveal['stroke']>) {
  props.controller.patchEffect({ stroke: { ...props.effect.stroke, ...patch } });
}
function layer(patch: Partial<OutlineReveal['layer']>) {
  props.controller.patchEffect({ layer: { ...props.effect.layer, ...patch } });
}
function lineAfter(patch: Partial<OutlineReveal['lineAfter']>) {
  props.controller.patchEffect({ lineAfter: { ...props.effect.lineAfter, ...patch } });
}
function mode(value: string) {
  drawing({
    mode: value as 'single' | 'bidirectional',
    ...(value === 'bidirectional' && !props.closed && props.effect.drawing.start === 0
      ? { start: 0.5 }
      : {}),
  });
}
</script>
<template>
  <div class="outline-properties">
    <h3>① 白线描绘</h3>
    <label class="stacked-label"
      >描绘模式<select
        aria-label="白线描绘模式"
        :disabled="disabled"
        :value="effect.drawing.mode"
        @change="mode(($event.target as HTMLSelectElement).value)"
      >
        <option value="single">Single · 单向</option>
        <option value="bidirectional">Bidirectional · 双向</option>
      </select></label
    >
    <div class="two-fields">
      <label
        >起点 / 路径长度 %<CommitInput
          aria-label="白线起点"
          type="number"
          min="0"
          max="100"
          step="1"
          :disabled="disabled || (!closed && effect.drawing.mode === 'single')"
          :value="effect.drawing.start * 100"
          @commit="drawing({ start: Number($event) / 100 })"
      /></label>
      <label v-if="effect.drawing.mode === 'bidirectional'"
        >正向速度占比 / %<CommitInput
          aria-label="白线正向速度比例"
          type="number"
          min="0"
          max="100"
          step="1"
          :disabled="disabled"
          :value="effect.drawing.forwardRatio * 100"
          @commit="drawing({ forwardRatio: Number($event) / 100 })"
      /></label>
    </div>
    <p class="help-text">
      {{
        effect.drawing.mode === 'bidirectional'
          ? `反向速度占比 ${Math.round((1 - effect.drawing.forwardRatio) * 100)}%。两支沿路径相反方向推进，闭合路径会汇合；开放路径到达端点后将剩余速度交给另一支。`
          : '开放路径从起点绘制到终点；使用下方“反转显现路径”改变方向。闭合路径可指定任意起点。'
      }}
    </p>
    <label class="stacked-label"
      >描边颜色
      <div class="outline-color">
        <input
          aria-label="白线颜色"
          type="color"
          :disabled="disabled"
          :value="effect.stroke.color"
          @change="stroke({ color: ($event.target as HTMLInputElement).value })"
        /><span>{{ effect.stroke.color }}</span>
      </div></label
    >
    <div class="two-fields">
      <label
        >线宽 / 插画像素<CommitInput
          aria-label="白线宽度"
          type="number"
          min="0.1"
          step="0.5"
          :disabled="disabled"
          :value="effect.stroke.width"
          @commit="stroke({ width: Number($event) })" /></label
      ><label
        >发光强度 / 0–4<CommitInput
          aria-label="白线发光强度"
          type="number"
          min="0"
          max="4"
          step="0.1"
          :disabled="disabled"
          :value="effect.stroke.glow"
          @commit="stroke({ glow: Number($event) })"
      /></label>
    </div>
    <label class="checkbox-label reveal-checkbox"
      ><input
        aria-label="白线端点光点"
        type="checkbox"
        :disabled="disabled"
        :checked="effect.stroke.tips"
        @change="stroke({ tips: ($event.target as HTMLInputElement).checked })"
      />显示移动端点光点</label
    >
    <label v-if="effect.stroke.tips" class="stacked-label"
      >光点半径 / 插画像素<CommitInput
        aria-label="白线光点半径"
        type="number"
        min="0.1"
        step="0.5"
        :disabled="disabled"
        :value="effect.stroke.tipSize"
        @commit="stroke({ tipSize: Number($event) })"
    /></label>
    <h3>② 整层显现</h3>
    <label class="stacked-label"
      >白线完成触发阈值 / %<CommitInput
        aria-label="整层显现阈值"
        type="number"
        min="0"
        max="100"
        step="1"
        :disabled="disabled"
        :value="effect.layer.threshold * 100"
        @commit="layer({ threshold: Number($event) / 100 })"
    /></label>
    <p class="help-text">
      白线与 PSD 是两个独立对象，达到阈值才开始显示完整原图。{{
        following
          ? 'Follow 只计算真实有效追踪；100% 阈值要求全程有效，晚按会减少进度，可按需要降低阈值。'
          : ''
      }}
    </p>
    <div class="two-fields">
      <label
        >显现方式<select
          aria-label="描边后图层方式"
          :disabled="disabled"
          :value="effect.layer.kind"
          @change="
            layer({
              kind: ($event.target as HTMLSelectElement).value as 'instant' | 'fade' | 'pop',
            })
          "
        >
          <option value="instant">Instant · 瞬间</option>
          <option value="fade">Fade · 淡入</option>
          <option value="pop">Pop · 弹出</option>
        </select></label
      ><label v-if="effect.layer.kind !== 'instant'"
        >显现时长 / 秒<CommitInput
          aria-label="描边后图层时长"
          type="number"
          min="0"
          step="0.05"
          :disabled="disabled"
          :value="effect.layer.durationUs / 1e6"
          @commit="layer({ durationUs: Math.max(0, Math.round(Number($event) * 1e6)) })"
      /></label>
    </div>
    <div v-if="effect.layer.kind === 'pop'" class="two-fields">
      <label
        >初始缩放<CommitInput
          aria-label="描边后初始缩放"
          type="number"
          min="0.01"
          step="0.05"
          :disabled="disabled"
          :value="effect.layer.fromScale"
          @commit="layer({ fromScale: Number($event) })" /></label
      ><label
        >弹性幅度<CommitInput
          aria-label="描边后弹性"
          type="number"
          min="0"
          step="0.05"
          :disabled="disabled"
          :value="effect.layer.overshoot"
          @commit="layer({ overshoot: Number($event) })"
      /></label>
    </div>
    <h3>白线收尾</h3>
    <div class="two-fields">
      <label
        >达到阈值后<select
          aria-label="白线完成后处理"
          :disabled="disabled"
          :value="effect.lineAfter.kind"
          @change="
            lineAfter({
              kind: ($event.target as HTMLSelectElement).value as 'keep' | 'fade' | 'hide',
            })
          "
        >
          <option value="keep">保留白线</option>
          <option value="fade">淡出白线</option>
          <option value="hide">立即消失</option>
        </select></label
      ><label v-if="effect.lineAfter.kind === 'fade'"
        >淡出时长 / 秒<CommitInput
          aria-label="白线淡出时长"
          type="number"
          min="0"
          step="0.05"
          :disabled="disabled"
          :value="effect.lineAfter.durationUs / 1e6"
          @commit="lineAfter({ durationUs: Math.max(0, Math.round(Number($event) * 1e6)) })"
      /></label>
    </div>
    <p class="help-text">
      描绘时长、音乐/Follow
      来源及缓动使用上方设置。达到阈值后，图层显现和白线淡出使用音乐时间；暂停会一起冻结。
    </p>
  </div>
</template>
