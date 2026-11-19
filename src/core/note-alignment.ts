import type { AudioAnalysis, DetectedOnset } from '../shared/audio-analysis';
import type { Moment, Note, Project, Span } from '../shared/models';
import { TempoMap } from './timing';
import { endUs, snappedMoment } from './chart';

export type SnapMode = 'off' | 'grid' | 'onset';
export interface NoteTimeEdit {
  id: string;
  at?: Moment;
  duration?: Span;
}
export function musicAnalysis(project: Project): AudioAnalysis | undefined {
  const music = project.music;
  if (!music?.analysis) return undefined;
  return music.analysis.sourceSha256 === project.assets[music.assetId]?.sha256
    ? music.analysis.result
    : undefined;
}
export function onsetIndex(onsets: readonly DetectedOnset[], timeUs: number): number {
  let low = 0,
    high = onsets.length;
  while (low < high) {
    const mid = (low + high) >>> 1;
    if (onsets[mid].timeUs < timeUs) low = mid + 1;
    else high = mid;
  }
  return low;
}
export function nearestOnset(
  onsets: readonly DetectedOnset[],
  timeUs: number,
  toleranceUs: number,
  minimumUs = 0,
): DetectedOnset | undefined {
  const index = onsetIndex(onsets, timeUs);
  let best: DetectedOnset | undefined;
  for (const candidate of [onsets[index - 1], onsets[index]]) {
    if (
      !candidate ||
      candidate.timeUs < minimumUs ||
      Math.abs(candidate.timeUs - timeUs) > toleranceUs
    )
      continue;
    if (
      !best ||
      Math.abs(candidate.timeUs - timeUs) < Math.abs(best.timeUs - timeUs) ||
      (Math.abs(candidate.timeUs - timeUs) === Math.abs(best.timeUs - timeUs) &&
        candidate.strength > best.strength)
    )
      best = candidate;
  }
  return best;
}
export function noteMoment(
  timeUs: number,
  tempo: TempoMap,
  mode: SnapMode,
  divisions: number,
  onsets: readonly DetectedOnset[],
  toleranceUs: number,
): Moment {
  const raw = Math.max(0, Math.round(timeUs));
  if (mode === 'grid') return snappedMoment(raw, tempo, divisions, true);
  return {
    basis: 'time',
    timeUs: mode === 'onset' ? (nearestOnset(onsets, raw, toleranceUs)?.timeUs ?? raw) : raw,
  };
}
/** Only the grabbed head snaps. Other notes follow its displacement, without another grid snap. */
export function shiftedNotes(
  project: Project,
  ids: string[],
  deltaUs: number,
  anchorId: string,
  mode: SnapMode,
  divisions: number,
  toleranceUs: number,
): NoteTimeEdit[] {
  const tempo = new TempoMap(project.timing),
    notes = ids.map((id) => project.notes[id]).filter(Boolean);
  const anchor = project.notes[anchorId];
  if (!anchor || !notes.length) return [];
  const earliest = Math.min(...notes.map((n) => tempo.resolve(n.at))),
    start = tempo.resolve(anchor.at);
  const target = noteMoment(
    start + Math.max(-earliest, deltaUs),
    tempo,
    mode,
    divisions,
    musicAnalysis(project)?.onsets ?? [],
    toleranceUs,
  );
  const shift = Math.max(-earliest, tempo.resolve(target) - start);
  return notes.map((note) => ({
    id: note.id,
    at:
      mode === 'grid'
        ? {
            basis: 'beat',
            tick: Math.max(0, Math.round(tempo.timeToTick(tempo.resolve(note.at) + shift))),
          }
        : { basis: 'time', timeUs: Math.round(tempo.resolve(note.at) + shift) },
  }));
}
export interface AlignmentEntry {
  id: string;
  fromUs: number;
  toUs: number | null;
  endBeforeUs: number;
  endAfterUs: number;
  edit?: NoteTimeEdit;
}
export function alignmentPlan(
  project: Project,
  ids: string[],
  toleranceUs: number,
  target: 'head' | 'tail',
): AlignmentEntry[] {
  const tempo = new TempoMap(project.timing),
    onsets = musicAnalysis(project)?.onsets ?? [];
  return ids.flatMap((id) => {
    const note = project.notes[id];
    if (!note || (target === 'tail' && note.kind === 'circle')) return [];
    const start = tempo.resolve(note.at),
      end = endUs(note, tempo),
      fromUs = target === 'head' ? start : end;
    const onset = nearestOnset(onsets, fromUs, toleranceUs, target === 'tail' ? start + 1 : 0);
    const needsBasisChange =
      target === 'head'
        ? note.at.basis !== 'time'
        : note.kind !== 'circle' && note.duration.basis !== 'time';
    const edit: NoteTimeEdit | undefined =
      onset && (onset.timeUs !== fromUs || needsBasisChange)
        ? target === 'head'
          ? { id, at: { basis: 'time', timeUs: onset.timeUs } }
          : { id, duration: { basis: 'time', durationUs: onset.timeUs - start } }
        : undefined;
    const after = {
      ...note,
      ...(edit?.at ? { at: edit.at } : {}),
      ...(edit?.duration ? { duration: edit.duration } : {}),
    } as Note;
    return [
      {
        id,
        fromUs,
        toUs: onset?.timeUs ?? null,
        endBeforeUs: end,
        endAfterUs: endUs(after, tempo),
        edit,
      },
    ];
  });
}
