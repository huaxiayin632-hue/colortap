import { describe, expect, it } from 'vitest';
import { EditHistory, type ProductionCommand } from '../src/application/history';
import { createProject } from '../src/shared/models';
import { createCamera } from '../src/renderer/camera/controller';
import { cameraMatrix } from '../src/core/camera';
import { inverse, point } from '../src/core/layers';

function setup() {
  const history = new EditHistory(createProject()),
    clock = { time: 0 };
  const camera = createCamera({
    project: () => history.current,
    time: () => clock.time,
    edit(command: ProductionCommand) {
      history.execute(command);
      camera.setProject(history.current);
      return true;
    },
    mode: () => 'edit',
    snap: () => true,
    divisions: () => 4,
    pause() {},
    selectedLayer: () => null,
  });
  return { history, clock, camera };
}
describe('camera authoring ownership and undo', () => {
  it('reuses the key at the snapped time even after a shake was selected', () => {
    const { history, camera } = setup();
    camera.add();
    const first = camera.selectedId.value;
    camera.addShake();
    camera.add();
    expect(camera.selectedId.value).toBe(first);
    expect(Object.keys(history.current.camera.keys)).toHaveLength(1);
    camera.selectedId.value = null;
    camera.zoomAt({ x: 1000, y: 1200 }, 2);
    expect(camera.selectedId.value).toBe(first);
    expect(Object.keys(history.current.camera.keys)).toHaveLength(1);
  });
  it('keeps drag drafts out of the document and commits one undoable key edit', () => {
    const { history, camera } = setup();
    camera.add();
    const before = structuredClone(history.current.camera.keys);
    camera.tool.value = 'pan';
    camera.down({ x: 100, y: 100 });
    camera.move({ x: 200, y: 180 });
    camera.update(0);
    expect(history.current.camera.keys).toEqual(before);
    camera.up({ x: 200, y: 180 });
    expect(Object.keys(history.current.camera.keys)).toHaveLength(1);
    expect(camera.key.value!.position.x).toBe(2900);
    history.undo();
    camera.setProject(history.current);
    expect(history.current.camera.keys).toEqual(before);
    camera.down({ x: 100, y: 100 });
    camera.up({ x: 500, y: 500 }, true);
    expect(history.current.camera.keys).toEqual(before);
  });
  it('keeps the source point under the pointer when changing zoom and rotation', () => {
    const { history, camera } = setup();
    camera.add();
    camera.patch({ position: { x: 2800, y: 2600 }, zoom: 1.8, rotationRad: 0.2 });
    camera.update(0);
    const pointer = { x: 1700, y: 1300 };
    const source = point(inverse(cameraMatrix(history.current, camera.pose.value)), pointer);
    camera.zoomAt(pointer, 1.25, 0.15);
    camera.update(0);
    const destination = point(cameraMatrix(history.current, camera.pose.value), source);
    expect(destination.x).toBeCloseTo(pointer.x);
    expect(destination.y).toBeCloseTo(pointer.y);
    expect(Object.keys(history.current.camera.keys)).toHaveLength(1);
  });
});
