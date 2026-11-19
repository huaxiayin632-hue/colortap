import { computed, ref, shallowRef } from 'vue';
import type { ChartCommand } from '../../application/history';
import { createSliderFromPath, copyNotes, moveNotes, spanUs } from '../../core/chart';
import {
  alignmentPlan,
  musicAnalysis,
  noteMoment,
  shiftedNotes,
  type SnapMode,
} from '../../core/note-alignment';
import { decompose, inverse, matrix, multiply, point, type Affine } from '../../core/layers';
import { SceneGeometry } from '../../core/scene-geometry';
import { chartMatrix, identityMatrix, invertible } from '../../core/path-binding';
import { hasRevealPath, resolveRevealPath, type RevealEvaluation } from '../../core/reveal';
import {
  ArcPath,
  changeNode,
  createNode,
  distance,
  insertNode,
  smoothNodes,
  subtract,
} from '../../core/path';
import { PlaySession, type GameplayEvent, type ResetReason } from '../../core/judgement';
import { TempoMap } from '../../core/timing';
import { sameProjectParts } from '../../core/project';
import { PlaybackTake } from '../../core/playback';
import type { BezierPath, Moment, Note, Project, Vec2 } from '../../shared/models';

export type EditorMode = 'edit' | 'preview' | 'playtest';
export type ChartTool = 'layers' | 'select' | 'circle' | 'hold' | 'slider' | 'path';
interface ChartHost {
  take?: PlaybackTake;
  sourceOnly?(): boolean;
  revealOverride?(): RevealEvaluation['override'];
  project(): Project;
  time(): number;
  playing(): boolean;
  commit(command: ChartCommand): boolean;
  pause(): void;
  seek(timeUs: number): void;
  play(): Promise<void>;
  selectLayer(id: null): void;
  notify(text: string, kind?: 'info' | 'warning' | 'error' | 'success'): void;
}
export function createChart(host: ChartHost) {
  const take = host.take ?? new PlaybackTake();
  const document = shallowRef(host.project());
  const mode = ref<EditorMode>('edit'),
    tool = ref<ChartTool>('layers');
  const selected = ref<string[]>([]),
    nodeId = ref<string | null>(null);
  const snapMode = ref<SnapMode>('grid'),
    divisions = ref(4),
    onsetToleranceUs = ref(40_000);
  // Non-note tracks retain their existing grid policy when snapping is enabled.
  const snap = computed({
    get: () => snapMode.value !== 'off',
    set: (value: boolean) => {
      snapMode.value = value ? 'grid' : 'off';
    },
  });
  const gestureEpoch = ref(0);
  const timeUs = ref(0),
    pointer = shallowRef<Vec2 | null>(null);
  const runtime = shallowRef<ReturnType<PlaySession['snapshot']> | null>(null);
  const events = shallowRef<GameplayEvent[]>([]);
  const listeners = new Set<(event: GameplayEvent) => void>();
  const feedback = shallowRef<{
    label: string;
    kind: 'perfect' | 'good' | 'miss' | 'complete' | 'failed';
    timeUs: number;
  } | null>(null);
  const sliderDraft = shallowRef<BezierPath | null>(null),
    sliderCursor = shallowRef<Vec2 | null>(null),
    appendMode = ref(false);
  const penHandles = new Set<string>();
  const sliderPreview = computed(() => {
    const draft = sliderDraft.value,
      cursor = sliderCursor.value;
    if (!draft || !cursor || distance(draft.nodes.at(-1)!.point, cursor) < 1) return draft;
    const tip = { ...draft.nodes.at(-1)!, id: 'pen-preview', point: cursor };
    return { ...draft, nodes: smoothNodes([...draft.nodes, tip], penHandles) };
  });
  let sliderAt: Moment | null = null;
  const selectionBox = shallowRef<{ start: Vec2; end: Vec2 } | null>(null);
  const selectedNote = computed(() =>
    selected.value.length === 1 ? document.value.notes[selected.value[0]] : undefined,
  );
  const selectedPath = computed(() =>
    selectedNote.value?.kind === 'slider'
      ? document.value.paths[selectedNote.value.path.pathId]
      : undefined,
  );
  const selectedNode = computed(() => selectedPath.value?.nodes.find((n) => n.id === nodeId.value));
  const timing = computed(() => document.value.timing);
  const tempo = computed(() => new TempoMap(timing.value));
  const analysis = computed(() => musicAnalysis(document.value));
  function resolveMoment(at: number, bypassSnap = false): Moment {
    return noteMoment(
      at,
      tempo.value,
      bypassSnap ? 'off' : snapMode.value,
      divisions.value,
      analysis.value?.onsets ?? [],
      onsetToleranceUs.value,
    );
  }
  const held = new Set<string>();
  let session: PlaySession | null = null,
    dragSource: Project | null = null;
  let published = host.project();
  let clipboard: {
    notes: Note[];
    paths: BezierPath[];
    detached: Note[];
    projectId: string;
  } | null = null;
  let geometry: SceneGeometry | null = null;
  function geometryFor(p = document.value): SceneGeometry {
    if (
      !sameProjectParts(geometry?.project, p, [
        'notes',
        'paths',
        'layers',
        'rootLayersBottomToTop',
        'reveals',
        'camera',
        'timing',
        'rules',
        'stage',
        'pixelSources',
      ])
    )
      geometry = new SceneGeometry(p);
    return geometry!;
  }
  function displayMatrix(note: Note, at = timeUs.value, p = document.value): Affine {
    if (note.kind !== 'slider' || !note.binding) return identityMatrix();
    return geometryFor(p).display(
      note,
      at,
      mode.value,
      take,
      mode.value === 'edit' && host.sourceOnly?.(),
      mode.value === 'edit' ? host.revealOverride?.() : undefined,
    );
  }
  function displayMatrices(): Record<string, Affine> {
    const bound = Object.values(document.value.notes).filter(
      (n) => n.kind === 'slider' && n.binding,
    );
    if (!bound.length) return {};
    const g = geometryFor(),
      { camera, poses } = g.at(
        timeUs.value,
        mode.value,
        take,
        mode.value === 'edit' && host.sourceOnly?.(),
        mode.value === 'edit' ? host.revealOverride?.() : undefined,
        g.bindings.layersFor(bound),
      );
    return Object.fromEntries(bound.map((n) => [n.id, g.bindings.display(n, camera, poses)]));
  }
  function authorPoint(at: Vec2): Vec2 {
    const n = selectedNote.value;
    return n ? point(inverse(displayMatrix(n)), at) : at;
  }
  function bindLayer(id: string | null): void {
    const note = selectedNote.value;
    if (note?.kind !== 'slider') return;
    try {
      const g = geometryFor(),
        { camera, poses } = g.at(
          timeUs.value,
          mode.value,
          take,
          host.sourceOnly?.(),
          host.revealOverride?.(),
        );
      setNote(g.bindings.attach(note, id, camera, poses));
    } catch (e) {
      host.notify(e instanceof Error ? e.message : '无法贴合该图层', 'warning');
    }
  }
  function useRevealPath(id: string): void {
    const note = selectedNote.value,
      clip = document.value.reveals[id];
    if (note?.kind !== 'slider' || !clip || !hasRevealPath(clip.effect)) return;
    try {
      const p = document.value,
        g = geometryFor(),
        { poses } = g.at(
          timeUs.value,
          mode.value,
          take,
          host.sourceOnly?.(),
          host.revealOverride?.(),
        );
      const use = resolveRevealPath(p, clip.effect, poses),
        reference = g.bindings.layerWorld(clip.layerId, poses);
      if (!invertible(reference)) throw Error('图层当前缩放为零，请先定位到展开后的时刻');
      commit({
        type: 'use-reveal-path',
        revealId: id,
        note: {
          ...note,
          path: {
            ...use,
            transform: decompose(multiply(inverse(chartMatrix(p)), matrix(use.transform))),
          },
          binding: { layerId: clip.layerId, reference: decompose(reference) },
        },
      });
    } catch (e) {
      host.notify(e instanceof Error ? e.message : '无法复用该路径', 'warning');
    }
  }
  function event(e: GameplayEvent): void {
    take.accept(e);
    events.value = [...events.value.slice(-127), e];
    if (
      e.kind === 'circle-hit' ||
      e.kind === 'circle-miss' ||
      e.kind === 'slider-complete' ||
      e.kind === 'slider-fail' ||
      e.kind === 'hold-complete' ||
      e.kind === 'hold-fail'
    ) {
      const kind =
        e.kind === 'circle-hit'
          ? e.grade!
          : e.kind === 'circle-miss'
            ? 'miss'
            : e.kind === 'slider-complete' || e.kind === 'hold-complete'
              ? 'complete'
              : 'failed';
      feedback.value = {
        kind,
        label: {
          perfect: 'Perfect',
          good: 'Good',
          miss: 'Miss',
          complete: e.kind === 'hold-complete' ? '长按完成' : 'Slider 完成',
          failed: e.kind === 'hold-fail' ? '长按失败' : 'Slider 失败',
        }[kind],
        timeUs: e.timeUs,
      };
    }
    for (const listener of listeners) listener(e);
  }
  function reset(at = host.time(), reason: ResetReason = 'restart'): void {
    held.clear();
    events.value = [];
    feedback.value = null;
    const movingGeometry =
      mode.value === 'playtest' &&
      Object.values(host.project().notes).some((n) => n.kind === 'slider' && n.binding)
        ? geometryFor(host.project())
        : null;
    session =
      mode.value === 'playtest'
        ? new PlaySession(
            host.project(),
            at,
            (e) => event(e.kind === 'session-reset' ? { ...e, reason } : e),
            movingGeometry
              ? {
                  matrix: (note, t) => movingGeometry.display(note, t, 'playtest', take),
                }
              : undefined,
            take.recordTrack,
          )
        : null;
    if (!session) event({ kind: 'session-reset', runId: crypto.randomUUID(), timeUs: at, reason });
    runtime.value = session?.snapshot() ?? null;
  }
  function setProject(project: Project): void {
    if (document.value === project) return;
    const hasBindings = [published, project].some((p) =>
      Object.values(p.notes).some((n) => n.kind === 'slider' && n.binding),
    );
    const changed =
      !sameProjectParts(published, project, ['notes', 'paths', 'timing', 'rules']) ||
      published.stage.chartSize !== project.stage.chartSize ||
      (hasBindings &&
        !sameProjectParts(published, project, [
          'layers',
          'rootLayersBottomToTop',
          'reveals',
          'camera',
          'stage',
        ]));
    document.value = project;
    selected.value = selected.value.filter((id) => Boolean(project.notes[id]));
    if (!selectedNode.value) nodeId.value = null;
    dragSource = null;
    if (changed) reset(host.time(), 'document');
    published = project;
  }
  function commit(command: ChartCommand): boolean {
    if (mode.value !== 'edit') return false;
    const success = host.commit(command);
    document.value = host.project();
    dragSource = null;
    return success;
  }
  function choose(ids: string[], additive = false): void {
    host.selectLayer(null);
    selected.value = additive
      ? [...new Set([...selected.value, ...ids])].filter((id) => document.value.notes[id])
      : ids.filter((id) => document.value.notes[id]);
    nodeId.value = null;
    appendMode.value = false;
  }
  function select(id: string, toggle = false): void {
    if (toggle && selected.value.includes(id))
      selected.value = selected.value.filter((key) => key !== id);
    else choose([id], toggle);
  }
  function setTool(value: ChartTool): void {
    if (mode.value !== 'edit') return;
    cancelGesture();
    tool.value = value;
    if (value !== 'layers') host.selectLayer(null);
    if (value !== 'path') nodeId.value = null;
  }
  function cancelGesture(): void {
    gestureEpoch.value++;
    document.value = host.project();
    dragSource = null;
    sliderDraft.value = null;
    sliderCursor.value = null;
    penHandles.clear();
    selectionBox.value = null;
    sliderAt = null;
    appendMode.value = false;
  }
  function release(): void {
    held.clear();
    if (session) {
      session.input(Math.max(host.time(), session.timeUs), pointer.value, false);
      runtime.value = session.snapshot();
    }
  }
  function setMode(value: EditorMode): void {
    host.pause();
    cancelGesture();
    mode.value = value;
    reset(host.time(), 'mode');
  }
  function update(at: number): void {
    timeUs.value = at;
    if (session && mode.value === 'playtest') {
      // Device output timestamp estimates can jitter slightly. Only explicit seek/replay resets a run.
      session.advance(Math.max(at, session.timeUs));
      runtime.value = session.snapshot();
    }
  }
  function setPointer(at: Vec2 | null): void {
    pointer.value = at;
    if (session && host.playing()) {
      session.input(Math.max(host.time(), session.timeUs), at, held.size > 0);
      runtime.value = session.snapshot();
    }
  }
  function input(key: string, down: boolean): void {
    if (mode.value !== 'playtest') return;
    const pressed = down && !held.has(key);
    if (down) held.add(key);
    else held.delete(key);
    if (session && host.playing()) {
      session.input(Math.max(host.time(), session.timeUs), pointer.value, held.size > 0, pressed);
      runtime.value = session.snapshot();
    }
  }
  function moment() {
    return resolveMoment(host.time());
  }
  function addCircle(at: Vec2): void {
    const note: Note = {
      id: crypto.randomUUID(),
      kind: 'circle',
      at: moment(),
      position: { ...at },
      radius: 24,
    };
    if (commit({ type: 'add-notes', notes: [note] })) choose([note.id]);
  }
  function addHold(at: Vec2): void {
    const note: Note = {
      id: crypto.randomUUID(),
      kind: 'hold',
      at: moment(),
      position: { ...at },
      radius: 24,
      duration: { basis: 'beat', ticks: 1920 },
    };
    if (commit({ type: 'add-notes', notes: [note] })) choose([note.id]);
  }
  function beginSlider(): void {
    sliderAt ??= moment();
  }
  function addSliderPoint(at: Vec2): string | null {
    beginSlider();
    const draft = sliderDraft.value;
    if (draft && distance(draft.nodes.at(-1)!.point, at) <= 1) return null;
    const node = createNode(at);
    sliderDraft.value = {
      id: draft?.id ?? crypto.randomUUID(),
      name: 'Slider 路径',
      closed: false,
      defaultWidth: 48,
      interpolation: 'bezier',
      nodes: smoothNodes([...(draft?.nodes ?? []), node], penHandles),
    };
    sliderCursor.value = null;
    return node.id;
  }
  function moveDraftNode(id: string, field: 'point' | 'handleIn' | 'handleOut', at: Vec2): void {
    const draft = sliderDraft.value;
    if (!draft) return;
    const node = draft.nodes.find((n) => n.id === id)!;
    if (field !== 'point') penHandles.add(id);
    const next = changeNode(draft, id, field, field === 'point' ? at : subtract(at, node.point));
    sliderDraft.value = { ...next, nodes: smoothNodes(next.nodes, penHandles) };
    sliderCursor.value = null;
  }
  function finishSlider(): void {
    const draft = sliderDraft.value;
    if (!draft || draft.nodes.length < 2) return;
    const created = createSliderFromPath(draft, sliderAt ?? moment());
    if (commit({ type: 'add-notes', notes: [created.note], paths: [created.path] })) {
      choose([created.note.id]);
      tool.value = 'path';
      nodeId.value = created.path.nodes[0].id;
      cancelGesture();
    }
  }
  function addSlider(start: Vec2, end: Vec2): void {
    addSliderPoint(start);
    addSliderPoint(end);
    finishSlider();
  }
  function moveSelected(delta: Vec2, finish: boolean): void {
    dragSource ??= host.project();
    const deltas: Record<string, Vec2> = {};
    for (const id of selected.value) {
      const n = dragSource.notes[id];
      if (n?.kind === 'slider' && n.binding) {
        const m = inverse(displayMatrix(n, timeUs.value, dragSource));
        deltas[id] = { x: m.a * delta.x + m.c * delta.y, y: m.b * delta.x + m.d * delta.y };
      }
    }
    if (finish) {
      commit({ type: 'move-notes', ids: [...selected.value], delta, deltas });
      return;
    }
    const next = { ...dragSource, notes: structuredClone(dragSource.notes) };
    moveNotes(next, selected.value, delta, deltas);
    document.value = next;
  }
  function setNote(note: Note): void {
    commit({ type: 'set-note', note });
  }
  function setNoteTime(id: string, at: number, bypassSnap = false): void {
    const note = structuredClone(host.project().notes[id]);
    note.at = resolveMoment(at, bypassSnap);
    setNote(note);
  }
  function shiftPlan(deltaUs: number, anchorId = selected.value[0], bypassSnap = false) {
    return shiftedNotes(
      host.project(),
      selected.value,
      deltaUs,
      anchorId,
      bypassSnap ? 'off' : snapMode.value,
      divisions.value,
      onsetToleranceUs.value,
    );
  }
  function setTimeBasis(basis: 'time' | 'beat'): void {
    const note = selectedNote.value;
    if (!note) return;
    const at = tempo.value.resolve(note.at);
    setNote({
      ...note,
      at:
        basis === 'beat'
          ? { basis, tick: Math.max(0, Math.round(tempo.value.timeToTick(at))) }
          : { basis, timeUs: at },
    });
  }
  function removeNotes(): void {
    if (commit({ type: 'delete-notes', ids: [...selected.value] })) {
      selected.value = [];
      nodeId.value = null;
    }
  }
  function copy(): void {
    const copied = copyNotes(document.value, selected.value, { x: 0, y: 0 });
    const detached = copied.notes.map((n) => {
      const note = structuredClone(n);
      if (note.kind === 'slider' && note.binding) {
        note.path.transform = decompose(multiply(displayMatrix(note), matrix(note.path.transform)));
        delete note.binding;
      }
      return note;
    });
    clipboard = { ...copied, detached, projectId: document.value.id };
  }
  function paste(): void {
    if (!clipboard) return;
    const temp = {
      ...host.project(),
      notes: Object.fromEntries(
        clipboard.notes.map((n, i) => [
          n.id,
          n.kind === 'slider' &&
          n.binding &&
          (clipboard!.projectId !== host.project().id || !host.project().layers[n.binding.layerId])
            ? clipboard!.detached[i]
            : n,
        ]),
      ),
      paths: Object.fromEntries(clipboard.paths.map((p) => [p.id, p])),
    };
    const copied = copyNotes(
      temp,
      clipboard.notes.map((n) => n.id),
    );
    if (commit({ type: 'add-notes', ...copied })) choose(copied.notes.map((n) => n.id));
  }
  function duplicate(): void {
    copy();
    paste();
  }
  function setPath(path: BezierPath): void {
    commit({ type: 'set-path', path });
  }
  function moveNode(
    id: string,
    field: 'point' | 'handleIn' | 'handleOut',
    at: Vec2,
    finish: boolean,
  ): void {
    const note = selectedNote.value;
    if (note?.kind !== 'slider') return;
    dragSource ??= host.project();
    const source = dragSource.paths[note.path.pathId];
    const local = point(inverse(matrix(note.path.transform)), authorPoint(at)),
      node = source.nodes.find((n) => n.id === id)!;
    const path = changeNode(
      source,
      id,
      field,
      field === 'point' ? local : subtract(local, node.point),
    );
    nodeId.value = id;
    if (finish) setPath(path);
    else document.value = { ...dragSource, paths: { ...dragSource.paths, [path.id]: path } };
  }
  function addNode(at?: Vec2): void {
    const path = selectedPath.value,
      note = selectedNote.value;
    if (!path || note?.kind !== 'slider') return;
    const local = at ? point(inverse(matrix(note.path.transform)), authorPoint(at)) : null;
    const close = local ? new ArcPath(path).closest(local) : null;
    const segment =
      close?.segment ??
      Math.min(
        Math.max(
          0,
          path.nodes.findIndex((n) => n.id === nodeId.value),
        ),
        path.nodes.length - 2,
      );
    const next = insertNode(path, segment, close?.t ?? 0.5);
    setPath(next);
    nodeId.value = next.nodes[segment + 1].id;
  }
  function appendNode(at: Vec2): void {
    const path = selectedPath.value,
      note = selectedNote.value;
    if (!path || note?.kind !== 'slider') return;
    const local = point(inverse(matrix(note.path.transform)), authorPoint(at));
    if (distance(path.nodes.at(-1)!.point, local) < 1) return;
    const next = structuredClone(path),
      node = createNode(local);
    if (path.interpolation !== 'polyline') {
      const previous = path.nodes.at(-1)!.point;
      node.mode = 'mirrored';
      node.handleOut = { x: (local.x - previous.x) / 3, y: (local.y - previous.y) / 3 };
      node.handleIn = { x: -node.handleOut.x, y: -node.handleOut.y };
    }
    next.nodes.push(node);
    setPath(next);
    nodeId.value = node.id;
  }
  function toggleAppend(): void {
    const enabled = !appendMode.value;
    setTool('path');
    appendMode.value = enabled;
  }
  function deleteNode(): void {
    const path = selectedPath.value;
    if (!path || !nodeId.value) return;
    if (path.nodes.length <= 2) {
      host.notify('Slider 至少保留两个节点', 'warning');
      return;
    }
    const next = structuredClone(path);
    next.nodes = next.nodes.filter((n) => n.id !== nodeId.value);
    setPath(next);
    nodeId.value = next.nodes[0].id;
  }
  function editNode(
    field: 'point' | 'handleIn' | 'handleOut',
    axis: 'x' | 'y',
    value: number,
  ): void {
    const path = selectedPath.value,
      node = selectedNode.value;
    if (!path || !node || !Number.isFinite(value)) return;
    setPath(changeNode(path, node.id, field, { ...node[field], [axis]: value }));
  }
  function smoothNode(): void {
    const path = selectedPath.value,
      node = selectedNode.value;
    if (!path || !node) return;
    const next = structuredClone(path),
      i = next.nodes.findIndex((n) => n.id === node.id),
      n = next.nodes[i];
    const a = next.nodes[Math.max(0, i - 1)].point,
      b = next.nodes[Math.min(next.nodes.length - 1, i + 1)].point;
    n.handleOut = { x: (b.x - a.x) / 3, y: (b.y - a.y) / 3 };
    n.handleIn = { x: -n.handleOut.x, y: -n.handleOut.y };
    n.mode = 'mirrored';
    setPath(next);
  }
  function setDuration(seconds: number): void {
    const note = selectedNote.value;
    if (!note || note.kind === 'circle' || !(seconds > 0)) return;
    setNote({
      ...note,
      duration: { basis: 'time', durationUs: Math.max(1, Math.round(seconds * 1000000)) },
    });
  }
  function setDurationBeats(beats: number): void {
    const note = selectedNote.value;
    if (note && note.kind !== 'circle' && beats > 0)
      setNote({
        ...note,
        duration: { basis: 'beat', ticks: Math.max(1, Math.round(beats * 960)) },
      });
  }
  function setSpeed(speed: number): void {
    const note = selectedNote.value,
      path = selectedPath.value;
    if (note?.kind === 'slider' && path && speed > 0)
      setDuration(new ArcPath(path, note.path.transform).length / speed);
  }
  async function replay(): Promise<void> {
    host.pause();
    if (mode.value !== 'playtest') mode.value = 'playtest';
    host.seek(0);
    reset(0);
    await host.play();
  }
  const duration = computed(() =>
    selectedNote.value && selectedNote.value.kind !== 'circle'
      ? spanUs(selectedNote.value.duration, selectedNote.value.at, tempo.value)
      : 0,
  );
  return {
    displayMatrix,
    displayMatrices,
    bindLayer,
    useRevealPath,
    take,
    document,
    mode,
    tool,
    selected,
    selectedNote,
    selectedPath,
    selectedNode,
    nodeId,
    snap,
    snapMode,
    onsetToleranceUs,
    analysis,
    resolveMoment,
    shiftPlan,
    divisions,
    gestureEpoch,
    timeUs,
    pointer,
    runtime,
    events,
    feedback,
    sliderDraft,
    sliderCursor,
    sliderPreview,
    appendMode,
    selectionBox,
    tempo,
    duration,
    setProject,
    setMode,
    setTool,
    cancelGesture,
    choose,
    select,
    reset,
    update,
    release,
    setPointer,
    input,
    addCircle,
    addHold,
    addSlider,
    beginSlider,
    addSliderPoint,
    moveDraftNode,
    finishSlider,
    moveSelected,
    setNote,
    setNoteTime,
    setTimeBasis,
    removeNotes,
    copy,
    paste,
    duplicate,
    shiftNotes: (deltaUs: number, anchorId = selected.value[0], bypassSnap = false) =>
      commit({ type: 'set-note-times', updates: shiftPlan(deltaUs, anchorId, bypassSnap) }),
    alignmentPlan: (target: 'head' | 'tail') =>
      alignmentPlan(document.value, selected.value, onsetToleranceUs.value, target),
    alignSelected: (target: 'head' | 'tail') =>
      commit({
        type: 'set-note-times',
        updates: alignmentPlan(
          host.project(),
          selected.value,
          onsetToleranceUs.value,
          target,
        ).flatMap((entry) => (entry.edit ? [entry.edit] : [])),
      }),
    setPath,
    moveNode,
    addNode,
    appendNode,
    toggleAppend,
    deleteNode,
    editNode,
    smoothNode,
    setDuration,
    setDurationBeats,
    setSpeed,
    replay,
    selectAll: () => choose(Object.keys(document.value.notes)),
    subscribe(listener: (event: GameplayEvent) => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    dispose() {
      take.clear();
      held.clear();
      listeners.clear();
      session = null;
    },
  };
}
export type ChartController = ReturnType<typeof createChart>;
