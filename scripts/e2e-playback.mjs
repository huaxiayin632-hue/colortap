import { _electron as electron } from 'playwright';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const directory = path.join(root, 'test-results', 'playback');
await fs.mkdir(directory, { recursive: true });
const original =
  process.env.RHYTHM_TEST_PROJECT ??
  'C:/Users/00/Desktop/音游编辑器/示例工程/第五阶段/音效与镜头联动.rcproj';
const projectFile = path.join(directory, '变速与循环验收.rcproj');
await fs.cp(path.join(path.dirname(original), 'assets'), path.join(directory, 'assets'), {
  recursive: true,
});
const baseline = JSON.parse(await fs.readFile(original, 'utf8'));
await fs.writeFile(projectFile, JSON.stringify(baseline));
const profile = path.join(directory, `profile-${Date.now()}`);
const env = { ...process.env, RHYTHM_USER_DATA: profile };
delete env.ELECTRON_RUN_AS_NODE;
delete env.ELECTRON_RENDERER_URL;
const report = {
  startedAt: new Date().toISOString(),
  checks: [],
  errors: [],
  audioPhases: [],
  limitations: [
    'Native Electron/Web Audio output is captured to MediaRecorder before the physical speakers. File-picker replies are substituted; no hardware latency or listening-device calibration is claimed.',
  ],
};
let app,
  page,
  recording = false;
let capture, audioStartedWall;
const videoFrames = [],
  videoWrites = [];
const frameFolder = path.join(directory, `frames-${Date.now()}`);
async function captureStart() {
  await fs.mkdir(frameFolder);
  capture = await app.context().newCDPSession(page);
  capture.on('Page.screencastFrame', (event) => {
    const file = `frame-${String(videoFrames.length).padStart(6, '0')}.jpg`;
    videoFrames.push({ file, time: event.metadata.timestamp });
    videoWrites.push(fs.writeFile(path.join(frameFolder, file), Buffer.from(event.data, 'base64')));
    void capture?.send('Page.screencastFrameAck', { sessionId: event.sessionId }).catch(() => {});
  });
  await capture.send('Page.startScreencast', {
    format: 'jpeg',
    quality: 82,
    maxWidth: 1440,
    maxHeight: 960,
    everyNthFrame: 2,
  });
}
const button = (name) => page.getByRole('button', { name, exact: true });
const head = () => page.getByTestId('playhead').getAttribute('data-time-us').then(Number);
const cycle = () => page.getByTestId('practice-state').getAttribute('data-cycle').then(Number);
const rate = (value) => page.getByLabel('播放倍率', { exact: true }).selectOption(String(value));
async function check(name, action) {
  try {
    const evidence = await action();
    report.checks.push({ name, passed: true, evidence });
    console.log('PASS ' + name);
  } catch (e) {
    report.checks.push({ name, passed: false, error: String(e) });
    throw e;
  } finally {
    await fs.writeFile(path.join(directory, 'report.json'), JSON.stringify(report, null, 2));
  }
}
async function ready() {
  await page.locator('.editor-shell[aria-busy=false]').waitFor();
  await page.waitForFunction(
    () => document.querySelector('[data-testid=canvas-host]')?.dataset.loading === '0',
  );
}
async function choose(file, save = false) {
  await app.evaluate(
    ({ dialog }, { file, save }) => {
      if (save) dialog.showSaveDialog = async () => ({ canceled: false, filePath: file });
      else dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] });
    },
    { file, save },
  );
}
async function open(file = projectFile) {
  await choose(file);
  await button('打开').click();
  await ready();
  await page.locator('[data-testid=waveform][data-ready=true]').waitFor();
}
async function pause() {
  if (await button('暂停').count()) await button('暂停').click();
  await page.waitForTimeout(100);
}
async function seek(seconds) {
  const input = page.getByLabel('定位到秒', { exact: true });
  await input.fill(String(seconds));
  await input.press('Tab');
  await page.waitForTimeout(80);
}
async function zoom(value) {
  await page.getByLabel('时间轴缩放', { exact: true }).evaluate((el, v) => {
    el.value = String(v);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  }, value);
  await page.getByTestId('timeline-scroll').evaluate((el) => {
    el.scrollLeft = 0;
    el.scrollTop = 0;
  });
}
async function loop(a, b, alt = false) {
  const box = await page.getByTestId('timeline-scroll').boundingBox();
  const pps = Number(await page.getByTestId('timeline-scroll').getAttribute('data-zoom'));
  const lane = await page.getByTestId('loop-lane').boundingBox();
  if (alt) await page.keyboard.down('Alt');
  await page.mouse.move(box.x + a * pps, lane.y + 12);
  await page.mouse.down();
  await page.mouse.move(box.x + b * pps, lane.y + 12, { steps: 8 });
  await page.mouse.up();
  if (alt) await page.keyboard.up('Alt');
  await page.waitForTimeout(80);
}
const range = () =>
  page
    .locator('.loop-range')
    .evaluate((el) => ({ a: Number(el.dataset.startUs), b: Number(el.dataset.endUs) }));
const native = () =>
  page.evaluate(() => ({
    now: window.__audio.context.currentTime,
    latency: window.__audio.context.outputLatency,
    starts: window.__audio.starts.map(({ source, ...entry }) => ({
      ...entry,
      currentRate: source.playbackRate.value,
    })),
  }));
function observeAudio() {
  const Base = AudioContext,
    connect = AudioNode.prototype.connect;
  const state = (window.__audio = {
    context: null,
    mix: null,
    starts: [],
    roots: [],
    recorder: null,
    chunks: [],
  });
  AudioNode.prototype.connect = function (destination, ...args) {
    const result = connect.call(this, destination, ...args);
    if (destination === this.context.destination && state.mix) {
      connect.call(this, state.mix);
      const analyser = this.context.createAnalyser();
      analyser.fftSize = 8192;
      analyser.smoothingTimeConstant = 0;
      connect.call(this, analyser);
      state.roots.push(analyser);
    }
    return result;
  };
  window.AudioContext = class extends Base {
    constructor(...args) {
      super(...args);
      state.context = this;
      state.mix = this.createMediaStreamDestination();
    }
    createBufferSource() {
      const source = super.createBufferSource(),
        start = source.start.bind(source),
        stop = source.stop.bind(source);
      let entry;
      source.start = function (when = 0, offset = 0, ...args) {
        entry = {
          source,
          when,
          offset,
          duration: source.buffer.duration,
          rate: source.playbackRate.value,
          loop: source.loop,
          a: source.loopStart,
          b: source.loopEnd,
          stops: [],
        };
        state.starts.push(entry);
        return start(when, offset, ...args);
      };
      source.stop = function (...args) {
        entry?.stops.push(args[0] ?? state.context.currentTime);
        return stop(...args);
      };
      return source;
    }
  };
  window.__record = () => {
    state.chunks = [];
    state.recorder = new MediaRecorder(state.mix.stream, {
      mimeType: MediaRecorder.isTypeSupported('audio/webm;codecs=pcm')
        ? 'audio/webm;codecs=pcm'
        : 'audio/webm;codecs=opus',
      audioBitsPerSecond: 192000,
    });
    state.recorder.ondataavailable = (e) => state.chunks.push(e.data);
    state.started = performance.now();
    state.startedWall = Date.now() / 1000;
    state.recorder.start(200);
  };
  window.__finish = () =>
    new Promise((resolve) => {
      state.recorder.onstop = async () => {
        const data = new Uint8Array(await new Blob(state.chunks).arrayBuffer());
        let text = '';
        for (let i = 0; i < data.length; i += 8192)
          text += String.fromCharCode(...data.subarray(i, i + 8192));
        resolve(btoa(text));
      };
      state.recorder.stop();
    });
  window.__spectrum = () => {
    const analyser = state.roots[0],
      bins = new Float32Array(analyser.frequencyBinCount);
    analyser.getFloatFrequencyData(bins);
    let peak = 1;
    for (let i = 2; i < bins.length; i++) if (bins[i] > bins[peak]) peak = i;
    return { hz: (peak * state.context.sampleRate) / analyser.fftSize, db: bins[peak] };
  };
}
async function phase(name) {
  report.audioPhases.push({
    name,
    seconds: await page.evaluate(() => (performance.now() - window.__audio.started) / 1000),
  });
}
async function recordStop() {
  if (!recording) return;
  recording = false;
  await capture?.send('Page.stopScreencast');
  const data = await page.evaluate(() => window.__finish());
  await fs.writeFile(path.join(directory, '变速与循环-实际混音.webm'), Buffer.from(data, 'base64'));
  execFileSync(
    'ffmpeg',
    [
      '-y',
      '-v',
      'error',
      '-i',
      path.join(directory, '变速与循环-实际混音.webm'),
      '-af',
      'aresample=async=1:first_pts=0',
      '-c:a',
      'pcm_s16le',
      path.join(directory, '变速与循环-实际混音.wav'),
    ],
    { windowsHide: true },
  );
  await Promise.all(videoWrites);
  if (videoFrames.length) {
    const lines = ['ffconcat version 1.0'];
    const gap = Math.max(0, videoFrames[0].time - audioStartedWall);
    if (gap > 0) lines.push(`file '${videoFrames[0].file}'`, `duration ${gap}`);
    for (let i = 0; i < videoFrames.length; i++)
      lines.push(
        `file '${videoFrames[i].file}'`,
        `duration ${Math.max(0.01, (videoFrames[i + 1]?.time ?? videoFrames[i].time + 0.1) - videoFrames[i].time)}`,
      );
    lines.push(`file '${videoFrames.at(-1).file}'`);
    await fs.writeFile(path.join(frameFolder, 'frames.txt'), lines.join('\n'));
    execFileSync(
      'ffmpeg',
      [
        '-y',
        '-v',
        'error',
        '-f',
        'concat',
        '-safe',
        '1',
        '-i',
        path.join(frameFolder, 'frames.txt'),
        '-i',
        path.join(directory, '变速与循环-实际混音.wav'),
        '-vf',
        'scale=1440:960:force_original_aspect_ratio=decrease,pad=1440:960:(ow-iw)/2:(oh-ih)/2',
        '-r',
        '30',
        '-c:v',
        'libx264',
        '-crf',
        '22',
        '-pix_fmt',
        'yuv420p',
        '-c:a',
        'aac',
        '-b:a',
        '192k',
        '-shortest',
        '-movflags',
        '+faststart',
        path.join(directory, '变速与循环-有声验收.mp4'),
      ],
      { windowsHide: true },
    );
    if (path.dirname(frameFolder) === directory && path.basename(frameFolder).startsWith('frames-'))
      await fs.rm(frameFolder, { recursive: true });
  }
}
async function screen(q, p) {
  const host = await page
    .getByTestId('canvas-host')
    .evaluate((el) => ({ z: +el.dataset.zoom, x: +el.dataset.panX, y: +el.dataset.panY }));
  const box = await page.getByTestId('pixi-canvas').boundingBox(),
    r = p.stage.playfieldRect;
  const w = Math.min(p.stage.artworkSize.width, r.x + r.width) - Math.max(0, r.x);
  const h = Math.min(p.stage.artworkSize.height, r.y + r.height) - Math.max(0, r.y);
  const scale = Math.min(w / p.stage.chartSize.width, h / p.stage.chartSize.height);
  return {
    x:
      box.x +
      host.x +
      (Math.max(0, r.x) + (w - p.stage.chartSize.width * scale) / 2 + q.x * scale) * host.z,
    y:
      box.y +
      host.y +
      (Math.max(0, r.y) + (h - p.stage.chartSize.height * scale) / 2 + q.y * scale) * host.z,
  };
}
try {
  app = await electron.launch({ args: [root], cwd: root, env });
  page = await app.firstWindow();
  page.setDefaultTimeout(30000);
  page.on('pageerror', (e) => report.errors.push(String(e)));
  await page.addInitScript(observeAudio);
  await page.reload();
  await page.getByTestId('pixi-canvas').waitFor();
  await ready();
  await open();
  await zoom(100);
  await check('真实 PSD、WAV/MP3/OGG 和现有短谱面正常打开', async () => {
    assert.equal(await page.locator('.save-state').innerText(), '已保存');
    return {
      layers: Object.keys(baseline.layers).length,
      notes: Object.keys(baseline.notes).length,
      audio: Object.values(baseline.assets)
        .filter((a) => a.kind === 'audio')
        .map((a) => a.originalName),
    };
  });
  await button('预览').click();
  await page.evaluate(() => window.__record());
  audioStartedWall = await page.evaluate(() => window.__audio.startedWall);
  recording = true;
  await captureStart();
  await check(
    '四档速度共用原曲时间、原生音源倍率与音效倍率；输出有声且音高随倍率变化',
    async () => {
      const evidence = [];
      for (const value of [1, 0.75, 0.5, 0.25]) {
        await pause();
        await seek(1);
        await rate(value);
        await phase(value + '×');
        await button('播放').click();
        await page.waitForTimeout(300);
        const a = { t: await head(), c: (await native()).now };
        await page.waitForTimeout(2200);
        const b = { t: await head(), c: (await native()).now };
        const measured = (b.t - a.t) / 1e6 / (b.c - a.c);
        assert.ok(Math.abs(measured - value) < 0.04, `rate ${value}: ${measured}`);
        const n = await native(),
          music = n.starts.filter((v) => v.duration > 10).at(-1);
        assert.equal(music.currentRate, value);
        const fx = n.starts.filter((v) => v.when >= music.when && v.duration < 2);
        assert.ok(fx.length > 0);
        assert.ok(fx.every((v) => v.rate === value));
        const spectrum = await page.evaluate(() => window.__spectrum());
        assert.ok(spectrum.db > -70);
        evidence.push({ rate: value, measured, spectrum, effects: fx.length });
        await pause();
      }
      const hz = evidence[0].spectrum.hz;
      assert.ok(
        evidence.every((v) => Math.abs(v.spectrum.hz / hz - v.rate) < 0.04),
        JSON.stringify(evidence),
      );
      return evidence;
    },
  );
  await check('反向拖选、吸附与端点调整；区间未启用时不重启音乐', async () => {
    await rate(1);
    await seek(0);
    await button('播放').click();
    const before = (await native()).starts.filter((v) => v.duration > 10).length;
    await loop(4, 1);
    assert.deepEqual(await range(), { a: 1e6, b: 4e6 });
    assert.equal((await native()).starts.filter((v) => v.duration > 10).length, before);
    await pause();
    const b = await page.getByLabel('调整循环终点', { exact: true }).boundingBox();
    await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
    await page.mouse.down();
    await page.mouse.move(b.x + b.width / 2 - 100, b.y + b.height / 2, { steps: 6 });
    await page.mouse.up();
    assert.deepEqual(await range(), { a: 1e6, b: 3e6 });
    await page.screenshot({ path: path.join(directory, '循环区间.png') });
  });
  await check('原生音频循环和播放中变速；UI阻塞后没有漂移或补播旧轮', async () => {
    await seek(0);
    await button('循环播放').click();
    assert.equal(await head(), 1e6);
    await rate(0.5);
    await phase('0.5× 循环 1–3 秒');
    await button('播放').click();
    const a = await native(),
      music = a.starts.filter((v) => v.duration > 10).at(-1);
    assert.equal(music.loop, true);
    assert.equal(music.a, 1);
    assert.equal(music.b, 3);
    const first = await cycle();
    await page.waitForTimeout(8500);
    assert.ok((await cycle()) >= first + 2);
    const before = (await native()).starts.filter((v) => v.duration > 10).length;
    await rate(0.75);
    await phase('播放中改 0.75×，循环继续');
    await page.waitForTimeout(4000);
    assert.equal((await native()).starts.filter((v) => v.duration > 10).length, before);
    await page.evaluate(() => {
      const end = performance.now() + 700;
      while (performance.now() < end) {}
    });
    const now = await head();
    assert.ok(now >= 1e6 && now < 3e6);
    await pause();
    const frozen = await head();
    await page.waitForTimeout(250);
    assert.equal(await head(), frozen);
    return { cycle: await cycle(), latencySeconds: (await native()).latency };
  });
  await recordStop();
  await check('区间外定位暂停循环；重新启用回A；清除恢复整曲；最短区间', async () => {
    await seek(5);
    assert.equal(await head(), 5e6);
    assert.equal(await button('循环播放').getAttribute('aria-pressed'), 'false');
    assert.match(await button('循环播放').innerText(), /暂停/);
    await button('循环播放').click();
    assert.equal(await head(), 1e6);
    await button('清除循环').click();
    assert.equal(await page.locator('.loop-range').count(), 0);
    await loop(2, 2.03, true);
    assert.equal(await page.locator('.loop-range').count(), 0);
    await loop(1, 1.125, true);
    const r = await range();
    assert.ok(r.b - r.a >= 100000 && r.b - r.a <= 130000);
    await button('循环播放').click();
    await rate(1);
    await button('播放').click();
    const start = await cycle();
    await page.waitForTimeout(1700);
    assert.ok((await cycle()) >= start + 10);
    await pause();
    await button('清除循环').click();
  });
  const practice = structuredClone(baseline);
  practice.camera.enabled = false;
  const firstCircle = Object.values(practice.notes).find(
    (n) => n.kind === 'circle' && n.at.tick === 2880,
  );
  const practiceFile = path.join(directory, '试玩循环验收.rcproj');
  await fs.writeFile(practiceFile, JSON.stringify(practice));
  await open(practiceFile);
  await zoom(100);
  await check('普通暂停、倍率调整保留命中；循环清除旧轮命中和按住状态', async () => {
    await button('试玩').click();
    await seek(1);
    await loop(1, 3);
    await button('循环播放').click();
    await rate(0.5);
    const q = await screen(firstCircle.position, practice);
    await page.mouse.move(q.x, q.y);
    await button('播放').click();
    await page.mouse.move(q.x, q.y);
    await page.waitForFunction(
      () => +document.querySelector('[data-testid=playhead]').dataset.timeUs >= 1480000,
    );
    await page.keyboard.down('z');
    const result = page.locator(`.result-item[data-note-id="${firstCircle.id}"]`);
    await page.waitForFunction(
      (id) =>
        ['perfect', 'good'].includes(
          document.querySelector(`.result-item[data-note-id="${id}"]`)?.dataset.result,
        ),
      firstCircle.id,
    );
    await pause();
    const run = await page.locator('.playtest-results').getAttribute('data-run-id');
    await rate(0.25);
    assert.equal(await page.locator('.playtest-results').getAttribute('data-run-id'), run);
    assert.ok(['perfect', 'good'].includes(await result.getAttribute('data-result')));
    await rate(1);
    await button('播放').click();
    await page.waitForFunction(
      (run) => document.querySelector('.playtest-results').dataset.runId !== run,
      run,
    );
    await page.waitForFunction(
      () => +document.querySelector('[data-testid=playhead]').dataset.timeUs >= 1650000,
    );
    assert.equal(await result.getAttribute('data-result'), 'miss');
    await page.keyboard.up('z');
    await pause();
    return {
      previousRun: run,
      nextRun: await page.locator('.playtest-results').getAttribute('data-run-id'),
    };
  });
  await check('跨A Slider不继承追踪；曲尾循环及关闭后的整曲结束正确', async () => {
    await button('清除循环').click();
    await zoom(60);
    await seek(6);
    await loop(6, 8);
    await button('循环播放').click();
    const slider = Object.values(practice.notes).find((n) => n.kind === 'slider');
    await seek(6);
    assert.equal(
      await page.locator(`.result-item[data-note-id="${slider.id}"]`).getAttribute('data-result'),
      'skipped',
    );
    await button('清除循环').click();
    await zoom(20);
    await loop(17.5, 18);
    await button('循环播放').click();
    await button('播放').click();
    const first = await cycle();
    await page.waitForTimeout(1200);
    assert.ok((await cycle()) >= first + 2);
    await pause();
    await button('清除循环').click();
    await seek(17.8);
    await button('播放').click();
    await button('播放').waitFor();
    assert.equal(await head(), 18e6);
    await zoom(100);
  });
  await check('输入框与弹窗隔离；最小窗口与折叠可恢复；操作不标脏且暂停按需渲染', async () => {
    await button('编辑').click();
    const input = page.getByLabel('定位到秒', { exact: true });
    await input.focus();
    const before = await head();
    await input.press('ArrowLeft');
    assert.equal(await head(), before);
    await button('快捷键一览').click();
    await page.keyboard.press('Space');
    assert.equal(await button('暂停').count(), 0);
    await page.keyboard.press('Escape');
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1080, 720));
    for (const locator of [
      button('循环播放'),
      page.getByLabel('播放倍率', { exact: true }),
      button('清除循环'),
    ]) {
      const box = await locator.boundingBox();
      assert.ok(box.x >= 0 && box.x + box.width <= 1080);
    }
    await button('收起时间轴').click();
    await button('展开时间轴').click();
    await page.screenshot({ path: path.join(directory, '最小窗口.png') });
    assert.equal(await page.locator('.save-state').innerText(), '已保存');
    await page.waitForTimeout(500);
    const count = await page.getByTestId('canvas-host').getAttribute('data-render-count');
    await page.waitForTimeout(500);
    assert.equal(await page.getByTestId('canvas-host').getAttribute('data-render-count'), count);
  });
  await check('保存重开不含练习参数；换工程及音乐重置1×和循环；布局保留', async () => {
    await rate(0.25);
    const layout = await page.evaluate(() => localStorage.getItem('rhythm-canvas.workspace.v1'));
    await choose(practiceFile, true);
    await button('保存').click();
    await ready();
    const saved = JSON.parse(await fs.readFile(practiceFile, 'utf8'));
    for (const key of ['notes', 'timing', 'layers', 'reveals', 'sounds', 'camera'])
      assert.deepEqual(saved[key], practice[key]);
    assert.equal(saved.playbackRate, undefined);
    assert.equal(saved.loopRange, undefined);
    await open();
    assert.equal(await page.getByLabel('播放倍率', { exact: true }).inputValue(), '1');
    assert.equal(await page.locator('.loop-range').count(), 0);
    assert.equal(
      await page.evaluate(() => localStorage.getItem('rhythm-canvas.workspace.v1')),
      layout,
    );
    await loop(1, 2);
    await button('循环播放').click();
    await rate(0.25);
    const music = baseline.assets[baseline.music.assetId];
    await choose(path.join(directory, music.relativePath));
    await button('导入音乐').first().click();
    await ready();
    assert.equal(await page.getByLabel('播放倍率', { exact: true }).inputValue(), '1');
    assert.equal(await page.locator('.loop-range').count(), 0);
  });
  assert.deepEqual(report.errors, []);
  report.passed = true;
} catch (e) {
  report.passed = false;
  report.error = e.stack ?? String(e);
  process.exitCode = 1;
  console.error(report.error);
  await page?.screenshot({ path: path.join(directory, 'failure.png') }).catch(() => {});
} finally {
  await recordStop().catch((e) => {
    report.recordingError = String(e);
  });
  if (app) {
    await app.evaluate(({ app }) => app.exit(0)).catch(() => {});
    await app.close().catch(() => {});
  }
  report.finishedAt = new Date().toISOString();
  await fs.writeFile(path.join(directory, 'report.json'), JSON.stringify(report, null, 2));
}
