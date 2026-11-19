import type { BezierPath, Moment, Note, Project, Span, Trigger, Vec2 } from '../shared/models';
import { TempoMap } from './timing';
import { identityTransform } from './layers';
import { ArcPath, createNode, smoothNodes } from './path';

export const APPROACH_US = 1_200_000;
export function spanUs(span: Span, at: Moment, tempo: TempoMap): number {
  const start = tempo.resolve(at);
  return span.basis === 'time'
    ? span.durationUs
    : tempo.tickToTime(tempo.timeToTick(start) + span.ticks) - start;
}
export function endUs(note: Note, tempo: TempoMap): number {
  return (
    tempo.resolve(note.at) + (note.kind !== 'circle' ? spanUs(note.duration, note.at, tempo) : 0)
  );
}
export function nominalTriggerTime(
  project: Project,
  trigger: Trigger,
  tempo = new TempoMap(project.timing),
): number {
  if (trigger.kind === 'timeline') return tempo.resolve(trigger.at);
  const note = project.notes[trigger.noteId];
  if (trigger.event === 'miss') return tempo.resolve(note.at) + project.rules.hitWindowsUs.good;
  if (trigger.event.endsWith('-complete') || trigger.event.endsWith('-fail'))
    return endUs(note, tempo);
  return tempo.resolve(note.at);
}
export function snappedMoment(
  timeUs: number,
  tempo: TempoMap,
  divisions: number,
  snap: boolean,
): Moment {
  return snap
    ? {
        basis: 'beat',
        tick: Math.max(0, Math.round(tempo.timeToTick(tempo.snap(timeUs, divisions)))),
      }
    : { basis: 'time', timeUs: Math.max(0, Math.round(timeUs)) };
}
/** Uniform mapping keeps circles round; all judgement stays in chart coordinates. */
export function chartMapping(project: Project) {
  const r = project.stage.playfieldRect,
    size = project.stage.artworkSize,
    chart = project.stage.chartSize;
  const x = Math.max(0, r.x),
    y = Math.max(0, r.y),
    width = Math.min(size.width, r.x + r.width) - x,
    height = Math.min(size.height, r.y + r.height) - y;
  const area = width > 0 && height > 0 ? { x, y, width, height } : { x: 0, y: 0, ...size };
  const scale = Math.min(area.width / chart.width, area.height / chart.height);
  return {
    scale,
    x: area.x + (area.width - chart.width * scale) / 2,
    y: area.y + (area.height - chart.height * scale) / 2,
  };
}
export function createSlider(
  start: Vec2,
  end: Vec2,
  at: Moment,
): { note: Extract<Note, { kind: 'slider' }>; path: BezierPath } {
  return createSliderFromPoints([start, end], at, 'bezier');
}
export function createSliderFromPoints(
  points: Vec2[],
  at: Moment,
  interpolation: 'bezier' | 'polyline' = 'bezier',
): { note: Extract<Note, { kind: 'slider' }>; path: BezierPath } {
  if (points.length < 2) throw new Error('Slider 至少需要两个点');
  const nodes = points.map(createNode);
  const path: BezierPath = {
    id: crypto.randomUUID(),
    name: 'Slider 路径',
    interpolation,
    nodes: interpolation === 'bezier' ? smoothNodes(nodes) : nodes,
    defaultWidth: 48,
    closed: false,
  };
  return createSliderFromPath(path, at);
}
export function createSliderFromPath(
  path: BezierPath,
  at: Moment,
): { note: Extract<Note, { kind: 'slider' }>; path: BezierPath } {
  if (path.nodes.length < 2) throw new Error('Slider 至少需要两个点');
  return {
    path,
    note: {
      id: crypto.randomUUID(),
      kind: 'slider',
      at,
      path: { pathId: path.id, transform: identityTransform() },
      duration: { basis: 'beat', ticks: 1920 },
      headRadius: 24,
      followRadius: 48,
    },
  };
}
export function moveNotes(
  project: Project,
  ids: string[],
  delta: Vec2,
  deltas?: Record<string, Vec2>,
): void {
  for (const id of ids) {
    const note = project.notes[id];
    if (!note) continue;
    const position = note.kind === 'slider' ? note.path.transform.position : note.position;
    position.x += (deltas?.[id] ?? delta).x;
    position.y += (deltas?.[id] ?? delta).y;
  }
}
export function copyNotes(
  project: Project,
  ids: string[],
  offset: Vec2 = { x: 16, y: 16 },
): { notes: Note[]; paths: BezierPath[] } {
  const notes: Note[] = [],
    paths: BezierPath[] = [];
  const copied = new Map<string, string>();
  for (const id of ids) {
    const original = project.notes[id];
    if (!original) continue;
    const note = structuredClone(original);
    note.id = crypto.randomUUID();
    if (note.kind !== 'slider')
      note.position = { x: note.position.x + offset.x, y: note.position.y + offset.y };
    else {
      let pathId = copied.get(note.path.pathId);
      if (!pathId) {
        const path = structuredClone(project.paths[note.path.pathId]);
        path.id = crypto.randomUUID();
        path.name += ' 副本';
        path.nodes.forEach((n) => {
          n.id = crypto.randomUUID();
        });
        paths.push(path);
        copied.set(note.path.pathId, path.id);
        pathId = path.id;
      }
      note.path.pathId = pathId;
      note.path.transform.position.x += offset.x;
      note.path.transform.position.y += offset.y;
    }
    notes.push(note);
  }
  return { notes, paths };
}
export function noteHead(note: Note, paths: Record<string, BezierPath>): Vec2 {
  return note.kind !== 'slider'
    ? note.position
    : new ArcPath(paths[note.path.pathId], note.path.transform).at(0, note.path.reversed);
}
