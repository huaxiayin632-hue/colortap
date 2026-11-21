import { afterEach, describe, expect, it, vi } from 'vitest';
import { createEditor } from '../src/renderer/state/editor';
import { AudioTransport } from '../src/renderer/audio/transport';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
function setup() {
  vi.stubGlobal('cancelAnimationFrame', vi.fn());
  let ready!: () => void;
  const preparation = new Promise<void>((resolve) => {
    ready = resolve;
  });
  const editor = createEditor();
  vi.spyOn(editor.sounds, 'prepare').mockReturnValue(preparation);
  const start = vi.spyOn(AudioTransport.prototype, 'play').mockResolvedValue();
  return { editor, ready, start };
}
describe('asynchronous sound preparation belongs to the latest play request', () => {
  it.each(['pause', 'seek', 'rate', 'loop'] as const)(
    'does not start old playback after %s during preparation',
    async (action) => {
      const { editor, ready, start } = setup();
      const pending = editor.togglePlay();
      if (action === 'pause') editor.pause();
      else if (action === 'seek') editor.seek(250000);
      else if (action === 'rate') editor.setRate(0.5);
      else editor.setLoop(null);
      ready();
      await pending;
      expect(start).not.toHaveBeenCalled();
      await editor.dispose();
    },
  );
  it('starts once for repeated play requests', async () => {
    const { editor, ready, start } = setup();
    const a = editor.togglePlay(),
      b = editor.togglePlay();
    ready();
    await Promise.all([a, b]);
    expect(start).toHaveBeenCalledTimes(1);
    await editor.dispose();
  });
  it('does not start pending playback after disposal', async () => {
    const { editor, ready, start } = setup();
    const pending = editor.togglePlay();
    await editor.dispose();
    ready();
    await pending;
    expect(start).not.toHaveBeenCalled();
  });
});
