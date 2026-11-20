import { _electron as electron } from 'playwright';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'),
  directory = path.join(root, 'test-results', 'stage5');
await fs.mkdir(directory, { recursive: true });
const profile = path.join(directory, `profile-${Date.now()}`),
  env = { ...process.env, RHYTHM_USER_DATA: profile };
delete env.ELECTRON_RUN_AS_NODE;
delete env.ELECTRON_RENDERER_URL;
const report = {
  stage: 5,
  startedAt: new Date().toISOString(),
  checks: [],
  errors: [],
  limitations: [
    'Native Windows Electron/Web Audio/WebGL and actual mouse/keyboard input; only native file-picker answers are substituted.',
    'The large workload is a generated 6000x6000 PSD with 100 trimmed layers; real artwork is tested separately.',
    'Software audio-clock and analyser evidence does not measure physical speaker/display latency.',
  ],
};
let app,
  page,
  p,
  circles,
  slider,
  assets = [],
  outlineId,
  completeClip,
  keys,
  projectFile = path.join(directory, '工程', '音效与镜头.rcproj');
async function record() {
  await fs.writeFile(path.join(directory, 'report.json'), JSON.stringify(report, null, 2));
}
async function check(name, action) {
  const start = performance.now();
  try {
    const evidence = await action();
    report.checks.push({
      name,
      passed: true,
      elapsedMs: Math.round(performance.now() - start),
      evidence,
    });
    console.log('PASS ' + name);
    await record();
    return evidence;
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
async function frames() {
  await page.evaluate(
    () =>
      new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(Error('Foreground frames stalled')), 5000);
        requestAnimationFrame(() =>
          requestAnimationFrame(() => {
            clearTimeout(timer);
            resolve();
          }),
        );
      }),
  );
}
async function foreground() {
  await app.evaluate(({ BrowserWindow }) => {
    const w = BrowserWindow.getAllWindows()[0];
    if (w.isMinimized()) w.restore();
    w.show();
    w.focus();
  });
  await page.bringToFront();
}
async function settled() {
  await page.locator('.editor-shell[aria-busy=false]').waitFor();
  await frames();
}
async function textures() {
  await frames();
  await page.waitForFunction(
    () => Number(document.querySelector('[data-testid=canvas-host]')?.dataset.loading) === 0,
  );
  await frames();
}
async function property(label, value) {
  const input = page.getByLabel(label, { exact: true });
  await input.focus();
  await frames();
  await input.fill(String(value));
  await input.press('Tab');
  await frames();
}
async function jump(s) {
  await property('定位到秒', s);
  await page.waitForTimeout(80);
  await textures();
}
async function pause() {
  const b = page.getByRole('button', { name: '暂停', exact: true });
  if (await b.count()) await b.click();
  await frames();
}
async function tab(name) {
  await page.locator('.production-tabs').getByRole('button', { name, exact: true }).click();
  await frames();
}
async function save(file = projectFile, as = false) {
  await choose(file, true);
  await page.getByRole('button', { name: as ? '另存为' : '保存', exact: true }).click();
  await settled();
  await page.waitForFunction(
    () => document.querySelector('.save-state')?.textContent?.trim() === '已保存',
  );
  p = JSON.parse(await fs.readFile(file, 'utf8'));
  return p;
}
async function open(file) {
  await foreground();
  await choose(file);
  await page.getByRole('button', { name: '打开', exact: true }).click();
  if (await page.getByRole('dialog', { name: '未保存的修改', exact: true }).count())
    await page.getByRole('button', { name: '放弃修改', exact: true }).click();
  await settled();
  await textures();
  await page.locator('[data-testid=waveform][data-ready=true]').waitFor();
  p = JSON.parse(await fs.readFile(file, 'utf8'));
}
async function metrics(name) {
  const file = path.join(directory, name + '.json');
  await choose(file, true);
  await page.getByRole('button', { name: '查看运行记录', exact: true }).click();
  await page.getByRole('button', { name: '保存性能记录', exact: true }).click();
  await settled();
  await page.getByRole('button', { name: '关闭运行记录', exact: true }).click();
  return JSON.parse(await fs.readFile(file, 'utf8'));
}
async function undo() {
  await page.getByRole('button', { name: '撤销', exact: true }).click();
  await settled();
  await textures();
}
async function screen(at, chart = true) {
  const host = await page.getByTestId('canvas-host').evaluate((el) => ({
      z: Number(el.dataset.zoom),
      x: Number(el.dataset.panX),
      y: Number(el.dataset.panY),
    })),
    box = await page.getByTestId('pixi-canvas').boundingBox();
  let q = at;
  if (chart) {
    const r = p.stage.playfieldRect,
      w = Math.min(p.stage.artworkSize.width, r.x + r.width) - Math.max(0, r.x),
      h = Math.min(p.stage.artworkSize.height, r.y + r.height) - Math.max(0, r.y),
      scale = Math.min(w / p.stage.chartSize.width, h / p.stage.chartSize.height);
    q = {
      x: Math.max(0, r.x) + (w - p.stage.chartSize.width * scale) / 2 + at.x * scale,
      y: Math.max(0, r.y) + (h - p.stage.chartSize.height * scale) / 2 + at.y * scale,
    };
  }
  return { x: box.x + host.x + q.x * host.z, y: box.y + host.y + q.y * host.z };
}
async function click(at) {
  const q = await screen(at);
  await page.mouse.click(q.x, q.y);
  await frames();
}
async function moveTo(at) {
  const q = await screen(at);
  await page.mouse.move(q.x, q.y);
}
async function drag(a, b, chart = true) {
  a = await screen(a, chart);
  b = await screen(b, chart);
  await page.mouse.move(a.x, a.y);
  await page.mouse.down();
  await page.mouse.move(b.x, b.y, { steps: 10 });
  await page.mouse.up();
  await frames();
}
function wav(seconds, frequency) {
  const rate = 24000,
    length = Math.round(rate * seconds),
    b = Buffer.alloc(44 + length * 2);
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
  b.writeUInt32LE(length * 2, 40);
  for (let i = 0; i < length; i++) {
    const t = i / rate,
      envelope =
        seconds > 10
          ? 0.012 + 0.3 * Math.exp(-(t % 0.5) * 65)
          : Math.min(1, t / 0.005, (seconds - t) / 0.01) * 0.35;
    b.writeInt16LE(
      Math.round(Math.sin(t * Math.PI * 2 * frequency) * envelope * 32767),
      44 + i * 2,
    );
  }
  return b;
}
function observeAudio() {
  const Base = window.AudioContext,
    links = new WeakMap(),
    connect = AudioNode.prototype.connect;
  AudioNode.prototype.connect = function (destination, ...args) {
    if (!links.has(this)) links.set(this, destination);
    return connect.call(this, destination, ...args);
  };
  const state = (window.__soundEvidence = {
    contexts: 0,
    starts: [],
    active: new Map(),
    roots: [],
    maxAudible: 0,
    context: null,
    music: null,
  });
  let index = 0;
  window.AudioContext = class extends Base {
    constructor(...args) {
      super(...args);
      state.context = this;
      state.contexts++;
    }
    async decodeAudioData(bytes, ...args) {
      const delay = window.__decodeDelayMs ?? 0;
      const buffer = await super.decodeAudioData(bytes, ...args);
      if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
      return buffer;
    }
    createGain() {
      const gain = super.createGain(),
        context = this,
        original = gain.connect.bind(gain);
      gain.connect = function (destination, ...args) {
        const result = original(destination, ...args);
        if (destination === context.destination) {
          const tap = context.createAnalyser();
          tap.fftSize = 1024;
          connect.call(gain, tap);
          state.roots.push({ gain, tap });
        }
        return result;
      };
      return gain;
    }
    createBufferSource() {
      const source = super.createBufferSource(),
        start = source.start.bind(source),
        stop = source.stop.bind(source);
      let id;
      source.start = function (when = 0, offset = 0, ...args) {
        id = ++index;
        const chain = [];
        let node = source;
        for (let i = 0; i < 8 && node; i++, node = links.get(node)) {
          if (node.gain) chain.push({ gain: node.gain.value });
          if (node.pan) chain.push({ pan: node.pan.value });
        }
        const data = {
          id,
          when,
          offset,
          duration: source.buffer?.duration ?? 0,
          atContext: state.context.currentTime,
          chain,
        };
        state.starts.push(data);
        state.active.set(id, data);
        if (data.duration > 10) state.music = { when, offset };
        source.addEventListener('ended', () => state.active.delete(id));
        return start(when, offset, ...args);
      };
      source.stop = function (...args) {
        if (id) state.active.delete(id);
        return stop(...args);
      };
      return source;
    }
  };
  window.__audioTime = () => {
    const c = state.context,
      a = state.music;
    if (!c || !a) return 0;
    const stamp = c.getOutputTimestamp();
    const now =
      stamp.performanceTime > 0
        ? Math.min(
            c.currentTime,
            stamp.contextTime + Math.max(0, performance.now() - stamp.performanceTime) / 1000,
          )
        : c.currentTime;
    return Math.round((a.offset + Math.max(0, now - a.when)) * 1e6);
  };
  window.__audioRms = () =>
    state.roots.map(({ gain, tap }) => {
      const samples = new Float32Array(1024);
      tap.getFloatTimeDomainData(samples);
      return {
        gain: gain.gain.value,
        rms: Math.sqrt(samples.reduce((a, b) => a + b * b, 0) / samples.length),
      };
    });
  function monitor() {
    if (state.context) {
      const now = state.context.currentTime;
      state.maxAudible = Math.max(
        state.maxAudible,
        [...state.active.values()].filter((v) => v.when <= now && v.when + v.duration > now).length,
      );
    }
    requestAnimationFrame(monitor);
  }
  requestAnimationFrame(monitor);
}
async function native() {
  return page.evaluate(() => ({
    contexts: window.__soundEvidence.contexts,
    starts: window.__soundEvidence.starts.slice(-256),
    active: window.__soundEvidence.active.size,
    maxAudible: window.__soundEvidence.maxAudible,
    roots: window.__audioRms(),
  }));
}
async function until(at) {
  await page.waitForFunction((target) => window.__audioTime() >= target, at, {
    polling: 5,
    timeout: 30000,
  });
}
async function bindSound(asset, note, trigger) {
  const before = new Set(Object.keys(p.sounds));
  await page.locator(`.timeline-note[data-note-id="${note.id}"]`).click();
  await tab('音效');
  await page.getByLabel('绑定音效素材', { exact: true }).selectOption(asset.id);
  await page.getByRole('button', { name: '绑定选中音符', exact: true }).click();
  await frames();
  if (trigger)
    await page
      .getByLabel('音效触发来源', { exact: true })
      .selectOption(`note|${note.id}|${trigger}`);
  await save();
  return Object.keys(p.sounds).find((id) => !before.has(id));
}
async function bindReveal(noteId, layerId, kind) {
  await tab('图层 / 谱面');
  const details = page.locator('details.reveal-add');
  if ((await details.getAttribute('open')) === null) await details.locator('summary').click();
  await page.getByLabel('新绑定音符', { exact: true }).selectOption(noteId);
  await page.getByLabel('新绑定图层', { exact: true }).selectOption(layerId);
  await page.getByLabel('新绑定显现方式', { exact: true }).selectOption(kind);
  await page.getByRole('button', { name: '添加显现绑定', exact: true }).click();
  await frames();
  const id = await page.getByTestId('reveal-state').getAttribute('data-reveal-id');
  await save();
  return id;
}
async function soundForReveal(asset, revealId, event) {
  const before = new Set(Object.keys(p.sounds));
  await tab('图层 / 谱面');
  await page.locator(`.reveal-select[data-reveal-id="${revealId}"]`).click();
  await tab('音效');
  await page.getByLabel('绑定音效素材', { exact: true }).selectOption(asset.id);
  await page.getByRole('button', { name: '绑定选中演出', exact: true }).click();
  await page
    .getByLabel('音效触发来源', { exact: true })
    .selectOption(`reveal|${revealId}|${event}`);
  await save();
  return Object.keys(p.sounds).find((id) => !before.has(id));
}
function sampleCurve(project, note) {
  const ns = project.paths[note.path.pathId].nodes,
    points = [];
  let length = 0;
  for (let s = 1; s < ns.length; s++) {
    const a = ns[s - 1],
      d = ns[s],
      b = { x: a.point.x + a.handleOut.x, y: a.point.y + a.handleOut.y },
      c = { x: d.point.x + d.handleIn.x, y: d.point.y + d.handleIn.y };
    for (let i = 0; i <= 1000; i++) {
      const t = i / 1000,
        u = 1 - t,
        q = {
          x: u ** 3 * a.point.x + 3 * u * u * t * b.x + 3 * u * t * t * c.x + t ** 3 * d.point.x,
          y: u ** 3 * a.point.y + 3 * u * u * t * b.y + 3 * u * t * t * c.y + t ** 3 * d.point.y,
        };
      if (points.length) length += Math.hypot(q.x - points.at(-1).x, q.y - points.at(-1).y);
      points.push({ ...q, d: length });
    }
  }
  return (f) => {
    const target = Math.max(0, Math.min(1, f)) * length;
    let i = 1;
    while (i < points.length - 1 && points[i].d < target) i++;
    const a = points[i - 1],
      b = points[i],
      t = (target - a.d) / Math.max(1e-9, b.d - a.d);
    return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
  };
}
function momentUs(at) {
  return at.basis === 'time' ? at.timeUs : (at.tick / 960) * 500000;
}
async function game(project, interrupted = false) {
  await foreground();
  await page.getByRole('button', { name: '试玩', exact: true }).click();
  await jump(0);
  await tab('图层 / 谱面');
  // Read the editor viewport once, outside timed inputs. The performance suite uses the
  // same mapping; repeated cross-process DOM reads would delay real mouse delivery.
  const origin = await screen({ x: 0, y: 0 }),
    unit = await screen({ x: 1, y: 1 });
  const move = (point) =>
    page.mouse.move(
      origin.x + point.x * (unit.x - origin.x),
      origin.y + point.y * (unit.y - origin.y),
    );
  const before = await native(),
    at = sampleCurve(project, slider);
  await page.getByRole('button', { name: '播放', exact: true }).click();
  for (const [i, c] of circles.entries()) {
    await move(c.position);
    await until(c.at.basis === 'time' ? c.at.timeUs - 15000 : (c.at.tick / 960) * 0.5e6 - 15000);
    if (interrupted && i === 1) continue;
    if (i === 0) {
      await page.mouse.down();
      await page.mouse.up();
    } else {
      await page.keyboard.down('z');
      await page.keyboard.up('z');
    }
  }
  await move(at(0));
  await until(4970000);
  await page.keyboard.down('z');
  let held = true;
  while ((await page.evaluate(() => window.__audioTime())) < 7250000) {
    const time = await page.evaluate(() => window.__audioTime()),
      f = (time - 5e6) / 2e6;
    if (interrupted && f > 0.3 && f < 0.7 && held) {
      await page.keyboard.up('z');
      held = false;
    }
    if (interrupted && f >= 0.7 && !held) {
      await page.keyboard.down('z');
      held = true;
    }
    await move(at(f));
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  await page.keyboard.up('z');
  await until(9e6);
  await pause();
  const rows = await page.locator('.result-item').evaluateAll((els) =>
      els.map((e) => ({
        id: e.dataset.noteId,
        status: e.dataset.result,
        progress: Number(e.dataset.progress),
        text: e.textContent,
      })),
    ),
    after = await native();
  report.latestGame = {
    rows,
    nativeStarts: after.starts.filter((s) => s.id > (before.starts.at(-1)?.id ?? 0)),
  };
  await record();
  for (const [i, c] of circles.entries())
    assert.equal(
      rows.find((r) => r.id === c.id).status,
      interrupted && i === 1 ? 'miss' : 'perfect',
    );
  assert.equal(rows.find((r) => r.id === slider.id).status, interrupted ? 'failed' : 'complete');
  const m = await metrics(interrupted ? 'game-failed' : 'game-full');
  return {
    rows,
    nativeStarts: after.starts.filter((s) => s.id > (before.starts.at(-1)?.id ?? 0)),
    maxAudible: after.maxAudible,
    metrics: m,
  };
}

try {
  const music = path.join(directory, '120BPM.wav');
  await fs.writeFile(music, wav(18, 220));
  const files = [];
  for (const [name, duration, hz] of [
    ['hit-A', 0.08, 880],
    ['hit-B', 0.12, 1100],
    ['hit-C', 0.16, 1440],
    ['tick', 0.035, 1900],
    ['end', 0.25, 660],
    ['animation', 0.4, 440],
  ]) {
    const f = path.join(directory, name + '.wav');
    await fs.writeFile(f, wav(duration, hz));
    files.push(f);
  }
  execFileSync(
    process.env.FFMPEG_PATH ?? 'ffmpeg',
    ['-y', '-v', 'error', '-i', files[1], path.join(directory, 'hit-B.mp3')],
    { windowsHide: true },
  );
  files[1] = path.join(directory, 'hit-B.mp3');
  execFileSync(
    process.env.FFMPEG_PATH ?? 'ffmpeg',
    ['-y', '-v', 'error', '-i', files[2], path.join(directory, 'hit-C.ogg')],
    { windowsHide: true },
  );
  files[2] = path.join(directory, 'hit-C.ogg');
  app = await electron.launch({ args: [root], cwd: root, env, timeout: 60000 });
  page = await app.firstWindow();
  page.setDefaultTimeout(30000);
  page.on('pageerror', (e) => report.errors.push(String(e)));
  page.on('console', (m) => {
    if (m.type() === 'error') report.errors.push(m.text());
  });
  await page.addInitScript(observeAudio);
  await page.reload();
  await page.getByTestId('pixi-canvas').waitFor();
  await settled();
  await check('Windows 窗口启动、新音效/镜头界面可用，长按创建入口移除', async () => {
    assert.equal(await page.getByRole('button', { name: '长按 工具', exact: true }).count(), 0);
    await tab('音效');
    await page.getByLabel('hit 通道音量', { exact: true }).waitFor();
    await tab('镜头');
    await page.getByRole('button', { name: '添加镜头关键帧', exact: true }).waitFor();
    await page.screenshot({ path: path.join(directory, 'window.png') });
  });
  await check('真实 PSD 与音乐导入，旧画面构图不偏移', async () => {
    await choose(process.env.RHYTHM_TEST_PSD ?? 'C:/Users/00/Pictures/灰泽满/插画53 多图层.psd');
    await page.getByRole('button', { name: '＋ 导入 PSD / PNG', exact: true }).click();
    await page
      .getByRole('dialog', { name: '图片导入进度', exact: true })
      .waitFor({ state: 'hidden', timeout: 120000 });
    await settled();
    await textures();
    await choose(music);
    await page.getByRole('button', { name: '导入音乐', exact: true }).first().click();
    await settled();
    await page.locator('[data-testid=waveform][data-ready=true]').waitFor();
    await save();
    const m = await metrics('initial');
    assert.equal(m.graphics.camera.matrix.tx, 0);
    assert.equal(m.graphics.camera.matrix.ty, 0);
    return { size: p.stage.artworkSize, layers: Object.keys(p.layers).length };
  });
  await check('WAV、MP3、OGG 音效真实解码、独立素材、重命名与试听', async () => {
    for (const file of files) {
      const before = new Set(Object.keys(p.assets));
      await choose(file);
      await page.getByRole('button', { name: '＋ 音效', exact: true }).click();
      await settled();
      await save();
      assets.push(Object.values(p.assets).find((a) => a.audioRole === 'sfx' && !before.has(a.id)));
    }
    assert.equal(assets.length, 6);
    const layout = await page.locator('.left-panel').evaluate((el) => {
      const box = el.getBoundingClientRect(),
        header = el.querySelector('.panel-header').getBoundingClientRect();
      return {
        top: box.top,
        header: header.top,
        bottom: box.bottom,
        canvas: document.querySelector('[data-testid=canvas-host]').getBoundingClientRect().bottom,
        timeline: document.querySelector('.timeline-panel').getBoundingClientRect().top,
      };
    });
    assert(Math.abs(layout.header - layout.top) < 1);
    assert(layout.canvas <= layout.timeline + 1, JSON.stringify(layout));
    await property('音效名称 ' + assets[0].id, '清脆打击');
    await save();
    assert.equal(p.assets[assets[0].id].label, '清脆打击');
    await page.getByRole('button', { name: '试听音效 ' + assets[5].id, exact: true }).click();
    await page.waitForFunction(() => window.__audioRms().some((r) => r.rms > 0.005), null, {
      timeout: 4000,
    });
    const n = await native();
    assert.equal(n.contexts, 1);
    assert(n.roots.some((r) => r.rms > 0.005));
    await page.getByRole('button', { name: '停止试听', exact: true }).click();
    return { formats: assets.map((a) => path.extname(a.originalName)), contexts: n.contexts };
  });
  await check('界面创建三个 Circle、一条曲线 Slider 并分别绑定音效', async () => {
    for (const [i, time] of [1.5, 2.5, 3.5].entries()) {
      await jump(time);
      await page.getByRole('button', { name: 'Circle 工具', exact: true }).click();
      await click({ x: 90 + i * 135, y: 85 });
    }
    await jump(5);
    await page.getByRole('button', { name: 'Slider 工具', exact: true }).click();
    await click({ x: 90, y: 250 });
    await click({ x: 420, y: 255 });
    await page.keyboard.press('Enter');
    await save();
    circles = Object.values(p.notes)
      .filter((n) => n.kind === 'circle')
      .sort((a, b) => momentUs(a.at) - momentUs(b.at));
    slider = Object.values(p.notes).find((n) => n.kind === 'slider');
    assert.equal(circles.length, 3);
    assert.ok(slider, 'Enter commits the Slider path');
    assert.equal(p.paths[slider.path.pathId].nodes.length, 2);
    await page.getByRole('button', { name: '路径 工具', exact: true }).click();
    await tab('图层 / 谱面');
    await property('Slider 持续秒数', 2);
    await save();
    slider = p.notes[slider.id];
    const pathData = p.paths[slider.path.pathId],
      start = pathData.nodes[0];
    await drag(
      { x: start.point.x + start.handleOut.x, y: start.point.y + start.handleOut.y },
      { x: 180, y: 80 },
    );
    await save();
    slider = p.notes[slider.id];
    assert.ok(p.paths[slider.path.pathId].nodes[0].handleOut.y < -160);
    for (let i = 0; i < 3; i++) await bindSound(assets[i], circles[i]);
    await bindSound(assets[0], slider, 'slider-start');
    await bindSound(assets[4], slider, 'slider-complete');
    await bindSound(assets[3], slider, 'tick');
    await property('音效音量', 70);
    await property('音效声像', -30);
    await save();
    assert.equal(Object.keys(p.sounds).length, 6);
  });
  await check('Circle → 白线/整层、Slider 完成 → 后续图层，配置分阶段音效', async () => {
    const leg =
        Object.values(p.layers).find((l) => l.name === 'leg-l') ??
        Object.values(p.layers).find((l) => l.kind === 'raster'),
      other =
        Object.values(p.layers).find((l) => l.name === 'hair_back_r') ??
        Object.values(p.layers).filter((l) => l.kind === 'raster')[1];
    outlineId = await bindReveal(circles[0].id, leg.id, 'outline');
    await property('显现时长', 2);
    await property('描边后图层时长', 0.35);
    completeClip = await bindReveal(slider.id, other.id, 'fade');
    await page.getByLabel('显现触发条件', { exact: true }).selectOption('slider-complete');
    await property('显现时长', 0.5);
    await save();
    await soundForReveal(assets[5], outlineId, 'outline-start');
    await soundForReveal(assets[4], outlineId, 'outline-complete');
    await soundForReveal(assets[2], outlineId, 'layer-reveal');
    await soundForReveal(assets[5], completeClip, 'layer-reveal');
    assert.equal(Object.keys(p.sounds).length, 10);
  });
  await check('三个镜头关键帧：全景 → 面部 → 恢复，编辑自定义贝塞尔与节拍震动', async () => {
    await tab('镜头');
    await jump(0);
    await page.getByRole('button', { name: '添加镜头关键帧', exact: true }).click();
    await jump(3);
    await page.getByRole('button', { name: '添加镜头关键帧', exact: true }).click();
    await property('镜头缩放', 2.4);
    await property('镜头X', p.stage.artworkSize.width * 0.49);
    await property('镜头Y', p.stage.artworkSize.height * 0.26);
    await property('镜头中心X', p.stage.artworkSize.width * 0.49);
    await property('镜头中心Y', p.stage.artworkSize.height * 0.26);
    await property('镜头旋转', 4);
    await page.getByLabel('镜头缓动', { exact: true }).selectOption('custom');
    await property('镜头缓动X1', 0.3);
    await property('镜头缓动X2', 0.7);
    await jump(8.5);
    await page.getByRole('button', { name: '添加镜头关键帧', exact: true }).click();
    await page.getByRole('button', { name: '重置镜头构图', exact: true }).click();
    await jump(4);
    await page.getByRole('button', { name: '添加节拍震动', exact: true }).click();
    await save();
    keys = Object.values(p.camera.keys).sort(
      (a, b) =>
        (a.at.basis === 'time' ? a.at.timeUs : (a.at.tick / 960) * 500000) -
        (b.at.basis === 'time' ? b.at.timeUs : (b.at.tick / 960) * 500000),
    );
    assert.equal(keys.length, 3);
    assert.equal(Object.keys(p.camera.shakes).length, 1);
    await jump(3);
    const m = await metrics('camera-face');
    assert.equal(m.graphics.camera.pose.zoom, 2.4);
    assert.equal(m.graphics.camera.affectsNotes, false);
    await page.screenshot({ path: path.join(directory, 'camera-face.png') });
  });
  await check('画布拖动/滚轮调整镜头可撤销，编辑画布缩放独立', async () => {
    await tab('镜头');
    await jump(3);
    const before = structuredClone(p.camera.keys);
    await page.getByRole('button', { name: '画布拖动镜头', exact: true }).click();
    const a = await screen({ x: 3000, y: 2000 }, false),
      viewport = await page.getByTestId('canvas-host').getAttribute('data-zoom');
    await page.mouse.move(a.x, a.y);
    await page.mouse.down();
    await page.mouse.move(a.x + 25, a.y + 8, { steps: 6 });
    await page.mouse.up();
    await save();
    assert.notDeepEqual(p.camera.keys, before);
    await undo();
    await save();
    assert.deepEqual(p.camera.keys, before);
    await page.mouse.move(a.x, a.y);
    await page.mouse.wheel(0, -120);
    await frames();
    await save();
    assert.equal(await page.getByTestId('canvas-host').getAttribute('data-zoom'), viewport);
    assert.notDeepEqual(p.camera.keys, before);
    await undo();
    await save();
    await page.getByRole('button', { name: '画布拖动镜头', exact: true }).click();
  });
  await check('镜头关键帧在时间轴拖动、复制、删除和撤销；六轨排序不改变图层顺序', async () => {
    await tab('镜头');
    const k = keys[1],
      button = page.locator(`.timeline-camera-key[data-camera-id="${k.id}"]`);
    await button.scrollIntoViewIfNeeded();
    const box = await button.boundingBox();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2 + 22, box.y + box.height / 2, { steps: 7 });
    await page.mouse.up();
    await save();
    assert.equal(p.camera.keys[k.id].at.timeUs, 3500000);
    await undo();
    await save();
    await page.locator(`.camera-key-list [data-camera-id="${k.id}"]`).click();
    await page.getByRole('button', { name: '复制镜头关键帧', exact: true }).click();
    await save();
    assert.equal(Object.keys(p.camera.keys).length, 4);
    await page.getByRole('button', { name: '删除镜头关键帧', exact: true }).click();
    await save();
    assert.equal(Object.keys(p.camera.keys).length, 3);
    const roots = structuredClone(p.rootLayersBottomToTop);
    await page.getByRole('button', { name: '上移轨道 camera', exact: true }).click();
    await page.getByRole('button', { name: '折叠轨道 sounds', exact: true }).click();
    await page.getByRole('button', { name: '隐藏轨道 outlines', exact: true }).click();
    await save();
    assert.deepEqual(p.rootLayersBottomToTop, roots);
    assert(p.tracks.hidden.includes('outlines'));
    await page.getByRole('button', { name: '隐藏轨道 outlines', exact: true }).click();
    await page.getByRole('button', { name: '折叠轨道 sounds', exact: true }).click();
    await save();
    await page.screenshot({ path: path.join(directory, 'six-tracks.png') });
  });
  await check('混音静音作用于真实音频信号；素材替换/删除引用可撤销', async () => {
    await tab('音效');
    await page.getByRole('button', { name: '试听音效 ' + assets[5].id, exact: true }).click();
    await page.waitForFunction(() => window.__audioRms().some((r) => r.rms > 0.005), null, {
      timeout: 4000,
    });
    assert((await native()).roots.some((r) => r.rms > 0.005));
    await page.getByLabel('hit 通道静音', { exact: true }).check();
    await page.getByRole('button', { name: '试听音效 ' + assets[5].id, exact: true }).click();
    await page.waitForTimeout(100);
    const muted = await native();
    assert(muted.roots[1].rms < 0.001);
    await page.getByLabel('hit 通道静音', { exact: true }).uncheck();
    await page.getByRole('button', { name: '停止试听', exact: true }).click();
    const refs = Object.values(p.sounds)
        .filter((c) => c.assetId === assets[0].id)
        .map((c) => c.id),
      card = page.locator(`.sfx-asset[data-asset-id="${assets[0].id}"]`);
    await choose(files[1]);
    await card.getByRole('button', { name: '替换', exact: true }).click();
    await settled();
    await save();
    assert(refs.every((id) => p.sounds[id].assetId !== assets[0].id));
    await undo();
    await save();
    assert(refs.every((id) => p.sounds[id].assetId === assets[0].id));
    await card.getByRole('button', { name: '删除引用', exact: true }).click();
    await save();
    assert(refs.every((id) => !p.sounds[id]));
    await undo();
    await save();
    assert(refs.every((id) => p.sounds[id]));
  });
  await check('时间音效在六轨中吸附拖动、复制/删除/撤销，延迟/声像和音量真实生效', async () => {
    await jump(10.5);
    await tab('音效');
    const before = new Set(Object.keys(p.sounds));
    await page.getByLabel('绑定音效素材', { exact: true }).selectOption(assets[5].id);
    await page.getByRole('button', { name: '添加时间音效', exact: true }).click();
    await property('音效延迟', 80);
    await property('音效音量', 60);
    await property('音效声像', 20);
    await save();
    const id = Object.keys(p.sounds).find((id) => !before.has(id));
    const clip = page.locator(`.timeline-sound[data-sound-id="${id}"]`);
    await clip.scrollIntoViewIfNeeded();
    const b = await clip.boundingBox();
    await page.mouse.move(b.x + 12, b.y + b.height / 2);
    await page.mouse.down();
    await page.mouse.move(b.x + 34, b.y + b.height / 2, { steps: 6 });
    await page.mouse.up();
    await save();
    assert.equal(momentUs(p.sounds[id].trigger.at) + p.sounds[id].delayUs, 11125000);
    const count = Object.keys(p.sounds).length;
    await page.getByRole('button', { name: '复制音效片段', exact: true }).click();
    await save();
    assert.equal(Object.keys(p.sounds).length, count + 1);
    await page.getByRole('button', { name: '删除音效片段', exact: true }).click();
    await save();
    assert.equal(Object.keys(p.sounds).length, count);
    await undo();
    await save();
    assert.equal(Object.keys(p.sounds).length, count + 1);
    await undo();
    await save();
    assert.equal(Object.keys(p.sounds).length, count);
    await page.getByRole('button', { name: '预览', exact: true }).click();
    await jump(10.7);
    const last = (await native()).starts.at(-1)?.id ?? 0;
    await page.getByRole('button', { name: '播放', exact: true }).click();
    await until(11600000);
    await pause();
    const nativeSounds = (await native()).starts.filter((s) => s.id > last && s.duration < 1);
    assert.equal(nativeSounds.length, 1);
    assert(nativeSounds[0].chain.some((n) => Math.abs(n.pan - 0.2) < 0.0001));
    assert(nativeSounds[0].chain.some((n) => Math.abs(n.gain - 0.6) < 0.0001));
    await page.getByRole('button', { name: '编辑', exact: true }).click();
    return { nominalUs: 11125000, voices: nativeSounds.length, gain: 0.6, pan: 0.2 };
  });
  await check('随机跳转直接恢复镜头/震动及图层，六轨标签保持对齐', async () => {
    await tab('镜头');
    await jump(4.2);
    const original = (await metrics('camera-jump-before')).graphics.camera;
    await jump(0.3);
    await jump(7.6);
    await jump(4.2);
    assert.deepEqual((await metrics('camera-jump-after')).graphics.camera, original);
    const aligned = await page.locator('.timeline-label-row').evaluateAll((labels) =>
      labels.map((l) => {
        const row = document.querySelector(`[data-track="${l.dataset.trackLabel}"]`);
        return {
          id: l.dataset.trackLabel,
          delta: Math.abs(l.getBoundingClientRect().y - row.getBoundingClientRect().y),
        };
      }),
    );
    assert(
      aligned.every((a) => a.delta < 1.1),
      JSON.stringify(aligned),
    );
    return { pose: original.pose, alignment: aligned };
  });
  await check('Preview 自动成功演出、音效叠加；暂停清空、跳转不补播过去音效', async () => {
    await page.getByRole('button', { name: '预览', exact: true }).click();
    await jump(0);
    await page.getByRole('button', { name: '播放', exact: true }).click();
    await until(4100000);
    await pause();
    await page.waitForTimeout(100);
    let n = await native();
    assert.equal(n.active, 0);
    assert(n.maxAudible >= 3);
    const before = n.starts.at(-1).id;
    await jump(6.3);
    await page.waitForTimeout(100);
    assert.equal((await native()).starts.at(-1).id, before);
    await page.getByRole('button', { name: '播放', exact: true }).click();
    await until(8e6);
    await pause();
    const m = await metrics('preview-seek');
    const pastHits = m.sounds.recent.filter((c) =>
      circles.some((n) => m.project && p.sounds[c.cueId]?.trigger.noteId === n.id),
    );
    assert.equal(pastHits.length, 3);
    return { maxAudible: n.maxAudible, contexts: n.contexts };
  });
  await check(
    'Playtest 真实点击和 Slider 追踪：镜头运动不改变判定，音效/白线/后续演出联动',
    async () => {
      const result = await game(p);
      assert(result.maxAudible >= 3);
      assert(result.rows.find((r) => r.id === slider.id).progress > 0.98);
      assert.equal(result.metrics.sounds.voices, 0);
      const events = result.metrics.sounds.recent;
      assert(events.some((s) => p.sounds[s.cueId]?.trigger.kind === 'outline-complete'));
      assert(result.nativeStarts.filter((s) => s.duration < 1).length >= 10);
      report.fullGame = result;
      await page.screenshot({ path: path.join(directory, 'playtest-full.png') });
      return { rows: result.rows, maxAudible: result.maxAudible };
    },
  );
  await check('Playtest 故意 Miss/松键：不播放成功音效，不触发完成演出', async () => {
    const before = (await metrics('before-failure')).sounds.recent.length,
      result = await game(p, true),
      events = result.metrics.sounds.recent.slice(before);
    assert(
      !events.some(
        (s) =>
          p.sounds[s.cueId]?.trigger.kind === 'note' &&
          p.sounds[s.cueId].trigger.noteId === circles[1].id,
      ),
    );
    assert(
      !events.some(
        (s) =>
          p.sounds[s.cueId]?.trigger.kind === 'note' &&
          p.sounds[s.cueId].trigger.event === 'slider-complete',
      ),
    );
    assert(
      !events.some(
        (s) =>
          'revealId' in (p.sounds[s.cueId]?.trigger ?? {}) &&
          p.sounds[s.cueId].trigger.revealId === completeClip,
      ),
    );
    report.failedGame = result;
    return result.rows;
  });
  await check('保存并重开恢复音效/镜头/六轨及所有 PSD/谱面绑定，反复重播无声源累积', async () => {
    await page.getByRole('button', { name: '编辑', exact: true }).click();
    await save();
    const expected = structuredClone(p);
    await open(projectFile);
    for (const field of [
      'notes',
      'paths',
      'reveals',
      'sounds',
      'camera',
      'mixer',
      'tracks',
      'layers',
    ])
      assert.deepEqual(p[field], expected[field]);
    for (let i = 0; i < 6; i++) {
      await page.getByRole('button', { name: '预览', exact: true }).click();
      await jump(1.45);
      await page.getByRole('button', { name: '播放', exact: true }).click();
      await until(1700000);
      await pause();
      await jump(0);
      await page.waitForTimeout(30);
      assert.equal((await native()).active, 0);
    }
    await page.getByRole('button', { name: '编辑', exact: true }).click();
    await save();
    const m = await metrics('reopen');
    assert(m.sounds.buffers <= assets.length);
    return { voices: m.sounds.voices, buffers: m.sounds.buffers, restoredFields: 8 };
  });
  const demo = path.join(root, '示例工程', '第五阶段', '音效与镜头联动.rcproj');
  await fs.mkdir(path.dirname(demo), { recursive: true });
  if (!(await fs.stat(demo).catch(() => null))) {
    await save(demo, true);
    report.demo = demo;
  }
  await check('音效准备较慢时暂停或定位，准备结束后不会自行开始旧播放', async () => {
    await open(projectFile);
    await page.evaluate(() => {
      window.__decodeDelayMs = 600;
    });
    const before = (await native()).starts.at(-1)?.id ?? 0;
    await page.getByRole('button', { name: '播放', exact: true }).click();
    await jump(0.25);
    await page.waitForTimeout(2200);
    await page.evaluate(() => {
      window.__decodeDelayMs = 0;
    });
    assert.equal((await native()).active, 0);
    assert.equal((await native()).starts.at(-1)?.id ?? 0, before);
    assert.equal(await page.getByRole('button', { name: '暂停', exact: true }).count(), 0);
    assert(
      Math.abs(Number(await page.getByTestId('playhead').getAttribute('data-time-us')) - 250000) <
        1,
    );
    return { cancelled: true, playing: false };
  });
  assert.deepEqual(report.errors, []);
  report.passed = true;
} catch (error) {
  report.passed = false;
  report.error = error.stack ?? String(error);
  process.exitCode = 1;
  console.error(report.error);
  if (page && !page.isClosed()) {
    await page.screenshot({ path: path.join(directory, 'failure.png') }).catch(() => {});
    report.dom = await page
      .locator('.status-bar')
      .innerText()
      .catch(() => null);
    report.native = await native().catch(() => null);
  }
} finally {
  report.finishedAt = new Date().toISOString();
  await record();
  if (app) {
    await app.evaluate(({ app }) => app.exit(0)).catch(() => {});
    await app.close().catch(() => {});
  }
  if (path.dirname(profile) === directory && /^profile-\d+$/.test(path.basename(profile)))
    await fs
      .rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 })
      .catch(() => {});
  console.log('REPORT ' + path.join(directory, 'report.json'));
}
