import type { Project } from '../../shared/models';

export const playtestCodes = ['KeyZ', 'KeyX'];
export type TargetKind = 'layer' | 'notes' | 'reveal' | 'sound' | 'camera' | 'shake';
export type CommandTarget = { kind: TargetKind; ids: string[] } | null;
export const targetNames: Record<TargetKind, string> = {
  layer: '图层',
  notes: '音符',
  reveal: '演出片段',
  sound: '音效片段',
  camera: '镜头关键帧',
  shake: '镜头震动',
};
export function validTarget(project: Project, target: CommandTarget): boolean {
  if (!target?.ids.length) return false;
  const objects = {
    layer: project.layers,
    notes: project.notes,
    reveal: project.reveals,
    sound: project.sounds,
    camera: project.camera.keys,
    shake: project.camera.shakes ?? {},
  }[target.kind];
  return target.ids.every((id) => Object.hasOwn(objects, id));
}

export interface Shortcut {
  key: string;
  ctrl?: boolean;
  shift?: boolean;
  alt?: boolean;
}
export function matchesShortcut(
  event: Pick<KeyboardEvent, 'key' | 'ctrlKey' | 'metaKey' | 'shiftKey' | 'altKey'>,
  shortcut: Shortcut,
) {
  return (
    event.key.toLowerCase() === shortcut.key.toLowerCase() &&
    (event.ctrlKey || event.metaKey) === Boolean(shortcut.ctrl) &&
    event.altKey === Boolean(shortcut.alt) &&
    (shortcut.key === '?' || event.shiftKey === Boolean(shortcut.shift))
  );
}
export function shortcutLabel(s: Shortcut) {
  return [
    s.ctrl ? 'Ctrl' : '',
    s.alt ? 'Alt' : '',
    s.shift ? 'Shift' : '',
    s.key === ' ' ? 'Space' : s.key.length === 1 ? s.key.toUpperCase() : s.key,
  ]
    .filter(Boolean)
    .join('+');
}
export function isTextTarget(target: EventTarget | null) {
  return (
    target instanceof Element &&
    Boolean(
      target.closest(
        'input, textarea, select, [contenteditable]:not([contenteditable="false"]), [role="textbox"]',
      ),
    )
  );
}
