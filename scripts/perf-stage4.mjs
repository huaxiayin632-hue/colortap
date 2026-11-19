// Headful Windows performance validation. Only native file-picker answers are substituted.
// Audio, input, PSD decoding, project persistence and WebGL rendering remain real.
import { _electron as electron } from 'playwright';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { largeFixture } from './image-fixtures.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const option = (name, fallback) =>
  process.argv.find((a) => a.startsWith(`--${name}=`))?.split('=')[1] ?? fallback;
const seconds = Number(option('seconds', '20'));
const repetitions = Number(option('runs', '2'));
const lifecycleCycles = Number(option('cycles', '12'));
const counts = option('counts', '0,1,4,8,16').split(',').map(Number);
const pilot = process.argv.includes('--pilot');
const production = process.argv.includes('--production');
const lifecycleOnly = process.argv.includes('--lifecycle-only');
const postOnly = process.argv.includes('--post-only');
const runName = option('name', new Date().toISOString().replace(/[:.]/g, '-'));
assert(/^[\w.-]+$/.test(runName));
assert(seconds > 0 && seconds <= 30 && repetitions > 0 && repetitions <= 5);
assert(Number.isInteger(lifecycleCycles) && lifecycleCycles >= 12 && lifecycleCycles <= 120);
assert(counts.every((n) => [0, 1, 4, 8, 16].includes(n)));
const directory = path.join(
  root,
  'test-results',
  production ? 'stage5-performance' : 'stage4-performance',
  runName,
);
const profile = path.join(directory, `profile-${Date.now()}`);
await fs.mkdir(directory, { recursive: true });
const report = {
  startedAt: new Date().toISOString(),
  stage: production ? 5 : 4,
  protocol: {
    seconds,
    repetitions,
    lifecycleCycles,
    counts,
    pilot,
    production,
    lifecycleOnly,
    postOnly,
    backgroundApps: 'No unrelated processes are terminated.',
  },
  machine: {
    platform: os.platform(),
    release: os.release(),
    cpu: os.cpus()[0]?.model,
    logicalCPUs: os.cpus().length,
    ramBytes: os.totalmem(),
  },
  materials: [],
  cases: [],
  gameplay: [],
  lifecycle: [],
  errors: [],
  checks: [],
  limitations: [
    'The 6000x6000 PSD is generated: one full-size background, 99 trimmed shapes, ten groups including nesting. It is not a Photoshop-authored production illustration or 100 full-size layers.',
    'The real illustration is tested separately at its native dimensions and layer count.',
    'Each outline is an independent closed 12-node cubic curve with white core, three glow bands, two endpoint lights. No full-size bitmap masks.',
    'Frame samples are isolated foreground rAF intervals; managed image bytes exclude driver, vector buffers, framebuffer pools and other applications.',
    'Clock comparisons use actual AudioContext output timestamps and actual rendered DOM updates; physical speaker-to-screen latency needs external measurement.',
    'Finite lifecycle cycles can detect retained growth in this workload, not prove the absence of every possible leak.',
  ],
};
const env = { ...process.env, RHYTHM_USER_DATA: profile };
delete env.ELECTRON_RUN_AS_NODE;
delete env.ELECTRON_RENDERER_URL;
let app, page, cdp;
const id = () => crypto.randomUUID();
const identity = () => ({
  position: { x: 0, y: 0 },
  scale: { x: 1, y: 1 },
  rotationRad: 0,
  skewRad: { x: 0, y: 0 },
  pivot: { x: 0, y: 0 },
});
const moment = (s) => ({ basis: 'time', timeUs: Math.round(s * 1e6) });
const span = (s) => ({ basis: 'time', durationUs: Math.round(s * 1e6) });
async function persist() {
  await fs.writeFile(path.join(directory, 'report.json'), JSON.stringify(report, null, 2));
}
async function check(name, fn) {
  const started = performance.now();
  try {
    const result = await fn();
    report.checks.push({ name, passed: true, elapsedMs: Math.round(performance.now() - started) });
    console.log(`PASS ${name}`);
    await persist();
    return result;
  } catch (error) {
    report.checks.push({ name, passed: false, error: String(error) });
    throw error;
  }
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
async function foreground() {
  await app.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0];
    if (window.isMinimized()) window.restore();
    if (!window.isVisible()) window.show();
    window.focus();
  });
  await page.bringToFront();
}
async function frames() {
  await page.evaluate(
    () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
  );
}
async function settled() {
  await page.locator('.editor-shell[aria-busy=false]').waitFor();
}
async function textures() {
  await page.waitForFunction(
    () =>
      Number(document.querySelector('[data-testid=canvas-host]')?.getAttribute('data-loading')) ===
      0,
  );
  await frames();
}
async function open(file) {
  await foreground();
  await choose(file);
  await page.getByRole('button', { name: '打开', exact: true }).click();
  const dirty = page.getByRole('dialog', { name: '未保存的修改', exact: true });
  if (await dirty.count())
    await page.getByRole('button', { name: '放弃修改', exact: true }).click();
  await settled();
  await textures();
  await page.locator('[data-testid=waveform][data-ready=true]').waitFor();
}
async function save(file) {
  await choose(file, true);
  await page.getByRole('button', { name: '保存', exact: true }).click();
  await settled();
  await page.waitForFunction(
    () => document.querySelector('.save-state')?.textContent?.trim() === '已保存',
  );
  return JSON.parse(await fs.readFile(file, 'utf8'));
}
async function jump(s) {
  const input = page.getByLabel('定位到秒', { exact: true });
  // Focusing this field deliberately pauses music. Let the authoritative value settle
  // before typing, just as it does between a person's click and keystrokes.
  await input.focus();
  await frames();
  await input.fill(String(s));
  await input.press('Tab');
  await textures();
}
async function pause() {
  const button = page.getByRole('button', { name: '暂停', exact: true });
  if ((await button.count()) && (await button.isEnabled())) await button.click();
  await frames();
}
async function metrics(label) {
  const file = path.join(directory, `${label}-metrics.json`);
  await choose(file, true);
  await page.getByRole('button', { name: '查看运行记录', exact: true }).click();
  await page.getByRole('button', { name: '保存性能记录', exact: true }).click();
  await settled();
  await page.getByRole('button', { name: '关闭运行记录', exact: true }).click();
  return JSON.parse(await fs.readFile(file, 'utf8'));
}
// Observers delegate to native APIs. Weak bookkeeping never retains GL objects or old sources.
function installObservers() {
  const stats = { live: {}, created: {}, deleted: {}, finalized: {}, peaks: {}, contexts: 0 };
  const names = [
    'Buffer',
    'Texture',
    'Framebuffer',
    'Renderbuffer',
    'VertexArray',
    'Program',
    'Shader',
  ];
  for (const n of names)
    for (const f of ['live', 'created', 'deleted', 'finalized', 'peaks']) stats[f][n] = 0;
  const owned = new WeakMap();
  const registry = new FinalizationRegistry((token) => {
    if (!token.deleted) {
      stats.live[token.name]--;
      stats.finalized[token.name]++;
      token.deleted = true;
    }
  });
  for (const proto of [WebGLRenderingContext.prototype, WebGL2RenderingContext.prototype]) {
    for (const name of names) {
      const make = proto[`create${name}`],
        remove = proto[`delete${name}`];
      if (!make || !remove || !Object.hasOwn(proto, `create${name}`)) continue;
      proto[`create${name}`] = function (...args) {
        const object = make.apply(this, args);
        if (object) {
          const token = { name, deleted: false };
          owned.set(object, token);
          registry.register(object, token);
          stats.created[name]++;
          stats.live[name]++;
          stats.peaks[name] = Math.max(stats.peaks[name], stats.live[name]);
        }
        return object;
      };
      proto[`delete${name}`] = function (object) {
        const token = object && owned.get(object);
        if (token && !token.deleted) {
          token.deleted = true;
          stats.deleted[name]++;
          stats.live[name]--;
        }
        return remove.call(this, object);
      };
    }
  }
  window.__perfGL = stats;
  const Base = window.AudioContext;
  window.__perfAudio = {
    context: null,
    anchor: null,
    analyser: null,
    starts: 0,
    inputs: [],
    active: 0,
    sfxStarts: 0,
  };
  window.AudioContext = class extends Base {
    constructor(...args) {
      super(...args);
      window.__perfAudio.context = this;
    }
    createGain() {
      const gain = super.createGain(),
        connect = gain.connect.bind(gain),
        context = this;
      gain.connect = function (destination, ...args) {
        const result = connect(destination, ...args);
        if (destination === context.destination && !window.__perfAudio.analyser) {
          const analyser = context.createAnalyser();
          analyser.fftSize = 1024;
          connect(analyser);
          window.__perfAudio.analyser = analyser;
        }
        return result;
      };
      return gain;
    }
    createBufferSource() {
      const source = super.createBufferSource(),
        start = source.start.bind(source);
      source.start = (when = 0, offset = 0, ...args) => {
        if (source.buffer?.duration > 10) window.__perfAudio.anchor = { when, offset };
        else window.__perfAudio.sfxStarts++;
        window.__perfAudio.starts++;
        window.__perfAudio.active++;
        source.addEventListener('ended', () => window.__perfAudio.active--, { once: true });
        return start(when, offset, ...args);
      };
      return source;
    }
  };
  window.__perfAudioNow = () => {
    const { context: c, anchor: a } = window.__perfAudio;
    if (!c || !a) return null;
    const t = c.getOutputTimestamp();
    const s =
      t.performanceTime > 0
        ? Math.min(
            c.currentTime,
            t.contextTime + Math.max(0, performance.now() - t.performanceTime) / 1000,
          )
        : c.currentTime;
    return Math.round((a.offset + Math.max(0, s - a.when)) * 1e6);
  };
  addEventListener(
    'keydown',
    (e) => {
      if (e.code === 'KeyZ' || e.code === 'KeyX') {
        window.__perfAudio.inputs.push({
          code: e.code,
          audioUs: window.__perfAudioNow(),
          playheadUs: Number(document.querySelector('[data-testid=playhead]')?.dataset.timeUs),
        });
        if (window.__perfAudio.inputs.length > 100) window.__perfAudio.inputs.shift();
      }
    },
    true,
  );
  addEventListener(
    'pointerdown',
    (event) => {
      if (event.button === 0 && event.target?.getAttribute?.('data-testid') === 'pixi-canvas') {
        window.__perfAudio.inputs.push({
          code: 'Mouse0',
          audioUs: window.__perfAudioNow(),
          playheadUs: Number(document.querySelector('[data-testid=playhead]')?.dataset.timeUs),
        });
        if (window.__perfAudio.inputs.length > 100) window.__perfAudio.inputs.shift();
      }
    },
    true,
  );
  window.__startPerfSample = (durationMs) => {
    const d = {
      frames: [],
      updates: [],
      audioOffsetsMs: [],
      longTasks: [],
      audioRmsMax: 0,
      hidden: 0,
      backwards: 0,
      firstHeadUs: null,
      lastHeadUs: null,
      startedAt: performance.now(),
    };
    const samples = new Float32Array(1024);
    const obs = new PerformanceObserver((list) =>
      d.longTasks.push(
        ...list.getEntries().map((v) => ({ start: v.startTime, duration: v.duration })),
      ),
    );
    obs.observe({ type: 'longtask' });
    let last, lastUpdate, lastHead;
    window.__perfSamplePromise = new Promise((resolve) => {
      function frame(t) {
        if (last !== undefined) d.frames.push(t - last);
        last = t;
        const head = Number(document.querySelector('[data-testid=playhead]')?.dataset.timeUs);
        d.firstHeadUs ??= head;
        d.lastHeadUs = head;
        if (lastHead !== undefined && head < lastHead) d.backwards++;
        if (head !== lastHead) {
          if (lastUpdate !== undefined) d.updates.push(t - lastUpdate);
          lastUpdate = t;
          lastHead = head;
        }
        const expected = window.__perfAudioNow();
        if (expected !== null) d.audioOffsetsMs.push((expected - head) / 1000);
        if (document.hidden) d.hidden++;
        if (d.frames.length % 12 === 0 && window.__perfAudio.analyser) {
          window.__perfAudio.analyser.getFloatTimeDomainData(samples);
          d.audioRmsMax = Math.max(
            d.audioRmsMax,
            Math.sqrt(samples.reduce((a, b) => a + b * b, 0) / samples.length),
          );
        }
        if (t - d.startedAt >= durationMs) {
          obs.disconnect();
          d.elapsedMs = t - d.startedAt;
          resolve(d);
        } else requestAnimationFrame(frame);
      }
      requestAnimationFrame(frame);
    });
  };
}
function summarize(raw) {
  const stat = (values) => {
    const sorted = values.toSorted((a, b) => a - b);
    const mean = sorted.reduce((a, b) => a + b, 0) / sorted.length;
    return {
      samples: sorted.length,
      meanMs: mean,
      fps: 1000 / mean,
      p95Ms: sorted[Math.ceil(sorted.length * 0.95) - 1],
      p99Ms: sorted[Math.ceil(sorted.length * 0.99) - 1],
      maxMs: sorted.at(-1),
    };
  };
  const audioClockOffset = stat(raw.audioOffsetsMs);
  delete audioClockOffset.fps;
  return {
    elapsedMs: raw.elapsedMs,
    musicAdvanceMs: (raw.lastHeadUs - raw.firstHeadUs) / 1000,
    frames: {
      ...stat(raw.frames),
      over25ms: raw.frames.filter((v) => v > 25).length,
      over50ms: raw.frames.filter((v) => v > 50).length,
      over100ms: raw.frames.filter((v) => v > 100).length,
    },
    playheadUpdates: stat(raw.updates),
    audioClockOffset,
    longTasks: raw.longTasks,
    audioRmsMax: raw.audioRmsMax,
    hiddenFrames: raw.hidden,
    backwards: raw.backwards,
  };
}
async function sample(ms) {
  await foreground();
  await page.evaluate((duration) => window.__startPerfSample(duration), ms);
  const raw = await page.evaluate(() => window.__perfSamplePromise);
  assert.equal(raw.hidden, 0, 'Window must stay in foreground during measurement');
  assert(
    raw.lastHeadUs - raw.firstHeadUs > (raw.elapsedMs - 100) * 1000,
    'Music must keep playing throughout the sample',
  );
  return { raw, summary: summarize(raw) };
}
async function memory(gc = false) {
  if (gc) {
    await cdp.send('HeapProfiler.collectGarbage');
    await frames();
  }
  const processes = await page.evaluate(() => window.desktop.processSample());
  assert(processes.ok);
  const heap = await cdp.send('Runtime.getHeapUsage');
  const gl = await page.evaluate(() => structuredClone(window.__perfGL));
  return {
    at: new Date().toISOString(),
    processes: processes.value,
    privateMiB: processes.value.processes.reduce((a, b) => a + (b.privateKiB ?? 0), 0) / 1024,
    workingSetMiB: processes.value.processes.reduce((a, b) => a + b.workingSetKiB, 0) / 1024,
    heap,
    gl,
    forcedGC: gc,
  };
}
function wav(seconds = 60, frequency = 440) {
  const rate = 24000,
    frames = Math.round(rate * seconds),
    b = Buffer.alloc(44 + frames * 2);
  b.write('RIFF');
  b.writeUInt32LE(b.length - 8, 4);
  b.write('WAVEfmt ', 8);
  b.writeUInt32LE(16, 16);
  b.writeUInt16LE(1, 20);
  b.writeUInt16LE(1, 22);
  b.writeUInt32LE(rate, 24);
  b.writeUInt32LE(rate * 2, 28);
  b.writeUInt16LE(2, 32);
  b.writeUInt16LE(16, 34);
  b.write('data', 36);
  b.writeUInt32LE(frames * 2, 40);
  for (let i = 0; i < frames; i++) {
    const t = i / rate,
      age = t % 0.5;
    b.writeInt16LE(
      Math.round(
        (Math.sin(t * Math.PI * 2 * frequency) * 0.03 +
          Math.sin(age * Math.PI * 1760) * Math.exp(-age * 50) * 0.13) *
          32767,
      ),
      44 + i * 2,
    );
  }
  return b;
}
function curve(cx, cy, rx, ry) {
  const count = 12,
    h = (4 / 3) * Math.tan(Math.PI / (2 * count));
  return {
    id: id(),
    name: '性能验证 · 独立十二节点闭合曲线',
    closed: true,
    interpolation: 'bezier',
    defaultWidth: 12,
    nodes: Array.from({ length: count }, (_, i) => {
      const a = (i * 2 * Math.PI) / count;
      const tx = -rx * Math.sin(a) * h,
        ty = ry * Math.cos(a) * h;
      return {
        id: id(),
        point: { x: cx + rx * Math.cos(a), y: cy + ry * Math.sin(a) },
        handleIn: { x: -tx, y: -ty },
        handleOut: { x: tx, y: ty },
        mode: 'mirrored',
      };
    }),
  };
}
function workload(base, n, gameplay = false) {
  const p = structuredClone(base);
  p.id = id();
  p.name = `性能验证 ${n} 条发光曲线${gameplay ? ' · 真实试玩' : ''}`;
  p.notes = {};
  p.paths = {};
  p.reveals = {};
  p.sounds = {};
  for (const l of Object.values(p.layers)) l.initialReveal = 1;
  const circles = [3, 5, 7].map((s, i) => ({
    id: id(),
    kind: 'circle',
    at: moment(s),
    position: { x: 120 + i * 120, y: 90 },
    radius: 24,
  }));
  for (const c of circles) p.notes[c.id] = c;
  const sp = {
    id: id(),
    name: '试玩用弯曲 Slider',
    closed: false,
    interpolation: 'bezier',
    defaultWidth: 48,
    nodes: [
      {
        id: id(),
        point: { x: 100, y: 255 },
        handleIn: { x: 0, y: 0 },
        handleOut: { x: 60, y: -130 },
        mode: 'corner',
      },
      {
        id: id(),
        point: { x: 410, y: 250 },
        handleIn: { x: -60, y: 130 },
        handleOut: { x: 0, y: 0 },
        mode: 'corner',
      },
    ],
  };
  p.paths[sp.id] = sp;
  const slider = {
    id: id(),
    kind: 'slider',
    at: moment(9),
    duration: span(6),
    path: { pathId: sp.id, transform: identity() },
    headRadius: 24,
    followRadius: 48,
  };
  p.notes[slider.id] = slider;
  const targets = Object.values(p.layers)
    .filter((l) => l.kind === 'raster' && p.pixelSources[l.pixelSourceId].levels.length)
    .slice()
    .reverse()
    .slice(0, n);
  assert.equal(targets.length, n);
  targets.forEach((l, i) => {
    l.enabled = true;
    l.initialReveal = 0;
    const size = p.stage.artworkSize;
    const cx = size.width * (0.25 + (i % 4) / 6),
      cy = size.height * (0.3 + Math.floor(i / 4) / 8);
    const cp = curve(cx, cy, size.width * 0.14, size.height * 0.2);
    p.paths[cp.id] = cp;
    const clip = {
      id: id(),
      layerId: l.id,
      trigger: { kind: 'timeline', at: moment(1) },
      effect: {
        kind: 'outline',
        path: { pathId: cp.id, transform: identity() },
        drawing: { mode: i % 2 ? 'single' : 'bidirectional', start: 0.25, forwardRatio: 0.65 },
        stroke: { color: '#ffffff', width: 12, glow: 1, tips: true, tipSize: 16 },
        layer: { kind: 'fade', threshold: 1, durationUs: 500000, fromScale: 0.25, overshoot: 0.18 },
        lineAfter: { kind: 'fade', durationUs: 500000 },
      },
      easing: 'linear',
      progress: { kind: 'elapsed', duration: span(26) },
      after: 'hold',
      priority: 0,
    };
    if (gameplay && i === n - 1) {
      clip.trigger = { kind: 'note', noteId: slider.id, event: 'slider-start' };
      clip.progress = { kind: 'slider-follow', noteId: slider.id };
    } else if (gameplay && n >= 4 && i < 3) {
      clip.trigger = { kind: 'note', noteId: circles[i].id, event: 'hit' };
    }
    p.reveals[clip.id] = clip;
  });
  if (production) {
    const assets = Object.values(p.assets).filter((a) => a.audioRole === 'sfx');
    assert.equal(assets.length, 3);
    const sound = (asset, trigger, bus = 'hit', delayUs = 0) => {
      const c = {
        id: id(),
        assetId: asset.id,
        trigger,
        bus,
        delayUs,
        gain: 0.7,
        pan: 0,
        enabled: true,
      };
      p.sounds[c.id] = c;
    };
    circles.forEach((c, i) => sound(assets[i], { kind: 'note', noteId: c.id, event: 'hit' }));
    sound(assets[0], { kind: 'note', noteId: slider.id, event: 'slider-start' });
    sound(assets[2], { kind: 'note', noteId: slider.id, event: 'slider-complete' });
    sound(assets[1], { kind: 'slider-tick', noteId: slider.id, intervalTicks: 240 });
    for (const at of [2, 3, 5, 7, 10, 12, 14, 16, 18, 20])
      sound(assets[2], { kind: 'timeline', at: moment(at) }, 'animation');
    for (const clip of Object.values(p.reveals).slice(0, 4)) {
      sound(assets[1], { kind: 'outline-start', revealId: clip.id }, 'animation');
      sound(assets[2], { kind: 'layer-reveal', revealId: clip.id }, 'animation');
    }
    const size = p.stage.artworkSize,
      center = { x: size.width / 2, y: size.height / 2 };
    const neutral = { position: center, zoom: 1, rotationRad: 0, pivot: center };
    p.camera = { base: neutral, enabled: true, keys: {}, shakes: {} };
    for (const [s, zoom, position, rotationRad] of [
      [0, 1, center, 0],
      [6, 1.8, { x: size.width * 0.45, y: size.height * 0.35 }, 0.035],
      [20, 1, center, 0],
    ]) {
      const key = {
        id: id(),
        at: moment(s),
        position,
        zoom,
        rotationRad,
        pivot: position,
        easingToNext: { cubicBezier: [0.3, 0, 0.7, 1] },
      };
      p.camera.keys[key.id] = key;
    }
    const shake = {
      id: id(),
      at: moment(10),
      duration: span(0.5),
      amplitude: { x: 60, y: 45 },
      rotationRad: 0.008,
      frequencyHz: 12,
      seed: 7,
    };
    p.camera.shakes[shake.id] = shake;
  }
  return p;
}
async function importMaterial(label, psd, simulated) {
  await foreground();
  await page.getByRole('button', { name: '新建', exact: true }).click();
  await page.getByLabel('新工程名称', { exact: true }).fill(`性能验证 ${label}`);
  await page.getByRole('button', { name: '创建工程', exact: true }).click();
  await page.getByRole('dialog', { name: '新建工程', exact: true }).waitFor({ state: 'hidden' });
  await settled();
  const before = await memory();
  await choose(psd);
  const start = performance.now();
  await page.getByRole('button', { name: '＋ 导入 PSD / PNG', exact: true }).click();
  await page
    .getByRole('dialog', { name: '图片导入进度', exact: true })
    .waitFor({ state: 'hidden', timeout: 180000 });
  await settled();
  await textures();
  const elapsedMs = performance.now() - start;
  await choose(path.join(directory, '120BPM-60s.wav'));
  await page.getByRole('button', { name: '导入音乐', exact: true }).first().click();
  await settled();
  await page.locator('[data-testid=waveform][data-ready=true]').waitFor();
  if (production)
    for (let i = 0; i < 3; i++) {
      await choose(path.join(directory, `hit-${i}.wav`));
      await page.getByRole('button', { name: '＋ 音效', exact: true }).click();
      await settled();
    }
  const folder = path.join(directory, label);
  await fs.mkdir(folder, { recursive: true });
  const base = await save(path.join(folder, 'base.rcproj'));
  const m = await metrics(`${label}-import`);
  report.materials.push({
    label,
    psd,
    simulated,
    size: base.stage.artworkSize,
    rasterLayers: Object.values(base.layers).filter((l) => l.kind === 'raster').length,
    groups: Object.values(base.layers).filter((l) => l.kind === 'group').length,
    endToEndImportMs: elapsedMs,
    importer: m.lastImageImport,
    before,
    after: await memory(),
    graphics: m.graphics,
  });
  return { label, base, folder };
}
async function benchmark(material, n, runs = repetitions) {
  const p = workload(material.base, n),
    file = path.join(material.folder, `${n}-outlines.rcproj`);
  await fs.writeFile(file, JSON.stringify(p));
  await open(file);
  await page.getByRole('button', { name: '预览', exact: true }).click();
  const result = { material: material.label, count: n, runs: [], memory: [] };
  for (let run = 0; run < runs; run++) {
    await jump(2);
    await page.getByRole('button', { name: '播放', exact: true }).click();
    await frames();
    const measuring = sample(seconds * 1000);
    result.memory.push(await memory());
    // Process samples do not poll the DOM, open a panel, or pause audio during the frame window.
    const measured = await measuring;
    result.memory.push(await memory());
    await fs.writeFile(
      path.join(directory, `${material.label}-${n}-${run}-frames.json`),
      JSON.stringify(measured.raw),
    );
    result.runs.push(measured.summary);
    await pause();
    console.log(
      `SAMPLE ${material.label} n=${n} run=${run + 1} FPS=${measured.summary.frames.fps.toFixed(2)} P95=${measured.summary.frames.p95Ms.toFixed(2)} P99=${measured.summary.frames.p99Ms.toFixed(2)} updates=${measured.summary.playheadUpdates.fps.toFixed(2)}`,
    );
  }
  const m = await metrics(`${material.label}-${n}`);
  result.graphics = m.graphics;
  result.resources = m.resources;
  if (production) {
    result.sounds = m.sounds;
    assert(m.sounds.recent.some((s) => !s.audition));
    assert.equal(m.sounds.voices, 0);
    assert(m.sounds.buffers <= 3);
    assert.equal(await page.evaluate(() => window.__perfAudio.active), 0);
  }
  assert.equal(m.graphics.outlines.objects, n);
  assert.equal(m.graphics.outlines.visibleObjects, n);
  assert.equal(m.graphics.layers.failed, 0);
  assert(result.runs.every((r) => r.audioRmsMax > 0.001 && r.backwards === 0));
  await page.screenshot({ path: path.join(directory, `${material.label}-${n}.png`) });
  report.cases.push(result);
  return { p, file };
}

async function transition(material) {
  await open(path.join(material.folder, '16-outlines.rcproj'));
  await page.getByRole('button', { name: '预览', exact: true }).click();
  await jump(25);
  await page.getByRole('button', { name: '播放', exact: true }).click();
  const measured = await sample(4500);
  await pause();
  await textures();
  const m = await metrics(`${material.label}-layer-transition`);
  assert.equal(m.graphics.outlines.visibleObjects, 0);
  assert.equal(m.graphics.reveals.filter((r) => r.clipId && r.alpha === 1).length, 16);
  report.cases.push({
    material: material.label,
    count: 16,
    phase: 'outline-to-full-layer transition',
    runs: [measured.summary],
    memory: [await memory()],
    graphics: m.graphics,
    sounds: m.sounds,
    resources: m.resources,
  });
  await page.screenshot({ path: path.join(directory, `${material.label}-complete.png`) });
}

function sliderAt(project, note) {
  const [a, d] = project.paths[note.path.pathId].nodes;
  const b = { x: a.point.x + a.handleOut.x, y: a.point.y + a.handleOut.y };
  const c = { x: d.point.x + d.handleIn.x, y: d.point.y + d.handleIn.y };
  const points = [];
  let length = 0;
  for (let i = 0; i <= 2000; i++) {
    const t = i / 2000,
      u = 1 - t;
    const p = {
      x: u ** 3 * a.point.x + 3 * u * u * t * b.x + 3 * u * t * t * c.x + t ** 3 * d.point.x,
      y: u ** 3 * a.point.y + 3 * u * u * t * b.y + 3 * u * t * t * c.y + t ** 3 * d.point.y,
    };
    if (points.length) length += Math.hypot(p.x - points.at(-1).x, p.y - points.at(-1).y);
    points.push({ ...p, distance: length });
  }
  return (f) => {
    const distance = Math.max(0, Math.min(1, f)) * length;
    let lo = 1,
      hi = points.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (points[mid].distance < distance) lo = mid + 1;
      else hi = mid;
    }
    const a = points[lo - 1],
      b = points[lo],
      t = (distance - a.distance) / (b.distance - a.distance);
    return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
  };
}
async function coordinateMapper(project) {
  const vp = await page.getByTestId('canvas-host').evaluate((el) => ({
    z: Number(el.dataset.zoom),
    x: Number(el.dataset.panX),
    y: Number(el.dataset.panY),
  }));
  const box = await page.getByTestId('pixi-canvas').boundingBox();
  const a = project.stage.playfieldRect,
    c = project.stage.chartSize;
  const scale = Math.min(a.width / c.width, a.height / c.height);
  const ox = a.x + (a.width - c.width * scale) / 2,
    oy = a.y + (a.height - c.height * scale) / 2;
  return (p) => ({
    x: box.x + vp.x + (ox + p.x * scale) * vp.z,
    y: box.y + vp.y + (oy + p.y * scale) * vp.z,
  });
}
async function audioTime() {
  return page.evaluate(() => window.__perfAudioNow());
}
async function untilAudio(timeUs) {
  await page.waitForFunction((target) => window.__perfAudioNow() >= target, timeUs, { polling: 5 });
}
async function gameplay(material, n, interrupted = false) {
  const p = workload(material.base, n, true);
  const missedCircle = interrupted
    ? { id: id(), kind: 'circle', at: moment(8), position: { x: 220, y: 180 }, radius: 24 }
    : null;
  if (missedCircle) p.notes[missedCircle.id] = missedCircle;
  const file = path.join(material.folder, `${n}-playtest-${interrupted ? 'break' : 'full'}.rcproj`);
  await fs.writeFile(file, JSON.stringify(p));
  await open(file);
  const slider = Object.values(p.notes).find((n) => n.kind === 'slider');
  const circles = Object.values(p.notes).filter(
    (n) => n.kind === 'circle' && n.id !== missedCircle?.id,
  );
  const follow = Object.values(p.reveals).find((r) => r.progress.kind === 'slider-follow');
  await page
    .locator('.production-tabs')
    .getByRole('button', { name: '图层 / 谱面', exact: true })
    .click();
  await page.locator(`.reveal-select[data-reveal-id="${follow.id}"]`).click();
  await page.getByRole('button', { name: '试玩', exact: true }).click();
  await jump(0);
  const screen = await coordinateMapper(p),
    at = sliderAt(p, slider);
  const move = async (point) => {
    const s = screen(point);
    await page.mouse.move(s.x, s.y);
  };
  await page.evaluate(() => {
    window.__perfAudio.inputs = [];
  });
  await page.getByRole('button', { name: '播放', exact: true }).click();
  await page.evaluate(() => window.__startPerfSample(15800));
  for (const [i, circle] of circles.entries()) {
    await move(circle.position);
    await untilAudio(circle.at.timeUs - 15000);
    if (i === 0) {
      await page.mouse.down();
      await page.mouse.up();
    } else {
      await page.keyboard.down('z');
      await page.keyboard.up('z');
    }
  }
  await move(at(0));
  await untilAudio(slider.at.timeUs - 15000);
  await page.keyboard.down('z');
  let held = true,
    gapStart,
    gapEnd;
  const progress = async () =>
    Number(await page.getByTestId('reveal-state').getAttribute('data-progress'));
  while ((await audioTime()) < 15250000) {
    const t = await audioTime(),
      f = (t - 9000000) / 6000000;
    if (interrupted && f >= 0.35 && f < 0.6 && held) {
      await page.keyboard.up('z');
      held = false;
      await frames();
      gapStart = await progress();
    }
    if (interrupted && f >= 0.6 && !held) {
      gapEnd = await progress();
      await page.keyboard.down('z');
      held = true;
    }
    await move(at(f));
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  await page.keyboard.up('z');
  const raw = await page.evaluate(() => window.__perfSamplePromise);
  await pause();
  const results = await page.locator('.result-item').evaluateAll((els) =>
    els.map((el) => ({
      id: el.dataset.noteId,
      status: el.dataset.result,
      progress: Number(el.dataset.progress),
      text: el.textContent,
      breaks: [...el.querySelectorAll('[data-reason]')].map((b) => ({
        start: Number(b.dataset.startUs),
        end: Number(b.dataset.endUs),
        reason: b.dataset.reason,
      })),
    })),
  );
  const inputs = await page.evaluate(() => window.__perfAudio.inputs);
  // Preserve timing evidence even when a later gameplay assertion fails.
  await fs.writeFile(
    path.join(directory, `playtest-${n}-${interrupted ? 'break' : 'full'}-inputs.json`),
    JSON.stringify({ circles, results, inputs, sample: summarize(raw) }, null, 2),
  );
  const intentionalMiss = missedCircle && results.find((r) => r.id === missedCircle.id);
  if (missedCircle) assert.equal(intentionalMiss.status, 'miss');
  const hits = circles.map((c, i) => {
    const result = results.find((r) => r.id === c.id);
    assert(['perfect', 'good'].includes(result.status),
      `Circle ${i + 1}: ${JSON.stringify({ result, input: inputs[i], expectedUs: c.at.timeUs })}`);
    const textErrorMs = Number(result.text.match(/([+-][\d.]+)\s*ms/)?.[1]);
    const observedErrorMs = (inputs[i].audioUs - c.at.timeUs) / 1000;
    assert(
      Math.abs(textErrorMs - observedErrorMs) < 3,
      'Judgement must match the input-time audio clock',
    );
    return { id: c.id, grade: result.status, textErrorMs, observedErrorMs };
  });
  const sr = results.find((r) => r.id === slider.id);
  assert.equal(sr.status, interrupted ? 'failed' : 'complete');
  assert(interrupted ? sr.progress > 0.65 && sr.progress < 0.85 : sr.progress > 0.98);
  if (interrupted) {
    assert(Math.abs(gapEnd - gapStart) < 0.02);
    assert(sr.breaks.some((b) => b.reason === 'released' && b.end - b.start > 1200000));
  }
  const m = await metrics(`${material.label}-playtest-${n}-${interrupted ? 'break' : 'full'}`);
  if (production) {
    assert(m.sounds.recent.length >= 10);
    assert.equal(m.sounds.voices, 0);
    assert.equal(await page.evaluate(() => window.__perfAudio.active), 0);
  }
  const reveal = m.graphics.reveals.find((r) => r.clipId === follow.id);
  assert(Math.abs(reveal.progress - sr.progress) < 0.005);
  if (interrupted) assert.equal(reveal.alpha, 0);
  report.gameplay.push({
    material: material.label,
    n,
    interrupted,
    hits,
    intentionalMiss,
    slider: sr,
    gapStart,
    gapEnd,
    followReveal: reveal,
    sample: summarize(raw),
    memory: await memory(),
    graphics: m.graphics,
    sounds: m.sounds,
  });
  await fs.writeFile(
    path.join(directory, `playtest-${n}-${interrupted ? 'break' : 'full'}-frames.json`),
    JSON.stringify(raw),
  );
  await page.screenshot({
    path: path.join(directory, `playtest-${n}-${interrupted ? 'break' : 'full'}.png`),
  });
}

async function transportChecks() {
  const read = () => page.getByTestId('playhead').getAttribute('data-time-us').then(Number);
  await page.getByRole('button', { name: '预览', exact: true }).click();
  await jump(6.25);
  const at = await read();
  await page.waitForTimeout(650);
  assert.equal(await read(), at);
  const rms = await page.evaluate(() => {
    const v = new Float32Array(1024);
    window.__perfAudio.analyser.getFloatTimeDomainData(v);
    return Math.sqrt(v.reduce((a, b) => a + b * b, 0) / v.length);
  });
  assert(rms < 1e-5);
  await page.getByRole('button', { name: '播放', exact: true }).click();
  const resume = await sample(1500);
  await jump(21);
  assert(Math.abs((await read()) - 21000000) < 2000);
  await page.getByRole('button', { name: '播放', exact: true }).click();
  const seek = await sample(1500);
  await pause();
  assert.equal(resume.summary.backwards, 0);
  assert.equal(seek.summary.backwards, 0);
  assert(resume.summary.audioClockOffset.p99Ms < 35 && seek.summary.audioClockOffset.p99Ms < 35);
  await page.getByRole('button', { name: '从头试玩', exact: true }).click();
  await page.waitForFunction(
    () => Number(document.querySelector('[data-testid=playhead]')?.dataset.timeUs) > 200000,
  );
  assert((await read()) < 2000000);
  await pause();
  report.transport = {
    pausedAtUs: at,
    pausedRms: rms,
    resume: resume.summary,
    seek: seek.summary,
    replay: true,
  };
}

async function lifecycle(material) {
  const checkpoints = [
    0,
    Math.round(lifecycleCycles / 3),
    Math.round((lifecycleCycles * 2) / 3),
    lifecycleCycles,
  ];
  const file = path.join(material.folder, '16-outlines.rcproj');
  await open(file);
  await page.getByRole('button', { name: '编辑', exact: true }).click();
  const source = page.getByLabel('显示完整素材', { exact: true });
  async function cycle() {
    await foreground();
    await source.uncheck();
    for (const s of [0.25, 7.5, 26.6, 27.3, 30, 10]) await jump(s);
    await source.check();
    await textures();
  }
  // Warm geometry, render targets and image caches before comparing retained memory.
  for (let i = 0; i < 3; i++) await cycle();
  for (let i = 0; i <= lifecycleCycles; i++) {
    if (i) await cycle();
    if (!checkpoints.includes(i)) continue;
    await page.waitForTimeout(400);
    const normal = await memory(),
      collected = [0, lifecycleCycles].includes(i) ? await memory(true) : null,
      m = await metrics(`lifecycle-toggle-${i}`);
    assert.equal(m.graphics.outlines.objects, 0);
    assert.equal(m.graphics.outlines.chunks, 0);
    assert.equal(m.graphics.layers.failed, 0);
    assert(m.graphics.layers.rgbaBytesEstimate <= m.graphics.layers.budgetBytes);
    assert.equal(m.resources.count, 1);
    report.lifecycle.push({
      kind: 'toggle-and-six-seeks',
      cycle: i,
      normal,
      collected,
      graphics: m.graphics,
      resources: m.resources,
    });
    console.log(
      `LIFECYCLE toggle ${i}: private=${normal.privateMiB.toFixed(1)} MiB heap=${((collected ?? normal).heap.usedSize / 1048576).toFixed(2)} MiB buffers=${(collected ?? normal).gl.live.Buffer} textures=${(collected ?? normal).gl.live.Texture}`,
    );
    await persist();
  }
  for (let i = 0; i <= lifecycleCycles; i++) {
    await open(file);
    await source.uncheck();
    await jump(10);
    await frames();
    await jump(30);
    await source.check();
    await textures();
    if (!checkpoints.includes(i)) continue;
    await page.waitForTimeout(400);
    const normal = await memory(),
      collected = [0, lifecycleCycles].includes(i) ? await memory(true) : null,
      m = await metrics(`lifecycle-reload-${i}`);
    assert.equal(m.graphics.outlines.objects, 0);
    assert.equal(m.graphics.layers.failed, 0);
    assert.equal(m.resources.count, 1);
    report.lifecycle.push({
      kind: 'reopen-project',
      cycle: i,
      normal,
      collected,
      graphics: m.graphics,
      resources: m.resources,
    });
    console.log(
      `LIFECYCLE reload ${i}: private=${normal.privateMiB.toFixed(1)} MiB heap=${((collected ?? normal).heap.usedSize / 1048576).toFixed(2)} MiB buffers=${(collected ?? normal).gl.live.Buffer} textures=${(collected ?? normal).gl.live.Texture}`,
    );
    await persist();
  }
  await page.getByRole('button', { name: '新建', exact: true }).click();
  await page.getByLabel('新工程名称', { exact: true }).fill('性能验证结束 · 空工程');
  await page.getByRole('button', { name: '创建工程', exact: true }).click();
  await settled();
  await textures();
  await page.waitForTimeout(1000);
  const collected = await memory(true),
    m = await metrics('lifecycle-empty');
  assert.equal(m.resources.count, 0);
  assert.equal(m.graphics.layers.residentTextures, 0);
  assert.equal(m.graphics.outlines.objects, 0);
  report.lifecycle.push({
    kind: 'empty-project',
    collected,
    graphics: m.graphics,
    resources: m.resources,
  });
  // These deliberately compare retained resources, not transient allocator high-water marks.
  for (const kind of ['toggle-and-six-seeks', 'reopen-project']) {
    const rows = report.lifecycle.filter((r) => r.kind === kind && r.collected);
    const first = rows[0].collected,
      last = rows.at(-1).collected;
    assert(
      last.heap.usedSize - first.heap.usedSize < 8 * 1048576,
      `${kind}: retained JS heap keeps growing`,
    );
    assert(
      last.gl.live.Texture - first.gl.live.Texture <= 2,
      `${kind}: retained GL textures keep growing`,
    );
    assert(
      last.gl.live.Buffer - first.gl.live.Buffer <= 8,
      `${kind}: retained GL buffers keep growing`,
    );
    assert(
      last.gl.live.Framebuffer - first.gl.live.Framebuffer <= 2,
      `${kind}: retained GL framebuffers keep growing`,
    );
  }
}

try {
  await fs.writeFile(path.join(directory, '120BPM-60s.wav'), wav());
  if (production)
    for (let i = 0; i < 3; i++)
      await fs.writeFile(path.join(directory, `hit-${i}.wav`), wav(0.12 + i * 0.07, 880 + i * 220));
  app = await electron.launch({ args: [root], cwd: root, env, timeout: 60000 });
  page = await app.firstWindow();
  page.setDefaultTimeout(30000);
  page.on('pageerror', (e) => report.errors.push(String(e)));
  page.on('console', (m) => {
    if (m.type() === 'error') report.errors.push(m.text());
  });
  await page.addInitScript(installObservers);
  await page.reload();
  await page.getByTestId('pixi-canvas').waitFor();
  await settled();
  cdp = await page.context().newCDPSession(page);
  report.machine.electron = await app.evaluate(({ app, screen }) => ({
    version: app.getVersion(),
    electron: process.versions.electron,
    chromium: process.versions.chrome,
    displays: screen
      .getAllDisplays()
      .map((d) => ({ size: d.size, scaleFactor: d.scaleFactor, frequency: d.displayFrequency })),
  }));
  report.machine.webgl = await page.getByTestId('pixi-canvas').evaluate((canvas) => {
    const gl = canvas.getContext('webgl2') ?? canvas.getContext('webgl');
    const ext = gl.getExtension('WEBGL_debug_renderer_info');
    return {
      renderer: ext && gl.getParameter(ext.UNMASKED_RENDERER_WEBGL),
      vendor: ext && gl.getParameter(ext.UNMASKED_VENDOR_WEBGL),
      dpr: devicePixelRatio,
      buffer: { width: canvas.width, height: canvas.height },
      window: { width: innerWidth, height: innerHeight },
    };
  });
  let psd = path.join(root, 'test-results', 'stage2', 'fixtures', '6000x6000-100层-典型裁剪.psd');
  if (!(await fs.stat(psd).catch(() => null)))
    psd = (await largeFixture(path.join(directory, 'fixtures'))).psd;
  const synthetic = await check('正常导入 6000×6000、100 图像图层及嵌套组 PSD', () =>
    importMaterial('synthetic100', psd, true),
  );
  assert.deepEqual(synthetic.base.stage.artworkSize, { width: 6000, height: 6000 });
  assert.equal(Object.values(synthetic.base.layers).filter((l) => l.kind === 'raster').length, 100);
  if (lifecycleOnly || postOnly) {
    await fs.writeFile(
      path.join(synthetic.folder, '16-outlines.rcproj'),
      JSON.stringify(workload(synthetic.base, 16)),
    );
    await open(path.join(synthetic.folder, '16-outlines.rcproj'));
  }
  for (const n of lifecycleOnly || postOnly ? [] : counts)
    await check(`6000×6000/100层：${n} 条描边、${repetitions} 轮独立采样`, () =>
      benchmark(synthetic, n),
    );
  if (!pilot) {
    if (!lifecycleOnly && !postOnly) {
      await check('100 层工程：白线完成、16 个图层同时淡入与首次纹理请求', () =>
        transition(synthetic),
      );
      await check('100 层工程、1 条描边：真实 Circle 命中与 Slider 完整追踪', () =>
        gameplay(synthetic, 1),
      );
      await check('100 层工程、16 条描边：真实 Circle 命中与 Slider 完整追踪', () =>
        gameplay(synthetic, 16),
      );
      await check('100 层工程、16 条描边：实际松键、中断冻结、恢复、失败判定', () =>
        gameplay(synthetic, 16, true),
      );
    }
    if (!lifecycleOnly)
      await check('播放/暂停、定位后继续、重播：音乐输出时钟与时间轴', transportChecks);
    await check(`动画开关、多次跳转及 ${lifecycleCycles + 1} 次项目重开：资源生命周期`, () =>
      lifecycle(synthetic),
    );
    const realPSD = process.env.RHYTHM_TEST_PSD ?? 'C:/Users/00/Pictures/灰泽满/插画53 多图层.psd';
    if (!lifecycleOnly && (await fs.stat(realPSD).catch(() => null))) {
      const real = await check('实际导入原始美术 PSD，保留原分辨率和图层', () =>
        importMaterial('real24', realPSD, false),
      );
      for (const n of counts)
        await check(`真实插画：${n} 条描边、独立采样`, () => benchmark(real, n, 1));
      await check('真实插画：16 条描边同时完成后显示完整图层', () => transition(real));
    }
  }
  assert.deepEqual(report.errors, []);
  report.passed = true;
} catch (error) {
  report.passed = false;
  report.error = error.stack ?? String(error);
  console.error(report.error);
  process.exitCode = 1;
  if (page && !page.isClosed())
    await page.screenshot({ path: path.join(directory, 'failure.png') }).catch(() => {});
} finally {
  report.finishedAt = new Date().toISOString();
  await persist();
  if (app) {
    await app.evaluate(({ app }) => app.exit(0)).catch(() => {});
    await app.close().catch(() => {});
  }
  if (path.dirname(profile) === directory && /^profile-\d+$/.test(path.basename(profile)))
    await fs
      .rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 })
      .catch(() => {});
  console.log(`REPORT ${path.join(directory, 'report.json')}`);
}
