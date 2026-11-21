export const layoutKey = 'rhythm-canvas.workspace.v1';
export const sectionIds = ['layers', 'assets', 'sounds'] as const;
export type SectionId = (typeof sectionIds)[number];
export type PanelId = 'left' | 'right' | 'timeline';
export type PresetId = 'chart' | 'show' | 'camera';
export interface WorkspaceLayout {
  version: 1;
  left: number;
  right: number;
  timeline: number;
  collapsed: Record<PanelId, boolean>;
  sections: Record<SectionId, { weight: number; collapsed: boolean }>;
}

export function presetLayout(preset: PresetId = 'chart'): WorkspaceLayout {
  return {
    version: 1,
    left: preset === 'show' ? 310 : 248,
    right: preset === 'show' ? 360 : 300,
    timeline: preset === 'chart' ? 302 : preset === 'show' ? 220 : 160,
    collapsed: { left: preset === 'camera', right: false, timeline: false },
    sections: {
      layers: { weight: preset === 'show' ? 6 : 3, collapsed: false },
      assets: { weight: 1, collapsed: preset === 'show' },
      sounds: { weight: 2, collapsed: false },
    },
  };
}

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));
export function readLayout(raw: string | null): WorkspaceLayout {
  const fallback = presetLayout();
  try {
    const value = JSON.parse(raw ?? 'null');
    if (!value || value.version !== 1) return fallback;
    for (const id of ['left', 'right', 'timeline'] as const) {
      if (typeof value[id] === 'number' && Number.isFinite(value[id]))
        fallback[id] = clamp(value[id], id === 'timeline' ? 140 : id === 'left' ? 220 : 240, 1200);
      if (typeof value.collapsed?.[id] === 'boolean') fallback.collapsed[id] = value.collapsed[id];
    }
    for (const id of sectionIds) {
      const section = value.sections?.[id];
      if (typeof section?.weight === 'number' && Number.isFinite(section.weight))
        fallback.sections[id].weight = clamp(section.weight, 0.01, 1000);
      if (typeof section?.collapsed === 'boolean')
        fallback.sections[id].collapsed = section.collapsed;
    }
  } catch {
    /* A damaged preference must never prevent opening an editor session. */
  }
  return fallback;
}

// Constrain the displayed sizes, keeping the user's preferred sizes for larger windows.
export function fitLayout(layout: WorkspaceLayout, width: number, height: number, focus = false) {
  const hidden = (id: PanelId) => focus || layout.collapsed[id];
  const rail = focus ? 0 : 28;
  const leftMin = hidden('left') ? rail : 220;
  const rightMin = hidden('right') ? rail : 240;
  const handles = (hidden('left') ? 0 : 6) + (hidden('right') ? 0 : 6);
  const available = Math.max(0, width - 360 - handles - leftMin - rightMin);
  const leftExtra = hidden('left') ? 0 : Math.max(0, layout.left - leftMin);
  const rightExtra = hidden('right') ? 0 : Math.max(0, layout.right - rightMin);
  const factor = Math.min(1, available / (leftExtra + rightExtra || 1));
  return {
    left: leftMin + leftExtra * factor,
    right: rightMin + rightExtra * factor,
    timeline: hidden('timeline') ? rail : clamp(layout.timeline, 140, Math.max(140, height - 395)),
    leftHandle: hidden('left') ? 0 : 6,
    rightHandle: hidden('right') ? 0 : 6,
    timelineHandle: hidden('timeline') ? 0 : 6,
  };
}

export function sectionSizes(layout: WorkspaceLayout, height: number) {
  const open = sectionIds.filter((id) => !layout.sections[id].collapsed);
  const available = Math.max(0, height - 3 * 32 - 2 * 6);
  const minimum = Math.min(36, available / (open.length || 1));
  const free = Math.max(0, available - minimum * open.length);
  const total = open.reduce((sum, id) => sum + layout.sections[id].weight, 0);
  return Object.fromEntries(
    sectionIds.map((id) => [
      id,
      32 + (open.includes(id) ? minimum + (free * layout.sections[id].weight) / total : 0),
    ]),
  ) as Record<SectionId, number>;
}
