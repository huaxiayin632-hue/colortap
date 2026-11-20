import { afterEach, expect, it, vi } from 'vitest';
import { RenderRequest } from '../src/core/render-request';

afterEach(() => vi.unstubAllGlobals());
it('coalesces changes, sleeps when idle, handles a change during rendering and cancels on disposal', () => {
  const callbacks = new Map<number, FrameRequestCallback>();
  let id = 0;
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    callbacks.set(++id, callback);
    return id;
  });
  vi.stubGlobal('cancelAnimationFrame', (id: number) => callbacks.delete(id));
  const flush = () => {
    const pending = [...callbacks.values()];
    callbacks.clear();
    pending.forEach((callback) => callback(100));
  };
  const render = vi.fn();
  const request = new RenderRequest(render);
  request.request();
  request.request();
  request.request();
  expect(callbacks.size).toBe(1);
  flush();
  expect(render).toHaveBeenCalledTimes(1);
  expect(callbacks.size).toBe(0);
  render.mockImplementationOnce(() => request.request());
  request.request();
  flush();
  expect(callbacks.size).toBe(1);
  flush();
  expect(render).toHaveBeenCalledTimes(3);
  request.request();
  request.dispose();
  request.request();
  flush();
  expect(render).toHaveBeenCalledTimes(3);
  expect(callbacks.size).toBe(0);
});
