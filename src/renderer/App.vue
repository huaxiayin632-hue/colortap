<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { createEditor } from './state/editor';
import { formatTime } from '../core/timing';
import CanvasPanel from './panels/CanvasPanel.vue';
import CommitInput from './panels/CommitInput.vue';
import LayerPanel from './panels/LayerPanel.vue';
import LayerInspector from './panels/LayerInspector.vue';
import TimelinePanel from './timeline/TimelinePanel.vue';

const editor = createEditor();
const showNew = ref(false);
const draft = ref({ name: '新工程', width: 6000, height: 6000 });
const newError = ref('');
const showPerformance = ref(false);
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
const audioAssets = computed(() =>
  Object.values(editor.project.value.assets)
    .filter((asset) => asset.kind === 'audio')
    .sort(
      (a, b) => Number(b.id === editor.music.value?.id) - Number(a.id === editor.music.value?.id),
    ),
);
const projectPath = computed(() => editor.session.value?.filePath ?? '尚未保存到文件');
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
    ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName) || target.isContentEditable;
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
    editor.deleteSelectedLayer();
  }
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
  document.addEventListener('visibilitychange', visibility);
  window.addEventListener('blur', blur);
});
onBeforeUnmount(() => {
  window.removeEventListener('keydown', keydown);
  document.removeEventListener('visibilitychange', visibility);
  window.removeEventListener('blur', blur);
  void editor.dispose();
});
</script>

<template>
  <div class="editor-shell" :aria-busy="editor.busy.value">
    <header class="main-toolbar">
      <div class="toolbar-row project-row">
        <div class="brand">
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="M3 9v6M9 4v16M15 7v10M21 10v4" /></svg
          ><strong>Rhythm Canvas</strong><span class="version">0.2</span>
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
            :disabled="!editor.canUndo.value || editor.busy.value"
            @click="editor.undo()"
          >
            ↶</button
          ><button
            aria-label="重做"
            title="重做 Ctrl+Y"
            :disabled="!editor.canRedo.value || editor.busy.value"
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
          <button class="selected" aria-pressed="true">编辑</button
          ><button disabled title="演出系统完成后开放">预览</button
          ><button disabled title="判定系统完成后开放">试玩</button>
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
          >BPM<CommitInput
            aria-label="BPM"
            type="number"
            min="0.001"
            step="1"
            :disabled="editor.busy.value"
            :value="editor.project.value.timing.points[0].bpm"
            @commit="editor.edit({ type: 'set-bpm', bpm: Number($event) })"
        /></label>
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

    <main class="workspace">
      <aside class="left-panel" aria-label="图层与素材">
        <LayerPanel :editor="editor" />
        <header class="panel-header">
          <strong>素材</strong><span class="count">{{ audioAssets.length }}</span>
        </header>
        <div class="asset-area">
          <template v-if="audioAssets.length">
            <div
              v-for="asset in audioAssets"
              :key="asset.id"
              class="asset-item"
              :class="{ current: asset.id === editor.music.value?.id }"
            >
              <span class="asset-symbol">♫</span>
              <div class="asset-description">
                <strong :title="asset.originalName">{{ asset.originalName }}</strong>
                <small
                  >{{ asset.id === editor.music.value?.id ? '当前音乐 · ' : ''
                  }}{{ formatTime(asset.audio?.durationUs ?? 0) }} ·
                  {{ (asset.byteLength / 1024 / 1024).toFixed(2) }} MB</small
                >
              </div>
              <button
                class="delete-button"
                :aria-label="`删除音频 ${asset.originalName}`"
                title="从工程移除音频，可撤销"
                :disabled="editor.busy.value"
                @click="editor.deleteAudio(asset.id)"
              >
                删除
              </button>
            </div>
          </template>
          <div v-else class="asset-empty">
            <p>先为工程添加一首音乐</p>
            <button :disabled="editor.busy.value" @click="editor.importMusic()">导入音乐</button>
          </div>
        </div>
        <div class="left-footer">素材原文件随工程保存</div>
      </aside>

      <CanvasPanel :editor="editor" />

      <aside class="inspector" aria-label="属性">
        <header class="panel-header">
          <strong>{{ editor.selectedLayer.value ? '对象与工程属性' : '工程属性' }}</strong
          ><button v-if="editor.selectedLayer.value" @click="editor.selectLayer(null)">
            取消选择
          </button>
        </header>
        <div class="inspector-scroll">
          <LayerInspector :editor="editor" />
          <div class="property-section">
            <label class="stacked-label"
              >工程名称<CommitInput
                aria-label="工程名称"
                :disabled="editor.busy.value"
                :value="editor.project.value.name"
                @commit="editor.edit({ type: 'rename', name: $event })"
            /></label>
          </div>
          <div class="property-section">
            <h2>画板</h2>
            <div class="two-fields">
              <label
                >宽<CommitInput
                  aria-label="画板宽度"
                  type="number"
                  min="1"
                  step="1"
                  :disabled="editor.busy.value"
                  :value="editor.project.value.stage.artworkSize.width"
                  @commit="changeSize('width', $event)" /></label
              ><label
                >高<CommitInput
                  aria-label="画板高度"
                  type="number"
                  min="1"
                  step="1"
                  :disabled="editor.busy.value"
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
                >宽<CommitInput
                  aria-label="输出宽度"
                  type="number"
                  min="1"
                  :disabled="editor.busy.value"
                  :value="editor.project.value.output.size.width"
                  @commit="changeSize('width', $event, true)" /></label
              ><label
                >高<CommitInput
                  aria-label="输出高度"
                  type="number"
                  min="1"
                  :disabled="editor.busy.value"
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
              ><CommitInput
                aria-label="第零拍位置"
                type="number"
                step="1"
                :disabled="editor.busy.value"
                :value="editor.project.value.timing.beatZeroUs / 1000"
                @commit="
                  editor.edit({
                    type: 'set-beat-zero',
                    timeUs: Math.round(Number($event) * 1000),
                  })
                " /></label
            ><label class="stacked-label seek-field"
              >定位到 <span class="unit">秒</span
              ><CommitInput
                aria-label="定位到秒"
                type="number"
                min="0"
                step="0.1"
                :max="editor.playback.value.durationUs / 1000000"
                :disabled="!editor.playback.value.ready || editor.busy.value"
                :value="(editor.playback.value.timeUs / 1000000).toFixed(3)"
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
          <button class="diagnostics-button" @click="showPerformance = true">查看运行记录</button>
        </div>
      </aside>
    </main>

    <TimelinePanel :editor="editor" />

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
        <p class="help-text">保存后会继续刚才的操作。</p>
        <div class="modal-actions">
          <button @click="editor.confirmReplacement.value?.('cancel')">取消</button
          ><button @click="editor.confirmReplacement.value?.('discard')">放弃修改</button
          ><button class="primary" @click="editor.confirmReplacement.value?.('save')">
            先保存
          </button>
        </div>
      </div>
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
          内部滤镜缓存，不能视为总显存。动态路径蒙版尚未实现。
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
