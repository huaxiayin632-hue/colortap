<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { hasRevealPath } from '../../core/reveal';
import type { Editor } from '../state/editor';
import type { Note } from '../../shared/models';
import { ArcPath } from '../../core/path';
import { noteHead } from '../../core/chart';
import CommitInput from '../panels/CommitInput.vue';
const props = defineProps<{ editor: Editor }>();
const c = props.editor.chart;
const note = computed(() => c.selectedNote.value),
  path = computed(() => c.selectedPath.value),
  node = computed(() => c.selectedNode.value);
const disabled = computed(() => props.editor.busy.value || c.mode.value !== 'edit');
const sourceClipId = ref('');
const sourcePaths = computed(() =>
  Object.values(c.document.value.reveals).filter(
    (clip) =>
      hasRevealPath(clip.effect) &&
      (!clip.effect.linkedSliderId || clip.effect.linkedSliderId === note.value?.id),
  ),
);
watch(
  sourcePaths,
  (paths) => {
    if (!paths.some((p) => p.id === sourceClipId.value)) sourceClipId.value = paths[0]?.id ?? '';
  },
  { immediate: true },
);
const pastMusicEnd = computed(
  () =>
    note.value &&
    props.editor.playback.value.ready &&
    c.tempo.value.resolve(note.value.at) + c.duration.value >
      props.editor.playback.value.durationUs,
);
const head = computed(() =>
  note.value ? noteHead(note.value, c.document.value.paths) : { x: 0, y: 0 },
);
const length = computed(() =>
  note.value?.kind === 'slider' && path.value
    ? new ArcPath(path.value, note.value.path.transform).length
    : 0,
);
function position(axis: 'x' | 'y', value: string): void {
  const n = note.value ? structuredClone(note.value) : null;
  if (!n || !Number.isFinite(Number(value))) return;
  if (n.kind !== 'slider') n.position[axis] = Number(value);
  else n.path.transform.position[axis] += Number(value) - head.value[axis];
  c.setNote(n);
}
function radius(value: string): void {
  const n = note.value ? structuredClone(note.value) : null;
  if (!n) return;
  if (n.kind !== 'slider') n.radius = Number(value);
  else n.headRadius = Number(value);
  c.setNote(n);
}
function sliderPatch(patch: Partial<Extract<Note, { kind: 'slider' }>>): void {
  if (note.value?.kind === 'slider') c.setNote({ ...note.value, ...patch });
}
function changePathKind(value: string): void {
  if (path.value) c.setPath({ ...path.value, interpolation: value as 'bezier' | 'polyline' });
}
function nodeMode(value: string): void {
  const currentPath = path.value,
    currentNode = node.value;
  if (currentPath && currentNode)
    c.setPath({
      ...currentPath,
      nodes: currentPath.nodes.map((n) =>
        n.id === currentNode.id ? { ...n, mode: value as 'corner' | 'aligned' | 'mirrored' } : n,
      ),
    });
}
</script>
<template>
  <section
    v-if="c.selected.value.length"
    class="property-section note-inspector"
    aria-label="音符属性"
  >
    <h2>
      {{
        note
          ? note.kind === 'circle'
            ? 'Circle'
            : note.kind === 'hold'
              ? '长按音符'
              : 'Slider'
          : `已选择 ${c.selected.value.length} 个音符`
      }}
    </h2>
    <div class="note-actions">
      <button :disabled="disabled" @click="c.duplicate()" title="Ctrl+D">复制</button>
      <button :disabled="disabled" @click="c.removeNotes()">删除音符</button>
      <button :disabled="disabled" @click="c.selectAll()">全选</button>
    </div>
    <template v-if="note">
      <label class="stacked-label"
        >判定时间 / 秒<CommitInput
          aria-label="音符时间"
          type="number"
          min="0"
          step="0.001"
          :disabled="disabled"
          :value="c.tempo.value.resolve(note.at) / 1000000"
          @commit="c.setNoteTime(note.id, Number($event) * 1000000)"
      /></label>
      <label class="stacked-label compact-label"
        >时间基准<select
          aria-label="音符时间基准"
          :disabled="disabled"
          :value="note.at.basis"
          @change="c.setTimeBasis(($event.target as HTMLSelectElement).value as 'time' | 'beat')"
        >
          <option value="beat">随 BPM 的节拍</option>
          <option value="time">固定音乐时间</option>
        </select></label
      >
      <div class="two-fields">
        <label
          >X<CommitInput
            aria-label="音符 X"
            type="number"
            :value="Number(head.x.toFixed(3))"
            :disabled="disabled"
            @commit="position('x', $event)" /></label
        ><label
          >Y<CommitInput
            aria-label="音符 Y"
            type="number"
            :value="Number(head.y.toFixed(3))"
            :disabled="disabled"
            @commit="position('y', $event)"
        /></label>
      </div>
      <div class="two-fields">
        <label
          >半径<CommitInput
            aria-label="音符半径"
            type="number"
            min="1"
            :value="note.kind !== 'slider' ? note.radius : note.headRadius"
            :disabled="disabled"
            @commit="radius($event)" /></label
        ><label v-if="note.kind === 'slider'"
          >追踪半径<CommitInput
            aria-label="追踪半径"
            type="number"
            min="1"
            :value="note.followRadius"
            :disabled="disabled"
            @commit="sliderPatch({ followRadius: Number($event) })"
        /></label>
      </div>
      <template v-if="note.kind === 'hold'">
        <p class="help-text">
          旧工程兼容音符。新谱面只提供 Circle 和 Slider；转换会保留 ID、起始时间和绑定，并可撤销。
        </p>
        <button :disabled="disabled" @click="editor.edit({ type: 'convert-hold', id: note.id })">
          转换为 Circle
        </button>
      </template>
      <template v-if="note.kind === 'slider' && path">
        <div class="two-fields">
          <label
            >持续 / 秒<CommitInput
              aria-label="Slider 持续秒数"
              type="number"
              min="0.001"
              step="0.125"
              :value="Number((c.duration.value / 1000000).toFixed(6))"
              :disabled="disabled"
              @commit="c.setDuration(Number($event))" /></label
          ><label
            >持续 / 拍<CommitInput
              aria-label="Slider 持续拍数"
              type="number"
              min="0.001"
              step="0.25"
              :value="
                note.duration.basis === 'beat'
                  ? note.duration.ticks / 960
                  : Number(
                      (
                        (c.tempo.value.timeToTick(
                          c.tempo.value.resolve(note.at) + c.duration.value,
                        ) -
                          c.tempo.value.timeToTick(c.tempo.value.resolve(note.at))) /
                        960
                      ).toFixed(4),
                    )
              "
              :disabled="disabled"
              @commit="c.setDurationBeats(Number($event))"
          /></label>
        </div>
        <label class="stacked-label compact-label"
          >移动速度 / 逻辑单位每秒<CommitInput
            aria-label="Slider 速度"
            type="number"
            min="1"
            :disabled="disabled"
            :value="Number((length / Math.max(0.000001, c.duration.value / 1000000)).toFixed(3))"
            @commit="c.setSpeed(Number($event))"
        /></label>
        <div class="two-fields">
          <label
            >路径类型<select
              aria-label="路径类型"
              :disabled="disabled"
              :value="path.interpolation ?? 'bezier'"
              @change="changePathKind(($event.target as HTMLSelectElement).value)"
            >
              <option value="bezier">贝塞尔</option>
              <option value="polyline">折线</option>
            </select></label
          ><label
            >滑动方向<select
              aria-label="滑动方向"
              :disabled="disabled"
              :value="note.path.reversed ? 'reverse' : 'forward'"
              @change="
                sliderPatch({
                  path: {
                    ...note.path,
                    reversed: ($event.target as HTMLSelectElement).value === 'reverse',
                  },
                })
              "
            >
              <option value="forward">正向 →</option>
              <option value="reverse">反向 ←</option>
            </select></label
          >
        </div>
        <label class="stacked-label compact-label"
          >定位方式<select
            aria-label="Slider 贴合图层"
            :disabled="disabled"
            :value="note.binding?.layerId ?? ''"
            @change="c.bindLayer(($event.target as HTMLSelectElement).value || null)"
          >
            <option value="">自由放置</option>
            <option
              v-for="layer in Object.values(editor.project.value.layers)"
              :key="layer.id"
              :value="layer.id"
            >
              贴合 · {{ layer.name }}
            </option>
          </select></label
        >
        <p v-if="note.binding" class="help-text">
          随图层和镜头移动。切回自由放置会保留当前画面位置。
        </p>
        <div v-if="sourcePaths.length" class="stacked-label compact-label">
          <label
            >已有描边路径<select
              aria-label="复用图层描边"
              v-model="sourceClipId"
              :disabled="disabled"
            >
              <option v-for="clip in sourcePaths" :key="clip.id" :value="clip.id">
                {{ editor.project.value.layers[clip.layerId]?.name }} ·
                {{ clip.effect.kind === 'outline' ? '轮廓描边' : '路径显现' }}
              </option>
            </select></label
          >
          <button :disabled="disabled || !sourceClipId" @click="c.useRevealPath(sourceClipId)">
            贴合这条路径
          </button>
          <p class="help-text">共用曲线节点；编辑节点会同时更新描边和 Slider。</p>
        </div>
        <label class="stacked-label compact-label"
          >复用路径<select
            aria-label="Slider 路径"
            :disabled="disabled"
            :value="note.path.pathId"
            @change="
              sliderPatch({
                path: { ...note.path, pathId: ($event.target as HTMLSelectElement).value },
              })
            "
          >
            <option
              v-for="item in Object.values(editor.project.value.paths)"
              :key="item.id"
              :value="item.id"
            >
              {{ item.name }} · {{ item.nodes.length }} 节点
            </option>
          </select></label
        >
        <div class="note-actions">
          <button :disabled="disabled" @click="c.setTool('path')">编辑路径</button
          ><button
            :disabled="disabled"
            :aria-pressed="c.appendMode.value"
            @click="c.toggleAppend()"
          >
            {{ c.appendMode.value ? '结束追加' : '追加拐点' }}</button
          ><button :disabled="disabled" @click="c.addNode()">添加节点</button
          ><button :disabled="disabled || !node" @click="c.deleteNode()">删除节点</button>
        </div>
        <label class="stacked-label"
          >路径节点<select
            aria-label="路径节点"
            :disabled="disabled"
            :value="c.nodeId.value ?? ''"
            @change="c.nodeId.value = ($event.target as HTMLSelectElement).value"
          >
            <option value="" disabled>点击画布中的方形节点</option>
            <option v-for="(item, i) in path.nodes" :key="item.id" :value="item.id">
              节点 {{ i + 1 }}
            </option>
          </select></label
        >
        <template v-if="node">
          <div class="two-fields">
            <label
              >节点 X<CommitInput
                aria-label="节点 X"
                type="number"
                :disabled="disabled"
                :value="Number(node.point.x.toFixed(3))"
                @commit="c.editNode('point', 'x', Number($event))" /></label
            ><label
              >节点 Y<CommitInput
                aria-label="节点 Y"
                type="number"
                :disabled="disabled"
                :value="Number(node.point.y.toFixed(3))"
                @commit="c.editNode('point', 'y', Number($event))"
            /></label>
          </div>
          <template v-if="path.interpolation !== 'polyline'">
            <div
              v-for="field in ['handleIn', 'handleOut'] as const"
              :key="field"
              class="two-fields"
            >
              <label
                >{{ field === 'handleIn' ? '入柄' : '出柄' }} X<CommitInput
                  :aria-label="`${field === 'handleIn' ? '入柄' : '出柄'} X`"
                  type="number"
                  :disabled="disabled"
                  :value="Number(node[field].x.toFixed(3))"
                  @commit="c.editNode(field, 'x', Number($event))" /></label
              ><label
                >Y<CommitInput
                  :aria-label="`${field === 'handleIn' ? '入柄' : '出柄'} Y`"
                  type="number"
                  :disabled="disabled"
                  :value="Number(node[field].y.toFixed(3))"
                  @commit="c.editNode(field, 'y', Number($event))"
              /></label>
            </div>
            <div class="note-actions">
              <button :disabled="disabled" @click="c.smoothNode()">平滑此节点</button>
            </div>
            <select
              aria-label="控制柄模式"
              :disabled="disabled"
              :value="node.mode"
              @change="nodeMode(($event.target as HTMLSelectElement).value)"
            >
              <option value="corner">独立控制柄</option>
              <option value="aligned">方向对齐</option>
              <option value="mirrored">镜像控制柄</option>
            </select>
          </template>
        </template>
        <p class="help-text">
          长度 {{ length.toFixed(1) }} · 节点
          {{
            path.nodes.length
          }}。拖动方形节点或圆形柄；双击路径添点。「追加拐点」可在末尾连续延长，Esc
          结束。复用同一路径时，节点修改会同步到所有引用它的 Slider。
        </p>
      </template>
    </template>
    <template v-else
      ><label class="stacked-label"
        >批量时间偏移 / 秒<CommitInput
          aria-label="批量时间偏移"
          type="number"
          step="0.125"
          :disabled="disabled"
          :value="0"
          @commit="c.shiftNotes(Number($event) * 1000000)" /></label
    ></template>
    <p class="help-text">
      时间编辑使用时间轴的节拍吸附。Ctrl+D 复制，Shift 多选，Delete 删除；中键或 Alt 拖动平移。
    </p>
    <p v-if="pastMusicEnd" class="help-text error-text">
      音符超出音乐结尾，试玩时不能完整播放；请调整时间或时长。
    </p>
  </section>
</template>
