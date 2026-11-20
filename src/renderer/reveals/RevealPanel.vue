<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import type { Editor } from '../state/editor';
import type { Easing, RevealEffect, Trigger } from '../../shared/models';
import { effectLabels, nominalClipRange } from '../../core/reveal';
import NumberField from '../panels/NumberField.vue';
import OutlineProperties from './OutlineProperties.vue';
import FanProperties from './FanProperties.vue';
const props = defineProps<{ editor: Editor }>();
const r = props.editor.reveals,
  c = props.editor.chart;
const noteId = ref(''),
  layerId = ref(''),
  kind = ref<RevealEffect['kind']>('fade'),
  sliderId = ref('');
const clip = computed(() => r.selected.value),
  e = computed(() => clip.value?.effect);
const disabled = computed(() => props.editor.busy.value || c.mode.value !== 'edit');
const notes = computed(() =>
  Object.values(props.editor.project.value.notes).sort(
    (a, b) => c.tempo.value.resolve(a.at) - c.tempo.value.resolve(b.at),
  ),
);
const sliders = computed(() => notes.value.filter((n) => n.kind === 'slider'));
const layers = computed(() => {
  const p = props.editor.project.value,
    rows: { id: string; name: string }[] = [];
  const visit = (ids: string[], prefix = '') => {
    for (const id of [...ids].reverse()) {
      const l = p.layers[id];
      rows.push({ id, name: prefix + l.name + (l.kind === 'group' ? ' [组]' : '') });
      if (l.kind === 'group') visit(l.childrenBottomToTop, prefix + '　');
    }
  };
  visit(p.rootLayersBottomToTop);
  return rows;
});
watch(
  () => c.selectedNote.value?.id,
  (id) => {
    if (id) noteId.value = id;
  },
);
watch(props.editor.selectedLayerId, (id) => {
  if (id) layerId.value = id;
});
watch(
  [notes, layers],
  () => {
    if (!notes.value.some((n) => n.id === noteId.value)) noteId.value = notes.value[0]?.id ?? '';
    if (!layers.value.some((l) => l.id === layerId.value))
      layerId.value = layers.value[0]?.id ?? '';
    if (!sliders.value.some((n) => n.id === sliderId.value))
      sliderId.value = sliders.value[0]?.id ?? '';
  },
  { immediate: true },
);
const clips = computed(() =>
  Object.values(props.editor.project.value.reveals).sort(
    (a, b) =>
      nominalClipRange(props.editor.project.value, a).start -
      nominalClipRange(props.editor.project.value, b).start,
  ),
);
const target = computed(() =>
  clip.value ? props.editor.project.value.layers[clip.value.layerId] : undefined,
);
const boundNote = computed(() =>
  clip.value?.trigger.kind === 'note'
    ? props.editor.project.value.notes[clip.value.trigger.noteId]
    : undefined,
);
const state = computed(() => (clip.value ? r.states.value[clip.value.layerId] : undefined));
function noteLabel(id: string): string {
  const n = props.editor.project.value.notes[id];
  if (!n) return '音符已删除';
  return `${n.kind === 'circle' ? 'Circle' : n.kind === 'hold' ? '长按' : 'Slider'} ${notes.value.findIndex((n) => n.id === id) + 1} · ${(c.tempo.value.resolve(n.at) / 1e6).toFixed(2)} 秒`;
}
function eventOptions() {
  const list: { value: Extract<Trigger, { kind: 'note' }>['event']; label: string }[] = [
    { value: 'hit', label: boundNote.value?.kind === 'hold' ? '长按起点命中' : '命中成功' },
    { value: 'miss', label: 'Circle 未命中' },
  ];
  if (boundNote.value?.kind === 'slider')
    return [
      { value: 'slider-start', label: 'Slider 起点命中' },
      { value: 'slider-complete', label: 'Slider 完成' },
      { value: 'slider-fail', label: 'Slider 失败' },
    ];
  if (boundNote.value?.kind === 'hold')
    return [
      ...list.filter((v) => v.value !== 'miss'),
      { value: 'hold-complete', label: '长按完成' },
      { value: 'hold-fail', label: '长按失败' },
    ];
  return list;
}
function changeTrigger(value: string) {
  if (!clip.value) return;
  if (value === 'timeline')
    r.patch({
      trigger: {
        kind: 'timeline',
        at: { basis: 'time', timeUs: Math.max(0, props.editor.playback.value.timeUs) },
      },
    });
  else {
    const n = props.editor.project.value.notes[value];
    if (n)
      r.patch({
        trigger: {
          kind: 'note',
          noteId: value,
          event: n.kind === 'slider' ? 'slider-start' : 'hit',
        },
      });
  }
}
function progress(kind: string) {
  if (kind === 'elapsed')
    r.patch({ progress: { kind: 'elapsed', duration: { basis: 'time', durationUs: 500000 } } });
  else if (sliderId.value)
    r.patch({
      progress: {
        kind: kind as 'slider-timeline' | 'slider-follow',
        noteId: boundNote.value?.kind === 'slider' ? boundNote.value.id : sliderId.value,
      },
    });
}
function smooth() {
  const path = r.path.value,
    node = r.node.value;
  if (!path || !node) return;
  const next = structuredClone(path),
    i = next.nodes.findIndex((n) => n.id === node.id),
    a =
      next.nodes[path.closed ? (i - 1 + next.nodes.length) % next.nodes.length : Math.max(0, i - 1)]
        .point,
    b =
      next.nodes[path.closed ? (i + 1) % next.nodes.length : Math.min(next.nodes.length - 1, i + 1)]
        .point;
  next.nodes[i].handleOut = { x: (b.x - a.x) / 3, y: (b.y - a.y) / 3 };
  next.nodes[i].handleIn = { x: -(b.x - a.x) / 3, y: -(b.y - a.y) / 3 };
  next.nodes[i].mode = 'mirrored';
  r.setPath(next);
}
</script>
<template>
  <section class="property-section reveal-panel" aria-label="图层演出绑定">
    <h2>
      图层演出绑定 <span class="muted">{{ clips.length }}</span>
    </h2>
    <details class="reveal-add" :open="!clips.length">
      <summary>＋ 新建音符与图层绑定</summary>
      <label class="stacked-label"
        >触发音符<select v-model="noteId" aria-label="新绑定音符" :disabled="disabled">
          <option value="" disabled>先创建音符</option>
          <option v-for="n in notes" :key="n.id" :value="n.id">{{ noteLabel(n.id) }}</option>
        </select></label
      >
      <label class="stacked-label"
        >目标图层<select v-model="layerId" aria-label="新绑定图层" :disabled="disabled">
          <option value="" disabled>先导入 PSD / PNG</option>
          <option v-for="l in layers" :key="l.id" :value="l.id">{{ l.name }}</option>
        </select></label
      >
      <label class="stacked-label"
        >显现方式<select v-model="kind" aria-label="新绑定显现方式" :disabled="disabled">
          <option v-for="(label, k) in effectLabels" :key="k" :value="k">{{ label }}</option>
        </select></label
      >
      <button
        class="reveal-add-button"
        :disabled="disabled || !noteId || !layerId"
        @click="r.add(noteId, layerId, kind)"
      >
        添加显现绑定
      </button>
    </details>
    <div v-if="clips.length" class="reveal-list">
      <div v-for="item in clips" :key="item.id" class="reveal-binding-row">
        <button
          class="reveal-select"
          :data-reveal-id="item.id"
          :class="{ selected: r.selectedId.value === item.id }"
          @click="r.choose(item.id)"
          @keydown.delete.prevent.stop="r.remove(item.id)"
        >
          <span>{{ editor.project.value.layers[item.layerId]?.name }}</span
          ><small
            >{{ effectLabels[item.effect.kind].split(' · ')[0] }} ·
            {{ item.trigger.kind === 'note' ? noteLabel(item.trigger.noteId) : '音乐时间' }}</small
          >
        </button>
        <button
          class="reveal-delete"
          :data-reveal-delete="item.id"
          :disabled="disabled"
          :aria-label="`删除绑定 ${editor.project.value.layers[item.layerId]?.name}`"
          title="删除此绑定，可撤销"
          @click.stop="r.remove(item.id)"
        >
          ×
        </button>
      </div>
    </div>
    <template v-if="clip && e">
      <div
        class="reveal-current"
        :data-reveal-id="clip.id"
        :data-progress="state?.rawProgress ?? 0"
        :data-alpha="state?.alpha ?? 1"
        :data-started="state?.started ?? false"
        :data-clip-id="state?.clipId ?? ''"
        :data-outline-phase="state?.outline?.phase ?? ''"
        :data-outline-opacity="state?.outline?.opacity ?? 0"
        :data-outline-progress="state?.outline ? state.progress : 0"
        :data-layer-progress="state?.outline?.layerProgress ?? 0"
        data-testid="reveal-state"
      >
        <strong>{{ target?.name }}</strong
        ><span
          >{{
            state?.started
              ? `${((state.outline ? state.progress : state.rawProgress) * 100).toFixed(1)}%`
              : !r.audition.value && c.mode.value === 'edit'
                ? '完整素材'
                : '等待触发'
          }}{{
            state?.outline
              ? ' · ' +
                { drawing: '描线', revealing: '整层显现', complete: '完成' }[state.outline.phase]
              : ''
          }}</span
        >
      </div>
      <label class="stacked-label"
        >目标图层<select
          aria-label="显现目标图层"
          :value="clip.layerId"
          :disabled="disabled"
          @change="r.patch({ layerId: ($event.target as HTMLSelectElement).value })"
        >
          <option v-for="l in layers" :key="l.id" :value="l.id">{{ l.name }}</option>
        </select></label
      >
      <label class="checkbox-label reveal-checkbox"
        ><input
          type="checkbox"
          aria-label="演出开始前隐藏"
          :checked="target?.initialReveal === 0"
          :disabled="disabled"
          @change="
            editor.edit({
              type: 'set-layer',
              id: clip.layerId,
              patch: { initialReveal: ($event.target as HTMLInputElement).checked ? 0 : 1 },
            })
          "
        />演出开始前隐藏</label
      >
      <p v-if="target && !target.enabled" class="help-text warning-text">
        该图层的显示开关已关闭；请先在左侧打开。所属分组也需要可见。
      </p>
      <label class="stacked-label"
        >触发来源<select
          aria-label="显现触发来源"
          :value="clip.trigger.kind === 'timeline' ? 'timeline' : clip.trigger.noteId"
          :disabled="disabled"
          @change="changeTrigger(($event.target as HTMLSelectElement).value)"
        >
          <option value="timeline">指定音乐时间</option>
          <option v-for="n in notes" :key="n.id" :value="n.id">{{ noteLabel(n.id) }}</option>
        </select></label
      >
      <label v-if="clip.trigger.kind === 'note'" class="stacked-label"
        >触发条件<select
          aria-label="显现触发条件"
          :disabled="disabled"
          :value="clip.trigger.event"
          @change="
            r.patch({
              trigger: {
                kind: 'note',
                noteId: boundNote!.id,
                event: ($event.target as HTMLSelectElement).value as Extract<
                  Trigger,
                  { kind: 'note' }
                >['event'],
              },
            })
          "
        >
          <option v-for="option in eventOptions()" :key="option.value" :value="option.value">
            {{ option.label }}
          </option>
        </select></label
      >
      <label v-else class="stacked-label"
        >出现时间 / 秒<NumberField
          aria-label="显现时间"
          type="number"
          :precision="6"
          step="0.01"
          :disabled="disabled"
          :value="c.tempo.value.resolve(clip.trigger.at) / 1e6"
          @commit="
            r.patch({
              trigger: {
                kind: 'timeline',
                at: { basis: 'time', timeUs: Math.max(0, Math.round(Number($event) * 1e6)) },
              },
            })
          "
      /></label>
      <label class="stacked-label"
        >显现方式<select
          aria-label="显现方式"
          :value="e.kind"
          :disabled="disabled"
          @change="r.setEffect(($event.target as HTMLSelectElement).value as RevealEffect['kind'])"
        >
          <option v-for="(label, k) in effectLabels" :key="k" :value="k">{{ label }}</option>
        </select></label
      >
      <label class="stacked-label"
        >推进方式<select
          aria-label="显现推进方式"
          :value="clip.progress.kind"
          :disabled="disabled"
          @change="progress(($event.target as HTMLSelectElement).value)"
        >
          <option value="elapsed">Timeline · 触发后计时</option>
          <option value="slider-timeline" :disabled="!sliders.length">
            Timeline · Slider 时间进度
          </option>
          <option value="slider-follow" :disabled="!sliders.length">
            Follow · Slider 有效追踪
          </option>
        </select></label
      >
      <label v-if="clip.progress.kind !== 'elapsed'" class="stacked-label"
        >进度来源 Slider<select
          aria-label="显现进度 Slider"
          :disabled="disabled"
          :value="clip.progress.noteId"
          @change="
            r.patch({
              progress: {
                kind: clip.progress.kind as 'slider-timeline' | 'slider-follow',
                noteId: ($event.target as HTMLSelectElement).value,
              },
            })
          "
        >
          <option v-for="n in sliders" :key="n.id" :value="n.id">{{ noteLabel(n.id) }}</option>
        </select></label
      >
      <p v-if="clip.progress.kind === 'slider-follow'" class="help-text">
        只累加有效追踪的时长，松键或偏离会停止增长，恢复追踪后继续。完成判定不会自动补满路径进度。
      </p>
      <div class="two-fields">
        <label
          >延迟 / 秒<NumberField
            aria-label="显现延迟"
            type="number"
            :precision="6"
            min="0"
            step="0.01"
            :disabled="disabled"
            :value="(clip.delayUs ?? 0) / 1e6"
            @commit="r.patch({ delayUs: Math.max(0, Math.round(Number($event) * 1e6)) })"
        /></label>
        <label v-if="clip.progress.kind === 'elapsed'"
          >时长 / 秒<NumberField
            aria-label="显现时长"
            type="number"
            :precision="6"
            min="0"
            step="0.01"
            :disabled="disabled"
            :value="r.range(clip).duration / 1e6"
            @commit="
              r.patch({
                progress: {
                  kind: 'elapsed',
                  duration: {
                    basis: 'time',
                    durationUs: Math.max(0, Math.round(Number($event) * 1e6)),
                  },
                },
              })
            "
        /></label>
      </div>
      <div class="two-fields">
        <label
          >缓动<select
            aria-label="显现缓动"
            :disabled="disabled"
            :value="typeof clip.easing === 'string' ? clip.easing : 'linear'"
            @change="r.patch({ easing: ($event.target as HTMLSelectElement).value as Easing })"
          >
            <option value="linear">线性</option>
            <option value="ease-in">渐快</option>
            <option value="ease-out">渐慢</option>
            <option value="ease-in-out">两端平缓</option>
          </select></label
        ><label
          >结束状态<select
            aria-label="显现结束状态"
            :disabled="disabled"
            :value="clip.after"
            @change="
              r.patch({ after: ($event.target as HTMLSelectElement).value as 'hold' | 'restore' })
            "
          >
            <option value="hold">保留结果</option>
            <option value="restore">恢复初始状态</option>
          </select></label
        >
      </div>
      <div v-if="e.kind === 'slide-in'" class="two-fields">
        <label
          >起始偏移 X<NumberField
            aria-label="滑入偏移 X"
            type="number"
            :precision="2"
            step="1"
            :disabled="disabled"
            :value="e.offset.x"
            @commit="r.patchEffect({ offset: { ...e.offset, x: Number($event) } })" /></label
        ><label
          >起始偏移 Y<NumberField
            aria-label="滑入偏移 Y"
            type="number"
            :precision="2"
            step="1"
            :disabled="disabled"
            :value="e.offset.y"
            @commit="r.patchEffect({ offset: { ...e.offset, y: Number($event) } })"
        /></label>
      </div>
      <div v-if="e.kind === 'pop'" class="two-fields">
        <label
          >初始缩放<NumberField
            aria-label="弹出初始缩放"
            type="number"
            :precision="3"
            min="0.01"
            step="0.05"
            :disabled="disabled"
            :value="e.fromScale"
            @commit="r.patchEffect({ fromScale: Number($event) })" /></label
        ><label
          >弹性幅度<NumberField
            aria-label="弹出弹性"
            type="number"
            :precision="3"
            min="0"
            step="0.05"
            :disabled="disabled"
            :value="e.overshoot"
            @commit="r.patchEffect({ overshoot: Number($event) })"
        /></label>
      </div>
      <label v-if="e.kind === 'directional'" class="stacked-label"
        >方向 / 度<NumberField
          aria-label="方向显现角度"
          type="number"
          :precision="2"
          step="1"
          :disabled="disabled"
          :value="Math.round((Math.atan2(e.direction.y, e.direction.x) * 180) / Math.PI)"
          @commit="
            r.patchEffect({
              direction: {
                x: Math.cos((Number($event) * Math.PI) / 180),
                y: Math.sin((Number($event) * Math.PI) / 180),
              },
            })
          "
      /></label>
      <FanProperties v-if="e.kind === 'fan'" :controller="r" :effect="e" :disabled="disabled" />
      <OutlineProperties
        v-if="e.kind === 'outline'"
        :controller="r"
        :effect="e"
        :disabled="disabled"
        :closed="r.path.value?.closed ?? false"
        :following="clip.progress.kind === 'slider-follow'"
      />
      <template v-if="e.kind === 'path' || e.kind === 'outline'">
        <label class="stacked-label"
          >路径引用<select
            aria-label="显现路径引用"
            :disabled="disabled || !!e.linkedSliderId"
            :value="e.path.pathId"
            @change="
              r.patchEffect({
                path: { ...e.path, pathId: ($event.target as HTMLSelectElement).value },
              })
            "
          >
            <option
              v-for="p in Object.values(editor.project.value.paths)"
              :key="p.id"
              :value="p.id"
            >
              {{ p.name }}
            </option>
          </select></label
        >
        <label v-if="e.kind === 'path'" class="stacked-label"
          >遮罩宽度 / 插画像素<NumberField
            aria-label="显现遮罩宽度"
            type="number"
            :precision="2"
            step="1"
            min="0.1"
            :disabled="disabled"
            :value="e.maskWidth"
            @commit="r.patchEffect({ maskWidth: Number($event) })"
        /></label>
        <label v-if="e.kind === 'path'" class="stacked-label"
          >路径走完后<select
            aria-label="路径完成方式"
            :disabled="disabled"
            :value="e.completion"
            @change="r.patchEffect({ completion: ($event.target as HTMLSelectElement).value })"
          >
            <option value="keep-mask">保留路径遮罩</option>
            <option value="show-full-layer">100% 后显示整层</option>
          </select></label
        >
        <p v-if="e.kind === 'path' && e.completion === 'keep-mask'" class="help-text">
          “保留路径遮罩”会一直隐藏路径覆盖范围以外的像素。需要完整图层时，请选“100%
          后显示整层”，或使用“描边后整层显现”。
        </p>
        <label v-if="r.path.value" class="checkbox-label reveal-checkbox"
          ><input
            type="checkbox"
            aria-label="闭合显现路径"
            :disabled="disabled"
            :checked="r.path.value.closed"
            @change="
              r.setPath({ ...r.path.value, closed: ($event.target as HTMLInputElement).checked })
            "
          />闭合路径</label
        >
        <label class="stacked-label"
          >来自 Slider<select v-model="sliderId" aria-label="复制关联 Slider" :disabled="disabled">
            <option value="" disabled>先创建 Slider</option>
            <option v-for="n in sliders" :key="n.id" :value="n.id">{{ noteLabel(n.id) }}</option>
          </select></label
        >
        <div class="note-actions">
          <button :disabled="disabled || !sliderId" @click="r.useSlider(sliderId, false)">
            复制 Slider 路径</button
          ><button :disabled="disabled || !sliderId" @click="r.useSlider(sliderId, true)">
            关联 Slider 路径</button
          ><button v-if="e.linkedSliderId" :disabled="disabled" @click="r.detach()">
            解除关联
          </button>
        </div>
        <p class="help-text">
          {{
            e.linkedSliderId
              ? '已关联：节点、方向和 Slider 位置同步修改。需要独立调整时先解除关联。'
              : '独立路径：可以自由调整，不影响 Slider。坐标使用插画原始像素。'
          }}
        </p>
        <div class="note-actions">
          <button
            :disabled="disabled"
            :aria-pressed="r.pathEditing.value"
            @click="r.pathEditing.value ? r.cancel() : r.editPath()"
          >
            {{ r.pathEditing.value ? '结束显现路径编辑' : '编辑显现路径' }}</button
          ><button :disabled="disabled" @click="r.startDrawing()">独立绘制路径</button
          ><button :disabled="disabled" @click="r.reverse()">反转显现路径</button>
        </div>
        <template v-if="r.pathEditing.value && r.path.value">
          <p class="help-text">
            {{
              r.drawing.value
                ? '依次点击画布放置节点，Enter / 双击完成，Esc 取消。'
                : '拖动方形节点和圆形控制柄；双击路径添加节点。'
            }}
          </p>
          <div v-if="r.drawing.value" class="note-actions">
            <button :disabled="r.draftPoints.value.length < 2" @click="r.finishDrawing()">
              完成显现路径
            </button>
          </div>
          <template v-else
            ><label class="stacked-label"
              >路径类型<select
                aria-label="显现路径类型"
                :value="r.path.value.interpolation ?? 'bezier'"
                @change="
                  r.setPath({
                    ...r.path.value,
                    interpolation: ($event.target as HTMLSelectElement).value as
                      'bezier' | 'polyline',
                  })
                "
              >
                <option value="bezier">贝塞尔曲线</option>
                <option value="polyline">折线</option>
              </select></label
            >
            <div class="note-actions">
              <button @click="r.addNode()">显现路径添加节点</button
              ><button :disabled="!r.node.value" @click="smooth">平滑显现节点</button
              ><button :disabled="!r.node.value" @click="r.deleteNode()">删除显现节点</button>
            </div></template
          >
        </template>
      </template>
      <template v-if="c.mode.value === 'edit'">
        <label class="checkbox-label reveal-checkbox"
          ><input
            v-model="r.audition.value"
            type="checkbox"
            aria-label="编辑中预览演出"
          />编辑中按播放头预览演出</label
        >
        <label class="stacked-label"
          >单独查看进度
          {{ r.override.value === null ? '· 跟随播放头' : `${Math.round(r.override.value * 100)}%`
          }}<input
            aria-label="显现预览进度"
            type="range"
            min="0"
            max="100"
            :value="(r.override.value ?? state?.rawProgress ?? 0) * 100"
            @input="r.override.value = Number(($event.target as HTMLInputElement).value) / 100"
        /></label>
        <div class="note-actions">
          <button @click="r.override.value = null">跟随播放头</button
          ><button :disabled="disabled" @click="r.remove()">删除显现绑定</button>
        </div>
      </template>
      <p class="help-text">
        编辑和预览都会按播放头显示演出。对齐路径时，可在画布顶部勾选“完整素材”；试玩按真实输入显现。图层显示开关与分组可见性始终生效。
      </p>
    </template>
    <p v-else class="help-text">
      选择音符与 PSD / PNG 图层，添加一个绑定。同一音符可以添加多条绑定来控制不同图层。
    </p>
  </section>
</template>
