<script setup lang="ts">
import { nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import type { Commands } from './registry';
import type { Editor } from '../state/editor';
import {
  isTextTarget,
  matchesShortcut,
  playtestCodes,
  shortcutLabel,
  targetNames,
} from './context';
const props = defineProps<{ commands: Commands; editor: Editor }>();
const menuElement = ref<HTMLElement>(),
  helpElement = ref<HTMLElement>();
const position = ref({ left: '0px', top: '0px' });
let previousFocus: HTMLElement | null = null;
watch(props.commands.menu, async (menu) => {
  if (!menu) return;
  await nextTick();
  const rect = menuElement.value?.getBoundingClientRect();
  position.value = {
    left: Math.max(4, Math.min(menu.x, window.innerWidth - (rect?.width ?? 260) - 4)) + 'px',
    top: Math.max(4, Math.min(menu.y, window.innerHeight - (rect?.height ?? 300) - 4)) + 'px',
  };
  await nextTick();
  menuElement.value?.querySelector<HTMLElement>('button:not(:disabled)')?.focus();
  if (!menuElement.value?.contains(document.activeElement)) menuElement.value?.focus();
});
watch(props.commands.help, async (value) => {
  if (value) {
    previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    props.editor.chart.release();
    await nextTick();
    helpElement.value?.querySelector<HTMLElement>('button')?.focus();
  } else if (previousFocus?.isConnected) previousFocus.focus({ preventScroll: true });
});
function menuKey(event: KeyboardEvent) {
  event.stopPropagation();
  if (event.isComposing || event.keyCode === 229) return;
  if (!['Escape', 'Tab', 'ArrowUp', 'ArrowDown', 'Home', 'End', 'Enter', ' '].includes(event.key))
    event.preventDefault();
  const buttons = [
    ...(menuElement.value?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? []),
  ];
  const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
  if (['Escape', 'Tab'].includes(event.key)) {
    event.preventDefault();
    props.commands.closeMenu();
    return;
  }
  if (['ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) {
    event.preventDefault();
    const i =
      event.key === 'Home'
        ? 0
        : event.key === 'End'
          ? buttons.length - 1
          : (index + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length;
    buttons[i]?.focus();
  }
  if (event.repeat) event.preventDefault();
}
function helpKey(event: KeyboardEvent) {
  event.stopPropagation();
  if (event.isComposing || event.keyCode === 229) return;
  if (event.key === 'Escape') {
    event.preventDefault();
    props.commands.help.value = false;
  }
  if (event.key === 'Tab') {
    event.preventDefault();
    helpElement.value?.querySelector<HTMLElement>('button')?.focus();
  }
}
function outside(event: PointerEvent) {
  if (props.commands.menu.value && !menuElement.value?.contains(event.target as Node))
    props.commands.closeMenu(false);
}
function resize() {
  props.commands.closeMenu();
}
function topDialog() {
  return (
    document.querySelector<HTMLElement>('.top-modal [role="dialog"]') ??
    [...document.querySelectorAll<HTMLElement>('[role="dialog"]')].at(-1)
  );
}
function dialogControls(dialog: HTMLElement) {
  return [
    ...dialog.querySelectorAll<HTMLElement>('button, input, select, textarea, [tabindex]'),
  ].filter((el) => !el.matches(':disabled') && el.tabIndex >= 0 && el.getClientRects().length);
}
function focusDialog(dialog: HTMLElement) {
  const controls = dialogControls(dialog);
  const control = controls.find((el) => el.hasAttribute('autofocus')) ?? controls[0];
  if (control) control.focus({ preventScroll: true });
  else {
    dialog.tabIndex = -1;
    dialog.focus({ preventScroll: true });
  }
}
function modalKey(event: KeyboardEvent) {
  const dialog = topDialog();
  if (!dialog) return;
  if (!dialog.contains(event.target as Node)) {
    event.preventDefault();
    event.stopImmediatePropagation();
    focusDialog(dialog);
    return;
  }
  if (event.isComposing || event.keyCode === 229) return;
  if (event.key === 'Tab') {
    const controls = dialogControls(dialog),
      index = controls.indexOf(document.activeElement as HTMLElement);
    if (index < 0 || (event.shiftKey ? index === 0 : index === controls.length - 1)) {
      event.preventDefault();
      (event.shiftKey ? controls.at(-1) : controls[0])?.focus();
    }
    return;
  }
  // Chromium's native undo can refocus and edit the last textbox behind a dialog.
  // Text controls retain native editing; dialog buttons retain Enter/Space/Esc.
  if (
    !isTextTarget(event.target) &&
    !['Enter', ' ', 'Escape'].includes(event.key) &&
    (props.commands.commands.some((c) => c.shortcuts.some((s) => matchesShortcut(event, s))) ||
      playtestCodes.includes(event.code))
  )
    event.preventDefault();
}
let observer: MutationObserver;
onMounted(() => {
  window.addEventListener('pointerdown', outside, true);
  window.addEventListener('resize', resize);
  window.addEventListener('keydown', modalKey, true);
  // All existing dialogs also release gameplay inputs when they take over the window.
  let activeDialog: HTMLElement | undefined;
  observer = new MutationObserver(() => {
    const dialog = topDialog();
    if (dialog && dialog !== activeDialog) {
      props.editor.chart.release();
      props.commands.closeMenu(false);
      if (!dialog.contains(document.activeElement)) focusDialog(dialog);
    }
    activeDialog = dialog;
  });
  observer.observe(document.body, { childList: true, subtree: true });
});
onBeforeUnmount(() => {
  window.removeEventListener('pointerdown', outside, true);
  window.removeEventListener('resize', resize);
  window.removeEventListener('keydown', modalKey, true);
  observer?.disconnect();
});
</script>
<template>
  <Teleport to="body">
    <div
      v-if="commands.menu.value"
      ref="menuElement"
      class="command-menu"
      role="menu"
      tabindex="-1"
      aria-label="对象操作"
      :style="position"
      @keydown="menuKey"
      @contextmenu.prevent
    >
      <div class="command-menu-title">
        {{ commands.menu.value.target ? targetNames[commands.menu.value.target.kind] : '工作区' }}
      </div>
      <button
        v-for="id in commands.menu.value.items"
        :key="id"
        role="menuitem"
        :data-command="id"
        :disabled="!commands.enabled(id, commands.menu.value.target)"
        @click="commands.invokeMenu(id)"
      >
        <span>{{ id === 'object.delete' ? '删除' : commands.byId.get(id)?.name }}</span>
        <kbd>{{ commands.byId.get(id)?.shortcuts.map(shortcutLabel).join(' / ') }}</kbd>
      </button>
    </div>
    <div v-if="commands.help.value" class="modal-backdrop" @keydown="helpKey">
      <section
        ref="helpElement"
        class="modal shortcut-help"
        role="dialog"
        aria-modal="true"
        aria-label="快捷键一览"
      >
        <header>
          <h2>快捷键一览</h2>
          <button aria-label="关闭快捷键一览" @click="commands.help.value = false">关闭</button>
        </header>
        <p>
          输入框、中文输入和弹窗优先处理自己的按键。Delete
          的操作对象显示在底部状态栏；路径编辑时只删除当前节点。
        </p>
        <table>
          <thead>
            <tr>
              <th>操作</th>
              <th>快捷键</th>
              <th>生效范围</th>
            </tr>
          </thead>
          <tbody>
            <tr
              v-for="command in commands.commands.filter((c) => c.shortcuts.length)"
              :key="command.id"
              :data-command="command.id"
            >
              <td>{{ command.name }}</td>
              <td>
                <kbd>{{ command.shortcuts.map(shortcutLabel).join(' / ') }}</kbd>
              </td>
              <td>{{ command.scope }}</td>
            </tr>
          </tbody>
        </table>
        <p>
          试玩输入：{{ playtestCodes.map((code) => code.slice(3)).join(' / ') }}
          按下判定、松开结束追踪。面板分隔条：方向键微调，Shift 加大步幅，Esc 取消拖动。
        </p>
      </section>
    </div>
  </Teleport>
</template>
<style>
.command-menu {
  position: fixed;
  z-index: 1500;
  min-width: 260px;
  max-width: calc(100vw - 8px);
  max-height: calc(100vh - 8px);
  overflow: auto;
  padding: 5px;
  background: #30363d;
  border: 1px solid #697681;
  border-radius: 6px;
  box-shadow: 0 8px 25px #0008;
}
.command-menu-title {
  font-size: 12px;
  color: var(--muted);
  padding: 6px 10px;
  border-bottom: 1px solid var(--border);
  margin-bottom: 4px;
}
.command-menu button {
  display: flex;
  justify-content: space-between;
  gap: 24px;
  width: 100%;
  text-align: left;
  padding: 7px 10px;
}
.command-menu kbd {
  color: #a8bdc8;
  font-size: 11px;
}
.command-target {
  border-right: 1px solid var(--border);
  padding-right: 10px;
  color: #bdd7db;
  white-space: nowrap;
}
.modal.shortcut-help {
  width: 800px;
  max-width: calc(100vw - 40px);
  max-height: calc(100vh - 40px);
  overflow: auto;
}
.shortcut-help header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  position: sticky;
  top: -24px;
  background: var(--panel);
  padding: 6px 0;
}
.shortcut-help p {
  margin: 12px 0;
  color: var(--muted);
  line-height: 1.6;
}
.shortcut-help table {
  width: 100%;
  border-collapse: collapse;
  font-size: 12px;
}
.shortcut-help td,
.shortcut-help th {
  padding: 8px;
  text-align: left;
  border-bottom: 1px solid var(--border);
}
.shortcut-help kbd {
  white-space: nowrap;
  color: var(--accent);
}
</style>
