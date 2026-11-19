import { computed, ref, shallowRef } from 'vue';
import type { CameraKey, CameraPose, CameraShake, Project, Vec2 } from '../../shared/models';
import { CameraEvaluator, neutralCamera, cameraMatrix } from '../../core/camera';
import { snappedMoment } from '../../core/chart';
import { layerBounds } from '../../core/reveal';
import { point, worldMatrix, inverse } from '../../core/layers';
import { TempoMap } from '../../core/timing';
import type { ProductionCommand } from '../../application/history';

interface Host {
  project(): Project;
  time(): number;
  edit(c: ProductionCommand): boolean;
  mode(): string;
  snap(): boolean;
  divisions(): number;
  pause(): void;
  selectedLayer(): string | null;
}
export function createCamera(host: Host) {
  const document = shallowRef(host.project()),
    selectedId = ref<string | null>(null),
    selectedShake = ref<string | null>(null),
    tool = ref<'none' | 'pan' | 'pivot'>('none'),
    showFrame = ref(true),
    pose = shallowRef<CameraPose>(neutralCamera(host.project()));
  const key = computed(() => document.value.camera.keys[selectedId.value ?? '']),
    shake = computed(() => document.value.camera.shakes?.[selectedShake.value ?? '']);
  let evaluator = new CameraEvaluator(document.value),
    draft: CameraPose | null = null,
    gesture: { start: Vec2; pose: CameraPose; id: string } | null = null;
  function setProject(p: Project) {
    document.value = p;
    if (
      evaluator.project.camera !== p.camera ||
      evaluator.project.stage !== p.stage ||
      evaluator.project.timing !== p.timing
    )
      evaluator = new CameraEvaluator(p);
    if (selectedId.value && !p.camera.keys[selectedId.value]) selectedId.value = null;
    if (selectedShake.value && !p.camera.shakes?.[selectedShake.value]) selectedShake.value = null;
    draft = null;
    gesture = null;
  }
  function update(at: number) {
    pose.value = draft ?? evaluator.at(at);
    if (host.mode() !== 'edit') tool.value = 'none';
  }
  function choose(id: string) {
    selectedId.value = id;
    selectedShake.value = null;
  }
  function moment() {
    return snappedMoment(
      host.time(),
      new TempoMap(document.value.timing),
      host.divisions(),
      host.snap(),
    );
  }
  function add() {
    const existing = keyAtMoment();
    if (existing) {
      choose(existing.id);
      return;
    }
    const k: CameraKey = {
      ...structuredClone(evaluator.at(host.time(), false)),
      id: crypto.randomUUID(),
      at: moment(),
      easingToNext: 'ease-in-out',
    };
    if (host.edit({ type: 'put-camera-key', key: k })) choose(k.id);
  }
  function patch(patch: Partial<CameraKey>) {
    if (key.value) host.edit({ type: 'put-camera-key', key: { ...key.value, ...patch } });
  }
  function keyAtMoment() {
    const tempo = new TempoMap(document.value.timing),
      at = tempo.resolve(moment());
    if (key.value && Math.abs(tempo.resolve(key.value.at) - at) < 1) return key.value;
    return Object.values(document.value.camera.keys).find(
      (k) => Math.abs(tempo.resolve(k.at) - at) < 1,
    );
  }
  function remove() {
    if (selectedId.value) host.edit({ type: 'delete-camera-key', id: selectedId.value });
  }
  function copy() {
    if (!key.value) return;
    const k = structuredClone(key.value);
    k.id = crypto.randomUUID();
    k.at = { basis: 'time', timeUs: new TempoMap(document.value.timing).resolve(k.at) + 500000 };
    if (host.edit({ type: 'put-camera-key', key: k })) choose(k.id);
  }
  function reset() {
    const neutral = neutralCamera(document.value);
    if (key.value) patch(neutral);
    else {
      const k: CameraKey = {
        ...neutral,
        id: crypto.randomUUID(),
        at: moment(),
        easingToNext: 'ease-in-out',
      };
      if (host.edit({ type: 'put-camera-key', key: k })) choose(k.id);
    }
  }
  function focusLayer() {
    const id = host.selectedLayer();
    if (!id) return;
    const r = layerBounds(document.value, id),
      position = point(worldMatrix(document.value, id), {
        x: r.x + r.width / 2,
        y: r.y + r.height / 2,
      });
    if (!key.value) add();
    patch({ position, pivot: { ...position } });
  }
  function addShake() {
    const s: CameraShake = {
      id: crypto.randomUUID(),
      at: moment(),
      duration: { basis: 'beat', ticks: 960 },
      amplitude: { x: 80, y: 65 },
      rotationRad: 0.01,
      frequencyHz: 12,
      seed: 7,
    };
    if (host.edit({ type: 'put-shake', shake: s })) {
      selectedShake.value = s.id;
      selectedId.value = null;
    }
  }
  function patchShake(patch: Partial<CameraShake>) {
    if (shake.value) host.edit({ type: 'put-shake', shake: { ...shake.value, ...patch } });
  }
  function zoomAt(at: Vec2, factor: number, rotation = 0) {
    const base = evaluator.at(host.time(), false),
      m = cameraMatrix(document.value, base),
      pivot = point(inverse(m), at),
      center = neutralCamera(document.value).position;
    const k: CameraKey = {
      ...base,
      id: keyAtMoment()?.id ?? crypto.randomUUID(),
      at: moment(),
      position: { x: center.x + pivot.x - at.x, y: center.y + pivot.y - at.y },
      pivot,
      zoom: Math.max(0.01, base.zoom * factor),
      rotationRad: base.rotationRad + rotation,
      easingToNext: key.value?.easingToNext ?? 'ease-in-out',
    };
    if (host.edit({ type: 'put-camera-key', key: k })) choose(k.id);
  }
  function down(at: Vec2) {
    host.pause();
    const current = keyAtMoment();
    const id = current?.id ?? crypto.randomUUID();
    const base = evaluator.at(host.time(), false);
    gesture = { start: at, pose: structuredClone(base), id };
    draft = base;
    if (tool.value === 'pivot') {
      draft = { ...base, pivot: at };
    }
  }
  function move(at: Vec2) {
    if (!gesture) return;
    if (tool.value === 'pivot') draft = { ...gesture.pose, pivot: at };
    else
      draft = {
        ...gesture.pose,
        position: {
          x: gesture.pose.position.x - (at.x - gesture.start.x),
          y: gesture.pose.position.y - (at.y - gesture.start.y),
        },
      };
    pose.value = draft;
  }
  function up(at: Vec2, cancel = false) {
    if (!gesture) return;
    move(at);
    const g = gesture,
      next = draft;
    gesture = null;
    draft = null;
    if (!cancel && next) {
      const k: CameraKey = {
        ...next,
        id: g.id,
        at: moment(),
        easingToNext: key.value?.easingToNext ?? 'ease-in-out',
      };
      if (host.edit({ type: 'put-camera-key', key: k })) choose(k.id);
    }
  }
  return {
    document,
    selectedId,
    selectedShake,
    key,
    shake,
    tool,
    showFrame,
    pose,
    setProject,
    update,
    choose,
    add,
    patch,
    remove,
    copy,
    reset,
    focusLayer,
    addShake,
    patchShake,
    zoomAt,
    down,
    move,
    up,
  };
}
export type CameraController = ReturnType<typeof createCamera>;
