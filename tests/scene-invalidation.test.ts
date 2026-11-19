import { afterEach, describe, expect, it, vi } from 'vitest';
import { EditHistory } from '../src/application/history';
import { identityTransform } from '../src/core/layers';
import { Viewport } from '../src/core/viewport';
import { createProject } from '../src/shared/models';
import { LayerScene } from '../src/renderer/canvas/layer-scene';

afterEach(() => vi.unstubAllGlobals());
describe('scene ownership across document edits', () => {
  it('keeps illustration objects for unrelated edits, then rebuilds changed layers and releases old objects', () => {
    vi.stubGlobal('window', { devicePixelRatio: 1 });
    vi.stubGlobal(
      'requestAnimationFrame',
      vi.fn(() => 1),
    );
    vi.stubGlobal('cancelAnimationFrame', vi.fn());
    const p = createProject(),
      id = crypto.randomUUID();
    p.layers[id] = {
      id,
      name: '分组',
      kind: 'group',
      childrenBottomToTop: [],
      isolation: 'pass-through',
      transform: identityTransform(),
      opacity: 1,
      enabled: true,
      locked: false,
      initialReveal: 1,
      blendMode: 'normal',
    };
    p.rootLayersBottomToTop = [id];
    const h = new EditHistory(p);
    const scene = new LayerScene(
      'test',
      new Viewport(),
      4096,
      () => {},
      () => {},
    );
    scene.setProject(p);
    const original = scene.root.children[0];
    h.execute({ type: 'rename', name: '改名' });
    scene.setProject(h.current);
    expect(scene.root.children[0]).toBe(original);
    h.execute({
      type: 'put-camera-key',
      key: {
        id: crypto.randomUUID(),
        at: { basis: 'time', timeUs: 0 },
        position: { x: 3000, y: 3000 },
        zoom: 2,
        rotationRad: 0,
        easingToNext: 'linear',
      },
    });
    scene.setProject(h.current);
    expect(scene.root.children[0]).toBe(original);
    expect(original.destroyed).toBe(false);
    h.execute({ type: 'set-layer', id, patch: { enabled: false } });
    scene.setProject(h.current);
    expect(original.destroyed).toBe(true);
    expect(scene.root.children[0].visible).toBe(false);
    h.undo();
    scene.setProject(h.current);
    expect(scene.root.children[0].visible).toBe(true);
    const last = scene.root.children[0];
    scene.dispose();
    expect(last.destroyed).toBe(true);
  });
});
