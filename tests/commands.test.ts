import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { effectScope, ref } from 'vue';
import { createEditor, type Editor } from '../src/renderer/state/editor';
import { createCommands, type Commands } from '../src/renderer/commands/registry';
import { matchesShortcut, type CommandTarget } from '../src/renderer/commands/context';
import type { useWorkspace } from '../src/renderer/workspace/use-workspace';

let editor: Editor, commands: Commands, scope: ReturnType<typeof effectScope>;
let modal = false;
class ElementStub {
  constructor(public text = false) {}
  closest(selector: string) {
    return this.text && selector.includes('input') ? this : null;
  }
  matches() {
    return false;
  }
}
function key(key: string, options = {}) {
  const event = {
    key,
    code: 'Key' + key.toUpperCase(),
    ctrlKey: false,
    metaKey: false,
    shiftKey: false,
    altKey: false,
    repeat: false,
    isComposing: false,
    keyCode: 0,
    defaultPrevented: false,
    target: new ElementStub(),
    preventDefault: vi.fn(),
    ...options,
  };
  commands.keydown(event as unknown as KeyboardEvent);
  return event;
}
beforeEach(() => {
  vi.stubGlobal('Element', ElementStub);
  vi.stubGlobal('document', { querySelector: () => (modal ? {} : null) });
  vi.stubGlobal('cancelAnimationFrame', vi.fn());
  modal = false;
  scope = effectScope();
  scope.run(() => {
    editor = createEditor();
    commands = createCommands(
      editor,
      {
        focus: ref(false),
        preset: vi.fn(),
        toggle: vi.fn(),
        layout: ref({ sections: {} }),
      } as unknown as ReturnType<typeof useWorkspace>,
      vi.fn(),
    );
  });
});
afterEach(async () => {
  scope.stop();
  await editor.dispose();
  vi.unstubAllGlobals();
});
const notesTarget = (): CommandTarget => ({ kind: 'notes', ids: [...editor.chart.selected.value] });

describe('one command entry and explicit operation target', () => {
  it('deletes the latest explicit selection despite other domains retaining their selections', () => {
    editor.chart.addCircle({ x: 50, y: 70 });
    const note = editor.chart.selected.value[0];
    editor.camera.add();
    const camera = editor.camera.selectedId.value!;
    expect(editor.commandTarget.value?.kind).toBe('camera');
    editor.chart.choose([note]);
    commands.run('object.delete');
    expect(editor.project.value.notes[note]).toBeUndefined();
    expect(editor.project.value.camera.keys[camera]).toBeDefined();
    expect(editor.commandTarget.value).toBeNull();
    commands.run('object.delete');
    expect(editor.project.value.camera.keys[camera]).toBeDefined();
  });
  it('does not resurrect an invalid target on undo or fall back to another old selection', async () => {
    editor.chart.addCircle({ x: 50, y: 70 });
    editor.camera.add();
    commands.run('object.delete');
    await editor.undo();
    expect(editor.commandTarget.value).toBeNull();
    expect(commands.run('object.delete')).toBe(false);
    expect(Object.keys(editor.project.value.camera.keys)).toHaveLength(1);
    expect(Object.keys(editor.project.value.notes)).toHaveLength(1);
  });
  it('allows an explicit button target while a blank menu has no deletion target', () => {
    editor.chart.addCircle({ x: 50, y: 70 });
    const target = notesTarget();
    editor.camera.add();
    expect(commands.run('object.delete', null)).toBe(false);
    commands.run('object.delete', target);
    expect(Object.keys(editor.project.value.notes)).toHaveLength(0);
    expect(Object.keys(editor.project.value.camera.keys)).toHaveLength(1);
  });
  it('deletes only a path node and never falls back to the Slider, including minimum-node paths', () => {
    editor.chart.addSlider({ x: 20, y: 20 }, { x: 100, y: 100 });
    editor.chart.setTool('path');
    editor.chart.claimSelection();
    expect(commands.enabled('object.delete')).toBe(false);
    editor.chart.addNode();
    expect(commands.enabled('object.delete')).toBe(true);
    commands.run('object.delete');
    expect(editor.chart.selectedPath.value?.nodes).toHaveLength(2);
    expect(Object.keys(editor.project.value.notes)).toHaveLength(1);
    editor.chart.nodeId.value = null;
    expect(commands.enabled('object.delete')).toBe(false);
  });
  it('rechecks target existence, busy state and edit mode for menu and button execution', () => {
    editor.chart.addCircle({ x: 10, y: 10 });
    const target = notesTarget();
    editor.busy.value = true;
    expect(commands.run('object.delete', target)).toBe(false);
    editor.busy.value = false;
    editor.chart.mode.value = 'playtest';
    expect(commands.run('object.delete', target)).toBe(false);
    editor.chart.mode.value = 'edit';
    expect(commands.run('object.delete', target)).toBe(true);
    expect(commands.run('object.delete', target)).toBe(false);
  });
  it('dispatches a duplicate once and leaves one undo entry despite repeated keydown', async () => {
    editor.chart.addCircle({ x: 10, y: 10 });
    key('d', { ctrlKey: true });
    key('d', { ctrlKey: true, repeat: true });
    expect(Object.keys(editor.project.value.notes)).toHaveLength(2);
    await editor.undo();
    expect(Object.keys(editor.project.value.notes)).toHaveLength(1);
  });
  it('leaves text input, IME composition, processed events, and modals in control', () => {
    editor.chart.addCircle({ x: 10, y: 10 });
    for (const options of [
      { target: new ElementStub(true) },
      { isComposing: true },
      { keyCode: 229 },
      { defaultPrevented: true },
    ]) {
      expect(key('Delete', options).preventDefault).not.toHaveBeenCalled();
      expect(Object.keys(editor.project.value.notes)).toHaveLength(1);
    }
    commands.composition({ type: 'compositionstart' } as CompositionEvent);
    key('Delete');
    commands.composition({ type: 'compositionend' } as CompositionEvent);
    modal = true;
    key('Delete');
    key('s', { ctrlKey: true });
    key('?');
    expect(Object.keys(editor.project.value.notes)).toHaveLength(1);
    expect(commands.help.value).toBe(false);
  });
  it('routes gameplay keys only to the existing input controller', () => {
    editor.chart.mode.value = 'playtest';
    const input = vi.spyOn(editor.chart, 'input');
    key('z');
    key('z', { repeat: true });
    key('z', { ctrlKey: true });
    expect(input).toHaveBeenCalledExactlyOnceWith('KeyZ', true);
    modal = true;
    key('x');
    expect(input).toHaveBeenCalledTimes(1);
  });
  it('routes timeline navigation through editor.seek, clamps boundaries and blocks active gestures', () => {
    const seek = vi.spyOn(editor, 'seek').mockImplementation(() => {});
    let interactive = false;
    commands.timeline.value = { canNavigate: () => !interactive, reveal: vi.fn(), locate: vi.fn() };
    editor.playback.value = {
      ...editor.playback.value,
      ready: true,
      timeUs: 400000,
      durationUs: 800000,
    };
    editor.chart.divisions.value = 3;
    commands.run('timeline.grid.1');
    expect(seek).toHaveBeenLastCalledWith(500000);
    commands.run('timeline.bar.1');
    expect(seek).toHaveBeenLastCalledWith(800000);
    commands.run('timeline.bar.-1');
    expect(seek).toHaveBeenLastCalledWith(0);
    interactive = true;
    expect(commands.run('timeline.grid.1')).toBe(false);
    expect(seek).toHaveBeenCalledTimes(3);
    expect(editor.dirty.value).toBe(false);
  });
  it('keeps command ids and registered key combinations unambiguous', () => {
    expect(new Set(commands.commands.map((c) => c.id)).size).toBe(commands.commands.length);
    const keys = commands.commands.flatMap((c) => c.shortcuts.map((s) => JSON.stringify(s)));
    expect(new Set(keys).size).toBe(keys.length);
    expect(
      matchesShortcut(
        { key: '?', ctrlKey: false, metaKey: false, shiftKey: true, altKey: false },
        { key: '?' },
      ),
    ).toBe(true);
    expect(
      matchesShortcut(
        { key: 'd', ctrlKey: false, metaKey: false, shiftKey: false, altKey: true },
        { key: 'd', ctrl: true },
      ),
    ).toBe(false);
  });
});
