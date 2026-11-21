import { computed, ref, shallowRef, watch } from 'vue';
import type { ChartCommand, EditCommand, RevealCommand } from '../../application/history';
import type { BezierPath, Project, RevealClip, RevealEffect, Vec2 } from '../../shared/models';
import { identityTransform, inverse, matrix, point, worldMatrix } from '../../core/layers';
import { ArcPath, changeNode, createNode, distance, insertNode, subtract } from '../../core/path';
import {
  layerBounds,
  hasRevealPath,
  nominalClipRange,
  resolveRevealPath,
  RevealEvaluator,
  sliderRevealPath,
  type RevealState,
} from '../../core/reveal';
import type { ChartController } from '../chart/controller';
import { sameProjectParts } from '../../core/project';

interface RevealHost {
  onSelect?(id: string): void;
  project(): Project;
  chart: ChartController;
  commit(command: RevealCommand | ChartCommand | EditCommand): boolean;
  notify(text: string, kind?: 'warning' | 'info'): void;
}
export function createReveals(host: RevealHost) {
  const document = shallowRef(host.project());
  const selectedId = ref<string | null>(null),
    pathEditing = ref(false),
    drawing = ref(false),
    nodeId = ref<string | null>(null);
  const draftPoints = shallowRef<Vec2[]>([]),
    hover = shallowRef<Vec2 | null>(null);
  const audition = ref(true),
    override = ref<number | null>(null);
  const states = shallowRef<Record<string, RevealState>>({});
  const selected = computed(() =>
    selectedId.value ? document.value.reveals[selectedId.value] : undefined,
  );
  const pathUse = computed(() =>
    selected.value && hasRevealPath(selected.value.effect)
      ? resolveRevealPath(document.value, selected.value.effect, states.value)
      : undefined,
  );
  const path = computed(() =>
    pathUse.value ? document.value.paths[pathUse.value.pathId] : undefined,
  );
  const node = computed(() => path.value?.nodes.find((n) => n.id === nodeId.value));
  const take = host.chart.take;
  let compiled: RevealEvaluator | null = null,
    dragSource: Project | null = null;
  const stops = watch([host.chart.mode, host.chart.tool], () => {
    cancel();
    override.value = null;
  });
  function cancel(): void {
    pathEditing.value = false;
    drawing.value = false;
    draftPoints.value = [];
    hover.value = null;
    dragSource = null;
    document.value = host.project();
  }
  function setProject(p: Project): void {
    document.value = p;
    dragSource = null;
    if (selectedId.value && !p.reveals[selectedId.value]) {
      selectedId.value = null;
      cancel();
    }
    if (nodeId.value && !node.value) nodeId.value = null;
  }
  function commit(command: RevealCommand | ChartCommand | EditCommand): boolean {
    if (host.chart.mode.value !== 'edit') return false;
    const ok = host.commit(command);
    document.value = host.project();
    dragSource = null;
    return ok;
  }
  function choose(id: string): void {
    cancel();
    selectedId.value = id;
    host.onSelect?.(id);
    override.value = null;
  }
  function defaultPath(layerId: string): BezierPath {
    const p = host.project(),
      r = layerBounds(p, layerId),
      m = worldMatrix(p, layerId);
    const a = point(m, { x: r.x, y: r.y + r.height / 2 }),
      b = point(m, { x: r.x + r.width, y: r.y + r.height / 2 });
    const nodes = [createNode(a), createNode(b)];
    nodes[0].handleOut = { x: (b.x - a.x) / 3, y: (b.y - a.y) / 3 };
    nodes[1].handleIn = { x: -nodes[0].handleOut.x, y: -nodes[0].handleOut.y };
    return {
      id: crypto.randomUUID(),
      name: `${p.layers[layerId].name} · 显现路径`,
      closed: false,
      interpolation: 'bezier',
      defaultWidth: Math.max(1, r.height / 3),
      nodes,
    };
  }
  function effect(
    kind: RevealEffect['kind'],
    layerId: string,
  ): { effect: RevealEffect; paths?: BezierPath[] } {
    if (kind === 'instant' || kind === 'fade') return { effect: { kind } };
    if (kind === 'slide-in') return { effect: { kind, offset: { x: -200, y: 0 } } };
    if (kind === 'pop') return { effect: { kind, fromScale: 0.25, overshoot: 0.18 } };
    if (kind === 'directional') return { effect: { kind, direction: { x: 1, y: 0 } } };
    if (kind === 'fan')
      return {
        effect: {
          kind,
          center: { x: 0.5, y: 1 },
          startAngleRad: -Math.PI,
          sweepAngleRad: Math.PI,
          direction: 'clockwise',
          mode: 'open',
        },
      };
    if (kind === 'outline') {
      const p = host.project(),
        r = layerBounds(p, layerId),
        m = worldMatrix(p, layerId),
        cx = r.x + r.width / 2,
        cy = r.y + r.height / 2,
        rx = r.width / 2,
        ry = r.height / 2,
        k = 0.5522847498307936;
      const nodes = [
        createNode({ x: cx, y: r.y }),
        createNode({ x: r.x + r.width, y: cy }),
        createNode({ x: cx, y: r.y + r.height }),
        createNode({ x: r.x, y: cy }),
      ];
      const handles = [
        { x: rx * k, y: 0 },
        { x: 0, y: ry * k },
        { x: -rx * k, y: 0 },
        { x: 0, y: -ry * k },
      ];
      nodes.forEach((n, i) => {
        const pos = point(m, n.point),
          out = point(m, { x: n.point.x + handles[i].x, y: n.point.y + handles[i].y }),
          inside = point(m, { x: n.point.x - handles[i].x, y: n.point.y - handles[i].y });
        n.point = pos;
        n.handleOut = subtract(out, pos);
        n.handleIn = subtract(inside, pos);
        n.mode = 'mirrored';
      });
      const width = Math.max(
        1,
        Math.min(p.stage.artworkSize.width, p.stage.artworkSize.height) / 300,
      );
      const path: BezierPath = {
        id: crypto.randomUUID(),
        name: `${p.layers[layerId].name} · 轮廓描绘`,
        closed: true,
        interpolation: 'bezier',
        nodes,
        defaultWidth: width,
      };
      return {
        effect: {
          kind: 'outline',
          path: { pathId: path.id, transform: identityTransform() },
          drawing: { mode: 'single', start: 0, forwardRatio: 0.5 },
          stroke: { color: '#ffffff', width, glow: 1, tips: true, tipSize: width * 1.5 },
          layer: {
            kind: 'fade',
            durationUs: 400000,
            threshold: 1,
            fromScale: 0.25,
            overshoot: 0.18,
          },
          lineAfter: { kind: 'fade', durationUs: 300000 },
        },
        paths: [path],
      };
    }
    const path = defaultPath(layerId);
    return {
      effect: {
        kind,
        path: { pathId: path.id, transform: identityTransform() },
        maskWidth: path.defaultWidth,
        completion: 'show-full-layer',
      },
      paths: [path],
    };
  }
  function add(noteId: string, layerId: string, kind: RevealEffect['kind']): void {
    const p = host.project(),
      note = p.notes[noteId];
    if (!p.layers[layerId] || !note) {
      host.notify('请先选择一个音符和目标图层', 'warning');
      return;
    }
    const built = effect(kind, layerId),
      clip: RevealClip = {
        id: crypto.randomUUID(),
        layerId,
        trigger: { kind: 'note', noteId, event: note.kind === 'slider' ? 'slider-start' : 'hit' },
        effect: built.effect,
        easing: kind === 'path' || kind === 'outline' ? 'linear' : 'ease-out',
        progress:
          note.kind === 'slider'
            ? { kind: 'slider-timeline', noteId }
            : { kind: 'elapsed', duration: { basis: 'time', durationUs: 500000 } },
        after: 'hold',
        priority: 0,
      };
    if (commit({ type: 'put-reveal', clip, paths: built.paths, hideInitially: true }))
      choose(clip.id);
  }
  function patch(patch: Partial<RevealClip>): void {
    if (
      patch.trigger?.kind === 'note' &&
      (patch.trigger.event.endsWith('-complete') || patch.trigger.event.endsWith('-fail')) &&
      selected.value?.progress.kind !== 'elapsed' &&
      !patch.progress
    ) {
      patch = {
        ...patch,
        progress: { kind: 'elapsed', duration: { basis: 'time', durationUs: 500000 } },
      };
    }
    if (selected.value) commit({ type: 'put-reveal', clip: { ...selected.value, ...patch } });
  }
  function setEffect(kind: RevealEffect['kind']): void {
    if (!selected.value) return;
    const built = effect(kind, selected.value.layerId);
    if (hasRevealPath(selected.value.effect) && hasRevealPath(built.effect)) {
      built.effect.path = structuredClone(selected.value.effect.path);
      if (selected.value.effect.linkedSliderId)
        built.effect.linkedSliderId = selected.value.effect.linkedSliderId;
      built.paths = undefined;
    }
    cancel();
    commit({
      type: 'put-reveal',
      clip: { ...selected.value, effect: built.effect },
      paths: built.paths,
    });
  }
  function patchEffect(values: Record<string, unknown>): void {
    if (selected.value) patch({ effect: { ...selected.value.effect, ...values } as RevealEffect });
  }
  function useSlider(noteId: string, linked: boolean): void {
    const clip = selected.value;
    if (!clip || !hasRevealPath(clip.effect)) return;
    const copied = sliderRevealPath(host.project(), noteId, linked, states.value);
    const next = { ...clip.effect, path: copied.instance };
    if (linked) next.linkedSliderId = noteId;
    else delete next.linkedSliderId;
    cancel();
    commit({
      type: 'put-reveal',
      clip: { ...clip, effect: next },
      paths: linked ? undefined : [copied.path],
    });
  }
  function detach(): void {
    const clip = selected.value;
    if (clip && hasRevealPath(clip.effect) && clip.effect.linkedSliderId)
      useSlider(clip.effect.linkedSliderId, false);
  }
  function claimSelection() {
    if (selectedId.value) host.onSelect?.(selectedId.value);
  }
  function editPath(): void {
    if (selectedId.value) host.onSelect?.(selectedId.value);
    host.chart.cancelGesture();
    pathEditing.value = true;
    drawing.value = false;
    nodeId.value ??= path.value?.nodes[0].id ?? null;
  }
  function startDrawing(): void {
    claimSelection();
    editPath();
    drawing.value = true;
    draftPoints.value = [];
    override.value = null;
  }
  function finishDrawing(): void {
    const clip = selected.value;
    if (!clip || !hasRevealPath(clip.effect) || draftPoints.value.length < 2) return;
    const path: BezierPath = {
      id: crypto.randomUUID(),
      name: '独立显现路径',
      interpolation: 'bezier',
      closed: false,
      defaultWidth: clip.effect.kind === 'path' ? clip.effect.maskWidth : clip.effect.stroke.width,
      nodes: draftPoints.value.map(createNode),
    };
    for (let i = 1; i < path.nodes.length; i++) {
      const a = path.nodes[i - 1],
        b = path.nodes[i];
      a.handleOut = { x: (b.point.x - a.point.x) / 3, y: (b.point.y - a.point.y) / 3 };
      b.handleIn = { x: -a.handleOut.x, y: -a.handleOut.y };
    }
    const e = { ...clip.effect, path: { pathId: path.id, transform: identityTransform() } };
    delete e.linkedSliderId;
    if (commit({ type: 'put-reveal', clip: { ...clip, effect: e }, paths: [path] })) {
      drawing.value = false;
      draftPoints.value = [];
      nodeId.value = path.nodes[0].id;
    }
  }
  function moveNode(
    id: string,
    field: 'point' | 'handleIn' | 'handleOut',
    at: Vec2,
    finish: boolean,
  ): void {
    if (!pathUse.value) return;
    dragSource ??= host.project();
    const use = resolveRevealPath(
        dragSource,
        selected.value!.effect as Extract<RevealEffect, { kind: 'path' | 'outline' }>,
        states.value,
      ),
      source = dragSource.paths[use.pathId];
    const local = point(inverse(matrix(use.transform)), at),
      n = source.nodes.find((n) => n.id === id)!;
    const next = changeNode(
      source,
      id,
      field,
      field === 'point' ? local : subtract(local, n.point),
    );
    nodeId.value = id;
    if (finish) commit({ type: 'set-path', path: next });
    else document.value = { ...dragSource, paths: { ...dragSource.paths, [next.id]: next } };
  }
  function addNode(at?: Vec2): void {
    const p = path.value,
      use = pathUse.value;
    if (!p || !use) return;
    const close = at ? new ArcPath(p).closest(point(inverse(matrix(use.transform)), at)) : null;
    const index =
      close?.segment ??
      Math.min(
        Math.max(
          0,
          p.nodes.findIndex((n) => n.id === nodeId.value),
        ),
        p.nodes.length - 2,
      );
    const next = insertNode(p, index, close?.t ?? 0.5);
    if (commit({ type: 'set-path', path: next })) nodeId.value = next.nodes[index + 1].id;
  }
  function deleteNode(): void {
    if (!path.value || !nodeId.value) return;
    if (path.value.nodes.length <= 2) {
      host.notify('路径至少保留两个节点', 'warning');
      return;
    }
    const next = structuredClone(path.value);
    next.nodes = next.nodes.filter((n) => n.id !== nodeId.value);
    commit({ type: 'set-path', path: next });
    nodeId.value = next.nodes[0].id;
  }
  function reverse(): void {
    const e = selected.value?.effect;
    if (!e || !hasRevealPath(e)) return;
    if (e.linkedSliderId) {
      const n = structuredClone(host.project().notes[e.linkedSliderId]);
      if (n.kind === 'slider') {
        n.path.reversed = !n.path.reversed;
        commit({ type: 'set-note', note: n });
      }
    } else patchEffect({ path: { ...e.path, reversed: !e.path.reversed } });
  }
  function update(at: number): void {
    if (
      !sameProjectParts(compiled?.project, document.value, [
        'reveals',
        'paths',
        'notes',
        'timing',
        'stage',
        'layers',
        'rules',
      ])
    )
      compiled = new RevealEvaluator(document.value);
    const mode = host.chart.mode.value;
    states.value =
      mode === 'edit' && !audition.value && override.value === null
        ? {}
        : compiled!.evaluate(at, {
            mode,
            take,
            override:
              mode === 'edit' && selectedId.value && override.value !== null
                ? { clipId: selectedId.value, progress: override.value }
                : null,
          });
  }
  return {
    claimSelection,
    document,
    selectedId,
    selected,
    pathUse,
    path,
    node,
    nodeId,
    pathEditing,
    drawing,
    draftPoints,
    hover,
    audition,
    override,
    states,
    take,
    setProject,
    choose,
    add,
    patch,
    setEffect,
    patchEffect,
    useSlider,
    detach,
    editPath,
    startDrawing,
    finishDrawing,
    moveNode,
    addNode,
    deleteNode,
    reverse,
    cancel,
    update,
    appendPoint(at: Vec2) {
      if (!draftPoints.value.length || distance(draftPoints.value.at(-1)!, at) > 0.1)
        draftPoints.value = [...draftPoints.value, { ...at }];
    },
    setPath(path: BezierPath) {
      commit({ type: 'set-path', path });
    },
    remove(id = selectedId.value) {
      if (id) commit({ type: 'delete-reveal', id, restoreVisibility: true });
    },
    range(clip: RevealClip) {
      return nominalClipRange(document.value, clip);
    },
    dispose() {
      stops();
    },
  };
}
export type RevealController = ReturnType<typeof createReveals>;
