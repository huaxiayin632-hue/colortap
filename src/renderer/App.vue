<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, provide, ref, watch } from 'vue';
import { createEditor } from './state/editor';
import { formatTime } from '../core/timing';
import CanvasPanel from './panels/CanvasPanel.vue';
import CommitInput from './panels/CommitInput.vue';
import NumberField, { numberGestureKey } from './panels/NumberField.vue';
import ResourcePanel from './workspace/ResourcePanel.vue';
import PanelDivider from './workspace/PanelDivider.vue';
import { useWorkspace } from './workspace/use-workspace';
import type { SectionId } from './workspace/layout';
import LayerInspector from './panels/LayerInspector.vue';
import TimelinePanel from './timeline/TimelinePanel.vue';
import NoteInspector from './chart/NoteInspector.vue';
import PlaytestPanel from './chart/PlaytestPanel.vue';
import RevealPanel from './reveals/RevealPanel.vue';
import SoundPanel from './audio/SoundPanel.vue';
import AnalysisPanel from './audio/AnalysisPanel.vue';
import CameraPanel from './camera/CameraPanel.vue';
import type { ChartTool } from './chart/controller';

const editor = createEditor();
const workspace = useWorkspace();
const { layout, size: layoutSize, focus: canvasFocus, storageError } = workspace;
function weights(values: Partial<Record<SectionId, number>>) {
  for (const [id, weight] of Object.entries(values))
    layout.value.sections[id as SectionId].weight = weight!;
}
const shellStyle = computed(() => ({
  gridTemplateRows:
    '88px 34px minmax(0, 1fr) ' +
    layoutSize.value.timelineHandle +
    'px ' +
    layoutSize.value.timeline +
    'px 27px',
}));
const workspaceStyle = computed(() => ({
  gridTemplateColumns:
    [layoutSize.value.left, layoutSize.value.leftHandle].map((v) => v + 'px').join(' ') +
    ' minmax(0, 1fr) ' +
    [layoutSize.value.rightHandle, layoutSize.value.right].map((v) => v + 'px').join(' '),
}));
provide(numberGestureKey, { begin: editor.beginGesture, end: editor.endGesture });
const inspectorTab = ref<'objects' | 'sounds' | 'camera' | 'music'>('objects');
const inspectorScroll = ref<HTMLElement>();
function showInspector(tab: typeof inspectorTab.value) {
  inspectorTab.value = tab;
  if (inspectorScroll.value) inspectorScroll.value.scrollTop = 0;
}
watch(inspectorTab, () => {
  if (inspectorScroll.value) inspectorScroll.value.scrollTop = 0;
});
watch([editor.selectedSoundId, editor.selectedSoundAssetId], (ids) => {
  if (ids.some(Boolean)) inspectorTab.value = 'sounds';
});
watch([editor.camera.selectedId, editor.camera.selectedShake], (ids) => {
  if (ids.some(Boolean)) inspectorTab.value = 'camera';
});
watch(editor.analysis.selectedOnset, (value) => {
  if (value !== null) showInspector('music');
});
watch(editor.camera.tool, (tool) => {
  if (tool !== 'none') inspectorTab.value = 'camera';
});
watch(editor.chart.tool, (tool) => {
  if (tool !== 'layers') editor.camera.tool.value = 'none';
});
const showNew = ref(false);
const draft = ref({ name: '新工程', width: 6000, height: 6000 });
const newError = ref('');
const showPerformance = ref(false);
const readOnlySettings = computed(() => editor.busy.value || editor.chart.mode.value !== 'edit');
const totalPrivateMiB = computed(
  () =>
    editor.performanceSample.value?.processes.reduce(
      (sum, item) => sum + (item.privateKiB ?? 0),
      0,
    ) ?? 0,
);
const memoryLabel = computed(() =>
  editor.performanceSample.value ? `${(totalPrivateMiB.value / 1024).toFixed(0)} MiB` : '采样中',
);
const musicDuration = computed(() => formatTime(editor.playback.value.durationUs));
const projectPath = computed(() => editor.session.value?.filePath ?? '尚未保存到文件');
const snapshotLabel = computed(() =>
  editor.recoveryError.value
    ? '恢复快照写入失败'
    : editor.recoveryWriting.value
      ? '正在保留恢复快照…'
      : editor.recoveryTime.value
        ? `恢复快照 ${new Date(editor.recoveryTime.value).toLocaleTimeString()}`
        : '自动恢复：每 15 秒',
);
const stageMetrics = computed(() => {
  editor.zoom.value;
  editor.sceneRevision.value;
  return editor.stage.value?.metrics() ?? null;
});

async function create(): Promise<void> {
  newError.value = '';
  if (
    !draft.value.name.trim() ||
    ![draft.value.width, draft.value.height].every(
      (value) => Number.isSafeInteger(value) && value > 0,
    )
  ) {
    newError.value = '请输入工程名称和大于零的整数尺寸。';
    return;
  }
  if (
    await editor.newDocument(draft.value.name, {
      width: draft.value.width,
      height: draft.value.height,
    })
  )
    showNew.value = false;
}
function changeSize(axis: 'width' | 'height', value: string, output = false): void {
  const size = {
    ...(output ? editor.project.value.output.size : editor.project.value.stage.artworkSize),
    [axis]: Number(value),
  };
  editor.edit({ type: output ? 'resize-output' : 'resize-artwork', size });
}
function keydown(event: KeyboardEvent): void {
  const target = event.target as HTMLElement;
  const editingText =
    (['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName) &&
      !(
        target instanceof HTMLInputElement &&
        ['range', 'checkbox', 'radio', 'button'].includes(target.type)
      )) ||
    target.isContentEditable;
  const modal = Boolean(document.querySelector('.modal-backdrop, [role="dialog"]'));
  // Tab remains normal focus navigation everywhere except the canvas itself.
  if (
    event.key === 'Tab' &&
    !event.shiftKey &&
    !event.ctrlKey &&
    !event.altKey &&
    !event.metaKey &&
    !event.repeat &&
    !modal &&
    !editor.busy.value &&
    target.matches('.canvas-host, .canvas-host canvas')
  ) {
    event.preventDefault();
    canvasFocus.value = !canvasFocus.value;
    return;
  }
  if (
    !editingText &&
    !modal &&
    editor.reveals.pathEditing.value &&
    editor.chart.mode.value === 'edit'
  ) {
    if (event.key === 'Escape') {
      event.preventDefault();
      editor.reveals.cancel();
      return;
    }
    if (event.key === 'Enter' && editor.reveals.drawing.value) {
      event.preventDefault();
      editor.reveals.finishDrawing();
      return;
    }
    if (event.key === 'Delete') {
      event.preventDefault();
      editor.reveals.deleteNode();
      return;
    }
  }
  if (
    editor.chart.mode.value === 'playtest' &&
    !editingText &&
    !modal &&
    !event.ctrlKey &&
    !event.metaKey &&
    ['KeyZ', 'KeyX'].includes(event.code)
  ) {
    event.preventDefault();
    if (!event.repeat) editor.chart.input(event.code, true);
    return;
  }
  if (modal && !((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's')) return;
  if ((event.ctrlKey || event.metaKey) && !event.altKey) {
    const key = event.key.toLowerCase();
    if (key === 's') {
      event.preventDefault();
      void editor.save(event.shiftKey);
    }
    if (key === 'o') {
      event.preventDefault();
      if (!showNew.value) void editor.open();
    }
    if (key === 'n') {
      event.preventDefault();
      showNew.value = true;
    }
    if (!editingText && key === 'z') {
      event.preventDefault();
      void (event.shiftKey ? editor.redo() : editor.undo());
    }
    if (!editingText && key === 'y') {
      event.preventDefault();
      void editor.redo();
    }
    if (
      !editingText &&
      editor.chart.mode.value === 'edit' &&
      editor.chart.tool.value !== 'layers'
    ) {
      if (key === 'a') {
        event.preventDefault();
        editor.chart.selectAll();
      }
      if (key === 'd') {
        event.preventDefault();
        editor.chart.duplicate();
      }
      if (key === 'c') {
        event.preventDefault();
        editor.chart.copy();
      }
      if (key === 'v') {
        event.preventDefault();
        editor.chart.paste();
      }
    }
  } else if (
    event.code === 'Space' &&
    !editingText &&
    !showNew.value &&
    !editor.confirmReplacement.value
  ) {
    event.preventDefault();
    void editor.togglePlay();
  } else if (
    event.key === 'Delete' &&
    !editingText &&
    !showNew.value &&
    !showPerformance.value &&
    !document.querySelector('[role="dialog"]') &&
    !editor.confirmReplacement.value
  ) {
    event.preventDefault();
    if (editor.chart.mode.value === 'edit' && inspectorTab.value === 'camera') {
      if (editor.camera.selectedShake.value)
        editor.edit({ type: 'delete-shake', id: editor.camera.selectedShake.value });
      else editor.camera.remove();
      return;
    }
    if (
      editor.chart.mode.value === 'edit' &&
      inspectorTab.value === 'sounds' &&
      editor.selectedSoundId.value
    ) {
      editor.edit({ type: 'delete-sound', id: editor.selectedSoundId.value });
      return;
    }
    if (editor.chart.mode.value === 'edit' && editor.chart.tool.value !== 'layers') {
      if (editor.chart.tool.value === 'path' && editor.chart.nodeId.value)
        editor.chart.deleteNode();
      else editor.chart.removeNotes();
    } else editor.deleteSelectedLayer();
  } else if (!editingText && editor.chart.mode.value === 'edit' && !event.altKey) {
    const tools: Record<string, ChartTool> = {
      v: 'select',
      c: 'circle',
      s: 'slider',
      p: 'path',
      l: 'layers',
    };
    if (tools[event.key.toLowerCase()]) {
      event.preventDefault();
      editor.chart.setTool(tools[event.key.toLowerCase()]);
    }
    if (
      event.key === 'Enter' &&
      editor.chart.tool.value === 'slider' &&
      (editor.chart.sliderDraft.value?.nodes.length ?? 0) >= 2
    ) {
      event.preventDefault();
      editor.chart.finishSlider();
    }
    if (event.key === 'Escape') {
      editor.chart.cancelGesture();
      editor.chart.choose([]);
    }
  } else if (!editingText && event.key === 'Escape') {
    editor.chart.setMode('edit');
  }
}
function keyup(event: KeyboardEvent): void {
  if (['KeyZ', 'KeyX'].includes(event.code)) editor.chart.input(event.code, false);
}
function visibility(): void {
  if (document.hidden) editor.pause();
}
function blur(): void {
  editor.pause();
}
watch([editor.project, editor.dirty], () => {
  document.title = `${editor.dirty.value ? '● ' : ''}${editor.project.value.name} — Rhythm Canvas`;
});
onMounted(() => {
  void editor.initialize();
  window.addEventListener('keydown', keydown);
  window.addEventListener('keyup', keyup);
  document.addEventListener('visibilitychange', visibility);
  window.addEventListener('blur', blur);
});
onBeforeUnmount(() => {
  window.removeEventListener('keydown', keydown);
  window.removeEventListener('keyup', keyup);
  document.removeEventListener('visibilitychange', visibility);
  window.removeEventListener('blur', blur);
  void editor.dispose();
});
</script>

<template>
  <div
    class="editor-shell"
    :aria-busy="editor.busy.value"
    :style="shellStyle"
    :data-canvas-focus="canvasFocus"
  >
    <header class="main-toolbar">
      <div class="toolbar-row project-row">
        <div class="brand">
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="M3 9v6M9 4v16M15 7v10M21 10v4" /></svg
          ><strong>Rhythm Canvas</strong><span class="version">0.5.0</span>
        </div>
        <div class="toolbar-group">
          <button :disabled="editor.busy.value" title="Ctrl+N" @click="showNew = true">新建</button>
          <button :disabled="editor.busy.value" title="Ctrl+O" @click="editor.open()">打开</button>
          <button :disabled="editor.busy.value" title="Ctrl+S" @click="editor.save()">保存</button>
          <button :disabled="editor.busy.value" title="Ctrl+Shift+S" @click="editor.save(true)">
            另存为
          </button>
        </div>
        <div class="toolbar-group history-group">
          <button
            aria-label="撤销"
            title="撤销 Ctrl+Z"
            :disabled="
              !editor.canUndo.value || editor.busy.value || editor.chart.mode.value !== 'edit'
            "
            @click="editor.undo()"
          >
            ↶</button
          ><button
            aria-label="重做"
            title="重做 Ctrl+Y"
            :disabled="
              !editor.canRedo.value || editor.busy.value || editor.chart.mode.value !== 'edit'
            "
            @click="editor.redo()"
          >
            ↷
          </button>
        </div>
        <span class="project-name" data-testid="project-name"
          >{{ editor.project.value.name
          }}<span v-if="editor.dirty.value" class="unsaved-dot" title="有未保存的修改"
            >●</span
          ></span
        >
        <span class="toolbar-spacer" />
        <div class="mode-switch" aria-label="编辑模式">
          <button
            :class="{ selected: editor.chart.mode.value === 'edit' }"
            :aria-pressed="editor.chart.mode.value === 'edit'"
            :disabled="editor.busy.value"
            @click="editor.chart.setMode('edit')"
          >
            编辑
          </button>
          <button
            :class="{ selected: editor.chart.mode.value === 'preview' }"
            :aria-pressed="editor.chart.mode.value === 'preview'"
            :disabled="editor.busy.value"
            @click="editor.chart.setMode('preview')"
          >
            预览
          </button>
          <button
            :class="{ selected: editor.chart.mode.value === 'playtest' }"
            :aria-pressed="editor.chart.mode.value === 'playtest'"
            :disabled="editor.busy.value"
            @click="editor.chart.setMode('playtest')"
          >
            试玩
          </button>
        </div>
      </div>
      <div class="toolbar-row transport-row">
        <button class="import-button" :disabled="editor.busy.value" @click="editor.importMusic()">
          <span aria-hidden="true">＋</span> 导入音乐
        </button>
        <div class="transport-buttons">
          <button
            aria-label="回到开头"
            :disabled="!editor.playback.value.ready || editor.busy.value"
            @click="editor.seek(0)"
          >
            |◀</button
          ><button
            class="play-button"
            :aria-label="editor.playback.value.playing ? '暂停' : '播放'"
            :disabled="!editor.playback.value.ready || editor.busy.value"
            @click="editor.togglePlay()"
          >
            {{ editor.playback.value.playing ? 'Ⅱ' : '▶' }}
          </button>
        </div>
        <output class="time-display" data-testid="current-time">{{
          formatTime(editor.playback.value.timeUs)
        }}</output
        ><span class="duration-display">/ {{ musicDuration }}</span>
        <label class="bpm-inline"
          >BPM<NumberField
            aria-label="BPM"
            type="number"
            :precision="3"
            min="0.001"
            step="1"
            :disabled="readOnlySettings"
            :value="editor.project.value.timing.points[0].bpm"
            @commit="editor.edit({ type: 'set-bpm', bpm: Number($event) })"
        /></label>
        <button @click="showInspector('music')">音乐卡点</button>
        <span class="toolbar-spacer" />
        <label class="volume-control"
          >音量<CommitInput
            aria-label="音乐音量"
            type="range"
            min="0"
            max="100"
            :disabled="!editor.music.value || editor.busy.value"
            :value="(editor.project.value.music?.gain ?? 0.8) * 100"
            @commit="editor.edit({ type: 'set-gain', gain: Number($event) / 100 })"
          /><span>{{ Math.round((editor.project.value.music?.gain ?? 0.8) * 100) }}%</span></label
        >
      </div>
    </header>

    <nav class="workspace-toolbar" aria-label="工作区布局">
      <span class="muted">布局</span>
      <button title="优先时间轴与音符编辑空间" @click="workspace.preset('chart')">谱面</button>
      <button title="优先图层与属性空间" @click="workspace.preset('show')">演出</button>
      <button title="优先画布空间" @click="workspace.preset('camera')">镜头</button>
      <span class="toolbar-spacer" />
      <span v-if="storageError" role="status" class="error-text">布局暂未保存到本机</span>
      <button
        :aria-pressed="canvasFocus"
        title="在画布上按 Tab 可切换"
        @click="canvasFocus = !canvasFocus"
      >
        {{ canvasFocus ? '退出专注画布' : '专注画布' }}
      </button>
      <button title="恢复谱面布局的默认尺寸和展开状态" @click="workspace.preset('chart')">
        重置布局
      </button>
    </nav>
    <main class="workspace" :style="workspaceStyle">
      <ResourcePanel
        v-show="!canvasFocus && !layout.collapsed.left"
        :editor="editor"
        :layout="layout"
        @toggle="workspace.toggle('left')"
        @section-toggle="layout.sections[$event].collapsed = !layout.sections[$event].collapsed"
        @weights="weights"
        @resize-start="workspace.beginResize"
        @resize-end="workspace.endResize"
      />
      <button
        v-show="!canvasFocus && layout.collapsed.left"
        class="panel-rail left-rail"
        aria-label="展开左栏"
        @click="workspace.toggle('left')"
      >
        › 图层与素材
      </button>
      <PanelDivider
        v-show="!canvasFocus && !layout.collapsed.left"
        class="left-divider"
        label="左栏宽度"
        vertical
        :value="layoutSize.left"
        :min="220"
        @resize="workspace.setSize('left', $event)"
        @start="workspace.beginResize"
        @end="workspace.endResize"
      />
      <CanvasPanel :editor="editor" />

      <PanelDivider
        v-show="!canvasFocus && !layout.collapsed.right"
        class="right-divider"
        label="右栏宽度"
        vertical
        reverse
        :value="layoutSize.right"
        :min="240"
        @resize="workspace.setSize('right', $event)"
        @start="workspace.beginResize"
        @end="workspace.endResize"
      />
      <button
        v-show="!canvasFocus && layout.collapsed.right"
        class="panel-rail right-rail"
        aria-label="展开右栏"
        @click="workspace.toggle('right')"
      >
        ‹ 属性
      </button>
      <aside v-show="!canvasFocus && !layout.collapsed.right" class="inspector" aria-label="属性">
        <header class="panel-header">
          <strong>{{
            editor.chart.selected.value.length
              ? '音符与工程属性'
              : editor.selectedLayer.value
                ? '对象与工程属性'
                : '工程属性'
          }}</strong
          ><button
            v-if="editor.selectedLayer.value || editor.chart.selected.value.length"
            @click="
              editor.selectLayer(null);
              editor.chart.choose([]);
            "
          >
            取消选择
          </button>
          <button aria-label="收起右栏" @click="workspace.toggle('right')">›</button>
        </header>
        <div ref="inspectorScroll" class="inspector-scroll">
          <div class="production-tabs">
            <button
              :class="{ selected: inspectorTab === 'objects' }"
              @click="showInspector('objects')"
            >
              图层 / 谱面</button
            ><button
              :class="{ selected: inspectorTab === 'sounds' }"
              @click="showInspector('sounds')"
            >
              音效</button
            ><button
              :class="{ selected: inspectorTab === 'camera' }"
              @click="showInspector('camera')"
            >
              镜头</button
            ><button
              :class="{ selected: inspectorTab === 'music' }"
              @click="showInspector('music')"
            >
              卡点
            </button>
          </div>
          <SoundPanel v-if="inspectorTab === 'sounds'" :editor="editor" />
          <CameraPanel v-if="inspectorTab === 'camera'" :editor="editor" />
          <AnalysisPanel v-if="inspectorTab === 'music'" :editor="editor" />
          <template v-if="inspectorTab === 'objects'">
            <RevealPanel :editor="editor" />
            <NoteInspector v-if="editor.chart.mode.value !== 'playtest'" :editor="editor" />
            <PlaytestPanel v-if="editor.chart.mode.value === 'playtest'" :editor="editor" />
            <LayerInspector :editor="editor" />
          </template>
          <div class="property-section">
            <label class="stacked-label"
              >工程名称<CommitInput
                aria-label="工程名称"
                :disabled="readOnlySettings"
                :value="editor.project.value.name"
                @commit="editor.edit({ type: 'rename', name: $event })"
            /></label>
          </div>
          <div class="property-section">
            <h2>画板</h2>
            <div class="two-fields">
              <label
                >宽<NumberField
                  aria-label="画板宽度"
                  type="number"
                  :precision="0"
                  min="1"
                  step="1"
                  :disabled="readOnlySettings"
                  :value="editor.project.value.stage.artworkSize.width"
                  @commit="changeSize('width', $event)" /></label
              ><label
                >高<NumberField
                  aria-label="画板高度"
                  type="number"
                  :precision="0"
                  min="1"
                  step="1"
                  :disabled="readOnlySettings"
                  :value="editor.project.value.stage.artworkSize.height"
                  @commit="changeSize('height', $event)"
              /></label>
            </div>
            <p class="help-text">
              以左上角为基准裁切显示，修改后自动适合窗口。超出画板的原始像素保留，可放大尺寸或撤销恢复。
            </p>
          </div>
          <div class="property-section">
            <h2>游戏输出</h2>
            <div class="two-fields">
              <label
                >宽<NumberField
                  aria-label="输出宽度"
                  type="number"
                  :precision="0"
                  step="1"
                  min="1"
                  :disabled="readOnlySettings"
                  :value="editor.project.value.output.size.width"
                  @commit="changeSize('width', $event, true)" /></label
              ><label
                >高<NumberField
                  aria-label="输出高度"
                  type="number"
                  :precision="0"
                  step="1"
                  min="1"
                  :disabled="readOnlySettings"
                  :value="editor.project.value.output.size.height"
                  @commit="changeSize('height', $event, true)"
              /></label>
            </div>
            <p class="help-text">当前保存输出设置；视频导出尚未接入。</p>
          </div>
          <div class="property-section">
            <h2>节拍与时间</h2>
            <label class="stacked-label"
              >第零拍位置 <span class="unit">毫秒</span
              ><NumberField
                aria-label="第零拍位置"
                type="number"
                :precision="3"
                step="1"
                :disabled="readOnlySettings"
                :value="editor.project.value.timing.beatZeroUs / 1000"
                @commit="
                  editor.edit({
                    type: 'set-beat-zero',
                    timeUs: Math.round(Number($event) * 1000),
                  })
                " /></label
            ><label class="stacked-label seek-field"
              >定位到 <span class="unit">秒</span
              ><NumberField
                aria-label="定位到秒"
                type="number"
                :precision="6"
                :live="false"
                min="0"
                step="0.1"
                :max="editor.playback.value.durationUs / 1000000"
                :disabled="!editor.playback.value.ready || editor.busy.value"
                :value="editor.playback.value.timeUs / 1000000"
                @focus="editor.pause()"
                @commit="editor.seek(Math.round(Number($event) * 1000000))"
            /></label>
            <p class="help-text">空格播放 / 暂停。时间轴拖动定位，按住 Alt 可暂时忽略吸附。</p>
          </div>
          <div class="property-section" v-if="editor.music.value?.audio">
            <h2>音乐信息</h2>
            <dl class="info-list">
              <div>
                <dt>采样率</dt>
                <dd>{{ editor.music.value.audio.sampleRate }} Hz</dd>
              </div>
              <div>
                <dt>声道</dt>
                <dd>{{ editor.music.value.audio.channels }}</dd>
              </div>
              <div>
                <dt>时长</dt>
                <dd>{{ musicDuration }}</dd>
              </div>
            </dl>
          </div>
          <PlaytestPanel v-if="editor.chart.mode.value !== 'playtest'" :editor="editor" />
          <button class="diagnostics-button" @click="showPerformance = true">查看运行记录</button>
        </div>
      </aside>
    </main>

    <PanelDivider
      v-show="!canvasFocus && !layout.collapsed.timeline"
      class="timeline-divider"
      label="时间轴高度"
      reverse
      :value="layoutSize.timeline"
      :min="140"
      @resize="workspace.setSize('timeline', $event)"
      @start="workspace.beginResize"
      @end="workspace.endResize"
    />
    <TimelinePanel
      v-show="!canvasFocus && !layout.collapsed.timeline"
      :editor="editor"
      @collapse="workspace.toggle('timeline')"
    />
    <button
      v-show="!canvasFocus && layout.collapsed.timeline"
      class="timeline-rail"
      aria-label="展开时间轴"
      @click="workspace.toggle('timeline')"
    >
      ▴ 时间轴
    </button>

    <footer class="status-bar">
      <span
        class="status-message"
        :class="editor.notice.value.kind"
        role="status"
        :title="editor.notice.value.text"
        >{{ editor.busy.value ? '处理中… ' : '' }}{{ editor.notice.value.text }}</span
      ><span class="save-state" :title="projectPath">{{
        editor.dirty.value ? '未保存修改' : editor.session.value?.filePath ? '已保存' : '新工程'
      }}</span
      ><span
        data-testid="recovery-state"
        :class="{ 'error-text': editor.recoveryError.value }"
        :title="
          editor.recoveryError.value ||
          '每 15 秒保留已提交的修改；可恢复到显示的快照时间，不替代正式保存。'
        "
        >{{ snapshotLabel }}</span
      ><button v-if="editor.recoveryEntries.value.length" @click="editor.showRecovery.value = true">
        待恢复工程</button
      ><button @click="showPerformance = true" title="查看当前工程的帧率、内存和受管纹理估算">
        {{ editor.fps.value ? editor.fps.value.toFixed(0) : '—' }} FPS
        <span class="muted">{{ memoryLabel }}</span>
      </button>
    </footer>

    <div v-if="editor.imageProgress.value" class="modal-backdrop">
      <section class="modal" role="dialog" aria-modal="true" aria-label="图片导入进度">
        <h2>正在导入插画</h2>
        <p class="import-phase">{{ editor.imageProgress.value.phase }}</p>
        <progress
          :value="
            editor.imageProgress.value.total ? editor.imageProgress.value.completed : undefined
          "
          :max="editor.imageProgress.value.total || 1"
        />
        <p class="help-text">
          后台逐层建立无损分块和分级预览，原始素材完整保留。{{
            editor.imageProgress.value.total
              ? `${editor.imageProgress.value.completed} / ${editor.imageProgress.value.total}`
              : ''
          }}
        </p>
        <div class="modal-actions">
          <button @click="editor.cancelImageImport()">取消导入</button>
        </div>
      </section>
    </div>
    <div
      v-if="editor.importWarnings.value.length && !editor.imageProgress.value"
      class="modal-backdrop"
    >
      <section
        class="modal compatibility-modal"
        role="dialog"
        aria-modal="true"
        aria-label="PSD 兼容提示"
      >
        <div class="modal-header">
          <h2>PSD 兼容提示</h2>
          <button aria-label="关闭兼容提示" @click="editor.importWarnings.value = []">×</button>
        </div>
        <p class="help-text">原 PSD 已完整保留。以下特性在当前预览中存在差异：</p>
        <ul>
          <li v-for="warning in editor.importWarnings.value" :key="warning">{{ warning }}</li>
        </ul>
        <div class="modal-actions">
          <button class="primary" @click="editor.importWarnings.value = []">返回编辑</button>
        </div>
      </section>
    </div>

    <div v-if="showNew" class="modal-backdrop" @keydown.esc="showNew = false">
      <form
        class="modal"
        aria-label="新建工程"
        role="dialog"
        aria-modal="true"
        @submit.prevent="create"
      >
        <div class="modal-header">
          <h2>新建工程</h2>
          <button
            type="button"
            aria-label="关闭新建工程"
            :disabled="editor.busy.value"
            @click="showNew = false"
          >
            ×
          </button>
        </div>
        <label class="stacked-label"
          >工程名称<input
            v-model="draft.name"
            aria-label="新工程名称"
            autofocus
            required
            :disabled="editor.busy.value"
        /></label>
        <div class="two-fields">
          <label
            >画板宽度<input
              v-model.number="draft.width"
              aria-label="新工程宽度"
              type="number"
              min="1"
              step="1"
              required
              :disabled="editor.busy.value" /></label
          ><label
            >画板高度<input
              v-model.number="draft.height"
              aria-label="新工程高度"
              type="number"
              min="1"
              step="1"
              required
              :disabled="editor.busy.value"
          /></label>
        </div>
        <p class="help-text">
          以后可以调整画板尺寸。音乐在创建后导入，保存时会一并复制到工程素材文件夹。
        </p>
        <p v-if="newError" class="error-text">{{ newError }}</p>
        <div class="modal-actions">
          <button type="button" :disabled="editor.busy.value" @click="showNew = false">取消</button
          ><button class="primary" type="submit" :disabled="editor.busy.value">创建工程</button>
        </div>
      </form>
    </div>
    <div v-if="editor.confirmReplacement.value" class="modal-backdrop top-modal">
      <div class="modal" role="dialog" aria-modal="true" aria-label="未保存的修改">
        <h2>是否先保存当前工程？</h2>
        <p class="help-text">
          {{
            editor.confirmationKind.value === 'exit'
              ? '保存成功后退出；取消路径或保存失败会保留窗口和编辑内容。'
              : '保存后会继续刚才的操作。'
          }}
        </p>
        <div class="modal-actions">
          <button @click="editor.confirmReplacement.value?.('cancel')">取消</button
          ><button @click="editor.confirmReplacement.value?.('discard')">
            {{ editor.confirmationKind.value === 'exit' ? '不保存并退出' : '放弃修改' }}</button
          ><button class="primary" @click="editor.confirmReplacement.value?.('save')">
            {{ editor.confirmationKind.value === 'exit' ? '保存并退出' : '先保存' }}
          </button>
        </div>
      </div>
    </div>
    <div v-if="editor.showRecovery.value" class="modal-backdrop">
      <section
        class="modal recovery-modal"
        role="dialog"
        aria-modal="true"
        aria-label="恢复未保存工程"
      >
        <h2>发现未保存的工程</h2>
        <p class="help-text">恢复到以下快照时间。恢复后仍需正式保存；暂不处理会保留这些内容。</p>
        <article
          v-for="entry in editor.recoveryEntries.value"
          :key="entry.id"
          class="recovery-entry"
        >
          <strong>{{ entry.name }}{{ entry.filePath ? '' : '（未命名文件）' }}</strong>
          <p>{{ new Date(entry.savedAt).toLocaleString() }}</p>
          <p v-if="entry.filePath" class="help-text">{{ entry.filePath }}</p>
          <div class="modal-actions">
            <button :disabled="editor.busy.value" @click="editor.discardRecovery(entry)">
              丢弃此快照
            </button>
            <button
              class="primary"
              :disabled="editor.busy.value"
              @click="editor.restoreRecovery(entry)"
            >
              恢复工程
            </button>
          </div>
        </article>
        <div class="modal-actions">
          <button :disabled="editor.busy.value" @click="editor.showRecovery.value = false">
            暂不处理
          </button>
        </div>
      </section>
    </div>
    <div v-if="showPerformance" class="modal-backdrop" @keydown.esc="showPerformance = false">
      <section
        class="modal performance-modal"
        role="dialog"
        aria-modal="true"
        aria-label="运行记录"
      >
        <div class="modal-header">
          <h2>运行记录</h2>
          <button aria-label="关闭运行记录" @click="showPerformance = false">×</button>
        </div>
        <dl class="info-list">
          <div>
            <dt>界面刷新</dt>
            <dd>{{ editor.fps.value.toFixed(1) }} FPS</dd>
          </div>
          <div>
            <dt>Pixi 预览绘制循环</dt>
            <dd>{{ (stageMetrics?.previewFrames?.fps ?? 0).toFixed(1) }} FPS</dd>
          </div>
          <div>
            <dt>应用私有内存合计</dt>
            <dd>{{ memoryLabel }}</dd>
          </div>
          <div>
            <dt>已解码音频</dt>
            <dd>
              {{ (editor.resources.stats().bytes['decoded-audio'] / 1024 / 1024).toFixed(1) }} MiB
            </dd>
          </div>
          <div>
            <dt>最大纹理边长</dt>
            <dd>{{ stageMetrics?.capabilities?.maxTextureSize ?? '未采集' }}</dd>
          </div>
          <div>
            <dt>实际图形设备</dt>
            <dd>
              {{ stageMetrics?.gpu?.unmaskedRenderer ?? stageMetrics?.gpu?.renderer ?? '未采集' }}
            </dd>
          </div>
          <div>
            <dt>实际绘制帧数</dt>
            <dd>{{ stageMetrics?.rendering?.frames ?? 0 }}</dd>
          </div>
          <div>
            <dt>受管纹理 / RGBA 估算</dt>
            <dd>
              {{ stageMetrics?.layers?.residentTextures ?? 0 }} /
              {{ ((stageMetrics?.layers?.rgbaBytesEstimate ?? 0) / 1024 / 1024).toFixed(1) }} MiB
            </dd>
          </div>
          <div>
            <dt>待载分块 / 缓存释放次数</dt>
            <dd>
              {{ (stageMetrics?.layers?.loading ?? 0) + (stageMetrics?.layers?.queued ?? 0) }} /
              {{ stageMetrics?.layers?.evicted ?? 0 }}
            </dd>
          </div>
          <div v-if="editor.lastImport.value">
            <dt>最近导入 / 后台峰值内存</dt>
            <dd>
              {{ (editor.lastImport.value.metrics.elapsedMs / 1000).toFixed(2) }} s /
              {{ (editor.lastImport.value.metrics.peakWorkerRssBytes / 1024 / 1024).toFixed(0) }}
              MiB
            </dd>
          </div>
          <div>
            <dt>屏幕缓冲</dt>
            <dd>
              {{ stageMetrics?.screenBuffer?.width }} × {{ stageMetrics?.screenBuffer?.height }}
            </dd>
          </div>
          <div>
            <dt>画板</dt>
            <dd>
              {{ editor.project.value.stage.artworkSize.width }} ×
              {{ editor.project.value.stage.artworkSize.height }}
            </dd>
          </div>
        </dl>
        <p class="help-text">
          记录反映当前工程与采样窗口。纹理占用按 RGBA 估算，不含驱动、屏幕与 Pixi
          内部滤镜缓存，不能视为总显存。路径显现使用矢量分段遮罩，无全画板位图蒙版。
        </p>
        <div class="modal-actions">
          <button :disabled="editor.busy.value" @click="editor.exportPerformance()">
            保存性能记录</button
          ><button class="primary" @click="showPerformance = false">返回编辑</button>
        </div>
      </section>
    </div>
  </div>
</template>
