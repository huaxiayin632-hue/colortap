import { computed, inject, ref, shallowRef, watch, type InjectionKey } from 'vue';
import type { Editor } from '../state/editor';
import type { ChartTool } from '../chart/controller';
import type { useWorkspace } from '../workspace/use-workspace';
import { isLocked, parents } from '../../core/layers';
import {
  playtestCodes,
  validTarget,
  isTextTarget,
  matchesShortcut,
  targetNames,
  type CommandTarget,
  type Shortcut,
} from './context';

export interface TimelineCommands {
  canNavigate(): boolean;
  reveal(timeUs: number): void;
  locate(): void;
}
export interface Command {
  id: string;
  name: string;
  scope: string;
  shortcuts: Shortcut[];
  enabled(target: CommandTarget): boolean;
  execute(target: CommandTarget): unknown;
  keyboard?: (event: KeyboardEvent) => boolean;
}
export function createCommands(
  editor: Editor,
  workspace: ReturnType<typeof useWorkspace>,
  newProject: () => void,
) {
  const help = ref(false);
  const timeline = shallowRef<TimelineCommands | null>(null);
  const menu = shallowRef<{
    x: number;
    y: number;
    target: CommandTarget;
    handle: string | undefined;
    items: string[];
  } | null>(null);
  const commands: Command[] = [];
  const editable = () => !editor.busy.value && editor.chart.mode.value === 'edit';
  const available = () => !editor.busy.value;
  const valid = (t: CommandTarget) => validTarget(editor.project.value, t);
  const kind = (t: CommandTarget, k: string) => valid(t) && t?.kind === k;
  const c = editor.chart,
    r = editor.reveals;
  function add(
    id: string,
    name: string,
    scope: string,
    shortcuts: Shortcut[],
    enabled: Command['enabled'],
    execute: Command['execute'],
    keyboard?: Command['keyboard'],
  ) {
    commands.push({ id, name, scope, shortcuts, enabled, execute, keyboard });
  }
  const ctrl = (key: string, shift = false) => ({ key, ctrl: true, shift });
  const plain = (key: string) => ({ key });
  function pathKind(t: CommandTarget) {
    if (kind(t, 'reveal') && r.pathEditing.value && t!.ids[0] === r.selectedId.value)
      return 'reveal';
    if (
      kind(t, 'notes') &&
      c.tool.value === 'path' &&
      t!.ids.length === 1 &&
      t!.ids[0] === c.selectedNote.value?.id
    )
      return 'notes';
    return null;
  }
  function canDeleteLayer(id: string): boolean {
    const p = editor.project.value,
      l = p.layers[id];
    return Boolean(
      l && !isLocked(p, id) && (l.kind !== 'group' || l.childrenBottomToTop.every(canDeleteLayer)),
    );
  }
  function canDelete(t: CommandTarget) {
    if (!editable() || !valid(t)) return false;
    if (pathKind(t) === 'notes')
      return Boolean(c.selectedNode.value && c.selectedPath.value!.nodes.length > 2);
    if (pathKind(t) === 'reveal') return Boolean(r.node.value && r.path.value!.nodes.length > 2);
    return t?.kind !== 'layer' || canDeleteLayer(t.ids[0]);
  }
  function remove(t: CommandTarget) {
    if (!t) return;
    if (pathKind(t) === 'notes') {
      c.deleteNode();
      return;
    }
    if (pathKind(t) === 'reveal') {
      r.deleteNode();
      return;
    }
    const id = t.ids[0];
    if (t.kind === 'notes') editor.edit({ type: 'delete-notes', ids: t.ids });
    else if (t.kind === 'layer') editor.edit({ type: 'delete-layer', id });
    else if (t.kind === 'reveal') r.remove(id);
    else if (t.kind === 'sound') editor.edit({ type: 'delete-sound', id });
    else if (t.kind === 'camera') editor.edit({ type: 'delete-camera-key', id });
    else editor.edit({ type: 'delete-shake', id });
  }
  const canDuplicate = (t: CommandTarget) =>
    editable() &&
    valid(t) &&
    ['notes', 'sound', 'camera', 'shake'].includes(t!.kind) &&
    !pathKind(t);
  function duplicate(t: CommandTarget) {
    if (!t) return;
    const id = t.ids[0];
    if (t.kind === 'notes') {
      c.choose(t.ids);
      c.duplicate();
    }
    if (t.kind === 'sound') editor.copySound(id);
    if (t.kind === 'camera') {
      editor.camera.choose(id);
      editor.camera.copy();
    }
    if (t.kind === 'shake') {
      const shake = structuredClone(editor.project.value.camera.shakes![id]);
      shake.id = crypto.randomUUID();
      shake.at = { basis: 'time', timeUs: editor.tempo.value.resolve(shake.at) + 500000 };
      if (editor.edit({ type: 'put-shake', shake })) editor.camera.chooseShake(shake.id);
    }
  }
  add('file.new', '新建工程', '工程', [ctrl('n')], available, newProject);
  add('file.open', '打开工程', '工程', [ctrl('o')], available, () => editor.open());
  add('file.save', '保存工程', '工程', [ctrl('s')], available, () => editor.save());
  add('file.saveAs', '另存为', '工程', [ctrl('s', true)], available, () => editor.save(true));
  add(
    'history.undo',
    '撤销',
    '编辑模式',
    [ctrl('z')],
    () => editable() && editor.canUndo.value,
    () => editor.undo(),
  );
  add(
    'history.redo',
    '重做',
    '编辑模式',
    [ctrl('y'), ctrl('z', true)],
    () => editable() && editor.canRedo.value,
    () => editor.redo(),
  );
  add(
    'object.delete',
    '删除操作对象 / 当前路径节点',
    '最近明确选择的对象；路径编辑时仅节点',
    [plain('Delete')],
    canDelete,
    remove,
  );
  add(
    'object.duplicate',
    '复制对象',
    '音符、音效片段、镜头关键帧、震动',
    [ctrl('d')],
    canDuplicate,
    duplicate,
  );
  add(
    'notes.copy',
    '复制音符到剪贴板',
    '选中的音符',
    [ctrl('c')],
    (t) => editable() && kind(t, 'notes'),
    (t) => {
      c.choose(t!.ids);
      c.copy();
    },
  );
  add(
    'notes.paste',
    '粘贴音符',
    '谱面工具',
    [ctrl('v')],
    () => editable() && c.canPaste.value && c.tool.value !== 'layers',
    () => c.paste(),
  );
  add(
    'notes.all',
    '全选音符',
    '谱面工具',
    [ctrl('a')],
    () => editable() && c.tool.value !== 'layers',
    () => c.selectAll(),
  );
  add(
    'path.edit',
    '编辑音符路径',
    '选中一条 Slider',
    [],
    (t) =>
      editable() &&
      kind(t, 'notes') &&
      t!.ids.length === 1 &&
      editor.project.value.notes[t!.ids[0]].kind === 'slider',
    (t) => {
      c.choose(t!.ids);
      c.setTool('path');
    },
  );
  add(
    'path.delete',
    '删除路径节点',
    '当前 Slider / 显现路径节点',
    [],
    (t) => Boolean(pathKind(t)) && canDelete(t),
    remove,
  );
  add(
    'path.add',
    '添加路径节点',
    '当前 Slider 路径',
    [],
    () => editable() && Boolean(c.selectedPath.value),
    () => {
      c.claimSelection();
      c.addNode();
    },
  );
  add(
    'path.smooth',
    '平滑路径节点',
    '当前 Slider 节点',
    [],
    () => editable() && Boolean(c.selectedNode.value),
    () => {
      c.claimSelection();
      c.smoothNode();
    },
  );
  add(
    'reveal.path',
    '编辑显现路径',
    '已有显现路径',
    [],
    (t) => editable() && kind(t, 'reveal') && Boolean(r.path.value),
    () => (r.pathEditing.value ? r.cancel() : r.editPath()),
  );
  add(
    'reveal.draw',
    '独立绘制显现路径',
    '选中演出片段',
    [],
    (t) => editable() && kind(t, 'reveal'),
    () => r.startDrawing(),
  );
  add(
    'reveal.addNode',
    '添加显现路径节点',
    '当前显现路径',
    [],
    () => editable() && Boolean(r.path.value),
    () => r.addNode(),
  );
  add(
    'path.finish',
    '完成路径绘制',
    '正在绘制 Slider / 显现路径',
    [plain('Enter')],
    () =>
      editable() &&
      (r.drawing.value
        ? r.draftPoints.value.length >= 2
        : c.tool.value === 'slider' && (c.sliderDraft.value?.nodes.length ?? 0) >= 2),
    () => (r.drawing.value ? r.finishDrawing() : c.finishSlider()),
    (e) => !(e.target instanceof Element && e.target.closest('button, [role="treeitem"]')),
  );
  add(
    'edit.cancel',
    '取消当前操作 / 返回编辑',
    '编辑器（菜单和弹窗优先）',
    [plain('Escape')],
    available,
    () => {
      if (r.pathEditing.value) r.cancel();
      else if (c.mode.value !== 'edit') c.setMode('edit');
      else {
        c.cancelGesture();
        c.choose([]);
        editor.claimTarget(null);
      }
    },
  );
  for (const [id, label, key] of [
    ['layers', '图层', 'l'],
    ['select', '选择', 'v'],
    ['circle', 'Circle', 'c'],
    ['slider', 'Slider', 's'],
    ['path', '路径', 'p'],
  ])
    add('tool.' + id, label + '工具', '编辑模式', [plain(key)], editable, () =>
      c.setTool(id as ChartTool),
    );
  add(
    'play.toggle',
    '播放 / 暂停',
    '音乐已就绪',
    [plain(' ')],
    () => available() && editor.playback.value.ready,
    () => editor.togglePlay(),
    (e) =>
      !(
        e.target instanceof Element &&
        e.target.closest('button, [role="button"], [role="separator"]')
      ),
  );
  add(
    'play.start',
    '回到开头',
    '音乐已就绪',
    [],
    () => available() && editor.playback.value.ready,
    () => editor.seek(0),
  );
  for (const [direction, key, word] of [
    [-1, 'ArrowLeft', '上一'],
    [1, 'ArrowRight', '下一'],
  ] as const) {
    for (const bars of [false, true]) {
      add(
        `timeline.${bars ? 'bar' : 'grid'}.${direction}`,
        `${word}${bars ? '小节边界' : '细分网格点'}`,
        '时间轴获得焦点，未拖动对象或播放头',
        [{ key, ctrl: bars }],
        () => available() && editor.playback.value.ready && Boolean(timeline.value?.canNavigate()),
        () => {
          const { timeUs, durationUs } = editor.playback.value;
          const destination = bars
            ? editor.tempo.value.nextBar(timeUs, direction)
            : editor.tempo.value.nextGrid(timeUs, c.divisions.value, direction);
          const next = Math.max(0, Math.min(durationUs, destination));
          editor.seek(next);
          timeline.value?.reveal(next);
        },
        (event) =>
          event.target instanceof Element && Boolean(event.target.closest('.timeline-scroll')),
      );
    }
  }
  add(
    'timeline.locate',
    '定位播放头',
    '时间轴视图；恢复已启用的跟随',
    [],
    () => available() && Boolean(timeline.value),
    () => timeline.value?.locate(),
  );
  add('timeline.follow', '开启 / 关闭播放头跟随', '时间轴视图', [], available, () => {
    workspace.timeline.value.follow = !workspace.timeline.value.follow;
  });
  for (const [ruler, name] of [
    ['time', '分:秒'],
    ['bars', '小节:拍'],
  ] as const)
    add('timeline.ruler.' + ruler, name + '标尺', '时间轴视图', [], available, () => {
      workspace.timeline.value.ruler = ruler;
    });
  add('help', '快捷键一览', '编辑器', [plain('?')], available, () => {
    editor.chart.release();
    help.value = true;
  });
  add(
    'workspace.focus',
    '专注画布 / 恢复布局',
    '仅画布获得焦点时的 Tab',
    [plain('Tab')],
    available,
    () => {
      workspace.focus.value = !workspace.focus.value;
    },
    (e) => e.target instanceof Element && e.target.matches('.canvas-host, .canvas-host canvas'),
  );
  for (const [id, name] of [
    ['chart', '谱面'],
    ['show', '演出'],
    ['camera', '镜头'],
  ] as const)
    add('workspace.' + id, name + '布局', '本机布局', [], available, () => workspace.preset(id));
  add('workspace.reset', '重置布局', '本机布局', [], available, () => workspace.preset('chart'));
  for (const [id, name] of [
    ['left', '左栏'],
    ['right', '右栏'],
    ['timeline', '时间轴'],
  ] as const)
    add('workspace.' + id, '展开 / 收起' + name, '本机布局', [], available, () =>
      workspace.toggle(id),
    );
  for (const [id, name] of [
    ['layers', '图层'],
    ['assets', '素材'],
    ['sounds', '音效素材'],
  ] as const)
    add('section.' + id, '展开 / 收起' + name + '区块', '本机布局', [], available, () => {
      const s = workspace.layout.value.sections[id];
      s.collapsed = !s.collapsed;
    });
  for (const [id, name, action] of [
    ['view.fit', '适合窗口', () => editor.fit()],
    ['view.in', '放大画布', () => editor.setZoom(editor.zoom.value * 1.25)],
    ['view.out', '缩小画布', () => editor.setZoom(editor.zoom.value / 1.25)],
    ['view.actual', '原尺寸', () => editor.setZoom(1)],
    ['import.image', '导入 PSD / PNG', () => editor.importImage()],
    ['import.music', '导入音乐', () => editor.importMusic()],
    ['import.sound', '导入音效', () => editor.importSound()],
    ['camera.add', '添加镜头关键帧', () => editor.camera.add()],
    ['camera.shake', '添加节拍震动', () => editor.camera.addShake()],
    ['camera.reset', '重置镜头构图', () => editor.camera.reset()],
  ] as const)
    add(
      id,
      name,
      id.startsWith('view.') ? '画布视图' : '编辑模式',
      [],
      id.startsWith('view.') ? available : editable,
      action,
    );
  const layerEditable = (t: CommandTarget) =>
    editable() && kind(t, 'layer') && !isLocked(editor.project.value, t!.ids[0]);
  add('layer.visible', '显示 / 隐藏图层', '图层', [], layerEditable, (t) => {
    const id = t!.ids[0];
    editor.edit({
      type: 'set-layer',
      id,
      patch: { enabled: !editor.project.value.layers[id].enabled },
    });
  });
  add(
    'layer.lock',
    '锁定 / 解锁图层',
    '图层（父组未锁定）',
    [],
    (t) => editable() && kind(t, 'layer') && !isLocked(editor.project.value, t!.ids[0], false),
    (t) => {
      const id = t!.ids[0];
      editor.edit({
        type: 'set-layer',
        id,
        patch: { locked: !editor.project.value.layers[id].locked },
      });
    },
  );
  for (const [direction, name] of [
    [1, '上移图层'],
    [-1, '下移图层'],
  ] as const) {
    const siblings = (t: CommandTarget) => {
      const p = editor.project.value;
      const parentId = parents(p).get(t!.ids[0]) ?? null;
      const parent = parentId ? p.layers[parentId] : null;
      return {
        parentId,
        ids: parent?.kind === 'group' ? parent.childrenBottomToTop : p.rootLayersBottomToTop,
      };
    };
    add(
      direction === 1 ? 'layer.up' : 'layer.down',
      name,
      '图层',
      [],
      (t) => {
        if (!layerEditable(t)) return false;
        const { ids } = siblings(t);
        const i = ids.indexOf(t!.ids[0]) + direction;
        return i >= 0 && i < ids.length;
      },
      (t) => {
        const { ids, parentId } = siblings(t);
        const id = t!.ids[0],
          i = ids.indexOf(id);
        editor.edit({ type: 'move-layer', id, parentId, index: direction > 0 ? i + 2 : i - 1 });
      },
    );
  }
  const byId = new Map(commands.map((command) => [command.id, command]));
  function enabled(id: string, target = editor.commandTarget.value) {
    return byId.get(id)?.enabled(target) ?? false;
  }
  function run(id: string, target = editor.commandTarget.value) {
    const command = byId.get(id);
    if (!command?.enabled(target)) return false;
    if (target && valid(target) && /^(object|layer|path|reveal)\./.test(id))
      editor.claimTarget(target);
    void command.execute(target);
    return true;
  }
  function select(target: CommandTarget) {
    if (!target || !valid(target)) {
      editor.claimTarget(null);
      return;
    }
    const id = target.ids[0];
    if (target.kind === 'layer') editor.selectLayer(id);
    if (target.kind === 'notes') {
      if (!c.selected.value.includes(id)) c.choose([id]);
      c.claimSelection();
      return;
    }
    if (target.kind === 'reveal' && r.selectedId.value !== id) r.choose(id);
    if (target.kind === 'sound') editor.selectSound(id);
    if (target.kind === 'camera') editor.camera.choose(id);
    if (target.kind === 'shake') editor.camera.chooseShake(id);
    editor.claimTarget(target);
  }
  function domTarget(element: Element): CommandTarget {
    for (const [attr, kind] of [
      ['data-layer-id', 'layer'],
      ['data-note-id', 'notes'],
      ['data-reveal-id', 'reveal'],
      ['data-sound-id', 'sound'],
      ['data-camera-id', 'camera'],
      ['data-shake-id', 'shake'],
    ] as const) {
      const el = element.closest('[' + attr + ']');
      const id = el?.getAttribute(attr);
      if (id)
        return {
          kind,
          ids: kind === 'notes' && c.selected.value.includes(id) ? [...c.selected.value] : [id],
        };
    }
    return null;
  }
  let restoreFocus: HTMLElement | null = null;
  function closeMenu(restore = true) {
    menu.value = null;
    if (restore && restoreFocus?.isConnected) restoreFocus.focus({ preventScroll: true });
  }
  function openContext(event: MouseEvent) {
    if (
      isTextTarget(event.target) ||
      !(event.target instanceof Element) ||
      document.querySelector('[role="dialog"], .modal-backdrop')
    )
      return;
    event.preventDefault();
    event.stopPropagation();
    editor.chart.release();
    const canvas = event.target.closest('.canvas-host');
    const target = canvas
      ? (editor.stage.value?.contextTarget(event) ?? null)
      : domTarget(event.target);
    if (target) select(target);
    // A blank menu has no object target. It must never inherit an old selection.
    const items = target
      ? [
          'object.delete',
          ...(['notes', 'sound', 'camera', 'shake'].includes(target.kind)
            ? ['object.duplicate']
            : []),
          ...(target.kind === 'notes' ? ['notes.copy', 'notes.paste', 'path.edit'] : []),
          ...(target.kind === 'layer'
            ? ['layer.visible', 'layer.lock', 'layer.up', 'layer.down']
            : []),
        ]
      : ['history.undo', 'history.redo', 'notes.paste', 'view.fit', 'help'];
    restoreFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    menu.value = {
      x: event.clientX,
      y: event.clientY,
      target: target ? structuredClone(editor.commandTarget.value) : null,
      handle: editor.session.value?.handle,
      items,
    };
  }
  function invokeMenu(id: string) {
    const snapshot = menu.value;
    closeMenu();
    if (snapshot && snapshot.handle === editor.session.value?.handle) run(id, snapshot.target);
  }
  watch(
    [editor.project, editor.session, editor.busy, c.mode],
    () => {
      if (menu.value) closeMenu(false);
    },
    { flush: 'sync' },
  );
  let composing = false;
  function composition(event: CompositionEvent) {
    composing = event.type === 'compositionstart';
    if (composing) editor.chart.release();
  }
  function blur() {
    composing = false;
    editor.chart.release();
    closeMenu(false);
  }
  function keydown(event: KeyboardEvent) {
    if (
      event.defaultPrevented ||
      composing ||
      event.isComposing ||
      event.keyCode === 229 ||
      isTextTarget(event.target)
    )
      return;
    if (menu.value || help.value || document.querySelector('[role="dialog"], .modal-backdrop'))
      return;
    if (
      c.mode.value === 'playtest' &&
      !event.ctrlKey &&
      !event.metaKey &&
      !event.altKey &&
      playtestCodes.includes(event.code)
    ) {
      event.preventDefault();
      if (!event.repeat) c.input(event.code, true);
      return;
    }
    const command = commands.find(
      (command) =>
        command.shortcuts.some((s) => matchesShortcut(event, s)) &&
        (!command.keyboard || command.keyboard(event)),
    );
    if (!command) return;
    event.preventDefault();
    if (!event.repeat) run(command.id);
  }
  const targetLabel = computed(() => {
    const t = editor.commandTarget.value;
    if (!valid(t)) return '无操作对象';
    return pathKind(t)
      ? (pathKind(t) === 'notes' ? 'Slider' : '显现路径') + '节点'
      : targetNames[t!.kind] + (t!.ids.length > 1 ? ` × ${t!.ids.length}` : '');
  });
  return {
    commands,
    timeline,
    timelinePreferences: workspace.timeline,
    byId,
    enabled,
    run,
    help,
    menu,
    openContext,
    closeMenu,
    invokeMenu,
    keydown,
    composition,
    blur,
    select,
    domTarget,
    targetLabel,
  };
}
export type Commands = ReturnType<typeof createCommands>;
export const commandsKey: InjectionKey<Commands> = Symbol('editor commands');
export function useCommands() {
  const commands = inject(commandsKey);
  if (!commands) throw Error('Commands not provided');
  return commands;
}
