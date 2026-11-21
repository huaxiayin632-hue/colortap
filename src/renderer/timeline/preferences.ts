export const timelinePreferenceKey = 'rhythm-canvas.timeline.v1';
export interface TimelinePreferences {
  version: 1;
  follow: boolean;
  ruler: 'time' | 'bars';
  zoom: number;
}
export function readTimelinePreferences(raw: string | null): TimelinePreferences {
  const result: TimelinePreferences = { version: 1, follow: true, ruler: 'time', zoom: 44 };
  try {
    const value = JSON.parse(raw ?? 'null');
    if (value?.version !== 1) return result;
    if (typeof value.follow === 'boolean') result.follow = value.follow;
    if (value.ruler === 'time' || value.ruler === 'bars') result.ruler = value.ruler;
    if (typeof value.zoom === 'number' && Number.isFinite(value.zoom))
      result.zoom = Math.max(8, Math.min(200, value.zoom));
  } catch {
    /* Local preferences must not prevent opening a project. */
  }
  return result;
}
