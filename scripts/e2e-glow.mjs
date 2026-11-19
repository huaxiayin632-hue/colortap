import { _electron as electron } from 'playwright';
import { PNG } from 'pngjs';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const directory = path.join(root, 'test-results', 'glow');
await fs.mkdir(directory, { recursive: true });
const profile = path.join(directory, `profile-${Date.now()}`);
const env = { ...process.env, RHYTHM_USER_DATA: profile };
delete env.ELECTRON_RUN_AS_NODE;
delete env.ELECTRON_RENDERER_URL;
const template = JSON.parse(
  await fs.readFile(path.join(root, '示例工程', '节拍练习.rcproj'), 'utf8'),
);
const p = structuredClone(template),
  asset = p.assets[p.music.assetId];
p.id = randomUUID();
p.name = '光环与曲线 · 视觉练习';
p.stage = {
  artworkSize: { width: 1024, height: 768 },
  chartSize: { width: 512, height: 384 },
  playfieldRect: { x: 0, y: 0, width: 1024, height: 768 },
};
p.camera = {
  base: { position: { x: 512, y: 384 }, zoom: 1, rotationRad: 0 },
  keys: {},
  shakes: {},
  enabled: false,
};
p.assets = { [asset.id]: asset };
for (const key of [
  'notes',
  'paths',
  'layers',
  'reveals',
  'sounds',
  'pixelSources',
  'sourceDocuments',
])
  p[key] = {};
p.rootLayersBottomToTop = [];
p.music.gain = 0.35;
const circle = (at, x, y, radius = 36) => {
  const note = {
    id: randomUUID(),
    kind: 'circle',
    at: { basis: 'time', timeUs: at },
    position: { x, y },
    radius,
  };
  p.notes[note.id] = note;
  return note;
};
const a = circle(2e6, 130, 165, 44),
  b = circle(6e6, 245, 130),
  c = circle(8e6, 120, 250);
const curve = {
  id: randomUUID(),
  name: '示意弧线',
  closed: false,
  defaultWidth: 1,
  interpolation: 'bezier',
  nodes: [
    {
      id: randomUUID(),
      point: { x: 390, y: 125 },
      handleIn: { x: 0, y: 0 },
      handleOut: { x: -65, y: 40 },
      mode: 'corner',
    },
    {
      id: randomUUID(),
      point: { x: 320, y: 280 },
      handleIn: { x: -25, y: -70 },
      handleOut: { x: 0, y: 0 },
      mode: 'corner',
    },
  ],
};
const slider = {
  id: randomUUID(),
  kind: 'slider',
  at: { basis: 'time', timeUs: 3e6 },
  duration: { basis: 'time', durationUs: 2e6 },
  headRadius: 28,
  followRadius: 40,
  path: {
    pathId: curve.id,
    transform: {
      position: { x: 0, y: 0 },
      scale: { x: 1, y: 1 },
      rotationRad: 0,
      skewRad: { x: 0, y: 0 },
      pivot: { x: 0, y: 0 },
    },
  },
};
p.paths[curve.id] = curve;
p.notes[slider.id] = slider;
// Preserve editable fixtures; only the dedicated test project is rebuilt on subsequent runs.
const projectDir = path.join(directory, '工程'),
  file = path.join(projectDir, '光环与曲线.rcproj');
await fs.mkdir(path.dirname(path.join(projectDir, asset.relativePath)), { recursive: true });
await fs.copyFile(
  path.join(root, '示例工程', asset.relativePath),
  path.join(projectDir, asset.relativePath),
);
await fs.writeFile(file, JSON.stringify(p, null, 2));
const report = {
  checks: [],
  errors: [],
  limitations: [
    'Actual Electron renderer, audio clock, mouse and keyboard. Only native file-picker answers are substituted.',
    'Pen editing and Perfect/Slider feedback are verified here and in e2e-chart. Audio analysis, default sound slots and independent screen effects remain separate stages.',
  ],
};
let app, page;
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
    () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))),
  );
}
async function jump(seconds) {
  await page.getByLabel('定位到秒', { exact: true }).fill(String(seconds));
  await page.getByLabel('定位到秒', { exact: true }).press('Tab');
  await frames();
}
async function screen(at) {
  const view = await page.getByTestId('canvas-host').evaluate((el) => ({
    z: Number(el.dataset.zoom),
    x: Number(el.dataset.panX),
    y: Number(el.dataset.panY),
  }));
  const box = await page.getByTestId('pixi-canvas').boundingBox();
  return { x: box.x + view.x + at.x * 2 * view.z, y: box.y + view.y + at.y * 2 * view.z };
}
async function move(at) {
  const pos = await screen(at);
  await page.mouse.move(pos.x, pos.y);
}
async function shot(name) {
  const a = await screen({ x: 0, y: 0 }),
    b = await screen({ x: 512, y: 384 });
  await page.screenshot({
    path: path.join(directory, `${name}.png`),
    animations: 'allow',
    clip: { x: a.x, y: a.y, width: b.x - a.x, height: b.y - a.y },
  });
}
async function metrics(name) {
  const out = path.join(directory, `${name}.json`);
  await choose(out, true);
  await page.getByRole('button', { name: '查看运行记录', exact: true }).click();
  await page.getByRole('button', { name: '保存性能记录', exact: true }).click();
  await page.locator('.editor-shell[aria-busy=false]').waitFor();
  await page.getByRole('button', { name: '关闭运行记录', exact: true }).click();
  return JSON.parse(await fs.readFile(out, 'utf8'));
}
async function until(at) {
  await page.waitForFunction(
    (at) =>
      Number(document.querySelector('[data-testid=playhead]')?.getAttribute('data-time-us')) >= at,
    at,
    { polling: 'raf', timeout: 10000 },
  );
}
const time = async () => Number(await page.getByTestId('playhead').getAttribute('data-time-us'));
async function check(name, fn) {
  try {
    const evidence = await fn();
    report.checks.push({ name, passed: true, evidence });
    console.log(`PASS ${name}`);
  } catch (e) {
    report.checks.push({ name, passed: false, error: String(e) });
    throw e;
  }
}
const samples = [];
let length = 0;
for (let i = 0; i <= 2000; i++) {
  const u = i / 2000,
    v = 1 - u;
  const pos = {
    x: v ** 3 * 390 + 3 * v * v * u * 325 + 3 * v * u * u * 295 + u ** 3 * 320,
    y: v ** 3 * 125 + 3 * v * v * u * 165 + 3 * v * u * u * 210 + u ** 3 * 280,
  };
  if (samples.length) length += Math.hypot(pos.x - samples.at(-1).x, pos.y - samples.at(-1).y);
  samples.push({ ...pos, length });
}
const follow = (progress) =>
  samples.find((p) => p.length >= Math.max(0, Math.min(1, progress)) * length) ?? samples.at(-1);
try {
  app = await electron.launch({ args: [root], cwd: root, env });
  page = await app.firstWindow();
  page.setDefaultTimeout(20000);
  page.on('pageerror', (e) => report.errors.push(String(e)));
  await page.getByTestId('pixi-canvas').waitFor();
  await page.locator('.editor-shell[aria-busy=false]').waitFor();
  await app.evaluate(({ BrowserWindow }) => {
    const w = BrowserWindow.getAllWindows()[0];
    w.setSize(1500, 980);
    w.show();
    w.focus();
  });
  await page.bringToFront();
  await choose(file);
  await page.getByRole('button', { name: '打开', exact: true }).click();
  await page.locator('[data-testid=waveform][data-ready=true]').waitFor();
  await page.getByRole('button', { name: '适合窗口', exact: true }).click();
  await check('预览：发光圆环、曲线与 Perfect 窗口内的实心中心光点', async () => {
    await page.getByRole('button', { name: '预览', exact: true }).click();
    await jump(1.96);
    await shot('circle-slider');
    await page.screenshot({ path: path.join(directory, 'editor.png') });
    const record = await metrics('preview');
    assert.equal(record.graphics.chart.visibleNotes, 2);
    assert.equal(record.graphics.chart.particles, 0);
    const canvas = page.getByTestId('pixi-canvas'),
      box = await canvas.boundingBox();
    const png = PNG.sync.read(await canvas.screenshot());
    const center = await screen(a.position);
    const x = Math.round(((center.x - box.x) * png.width) / box.width),
      y = Math.round(((center.y - box.y) * png.height) / box.height);
    const rgb = [...png.data.subarray((y * png.width + x) * 4, (y * png.width + x) * 4 + 3)];
    assert.ok(
      rgb.every((v) => v > 210),
      `Perfect center is missing: ${rgb}`,
    );
    return { chart: record.graphics.chart, center: rgb };
  });
  await check('试玩：中心提示精确覆盖 Perfect 前后边界，修改窗口及撤销同步生效', async () => {
    await page.getByRole('button', { name: '试玩', exact: true }).click();
    const samples = [];
    for (const [seconds, expected] of [
      [1.949999, false],
      [1.95, true],
      [2.05, true],
      [2.050001, false],
    ]) {
      await jump(seconds);
      const record = await metrics(`perfect-${seconds}`),
        appearance = record.graphics.chart.appearances.find((v) => v.id === a.id),
        canvas = page.getByTestId('pixi-canvas'),
        box = await canvas.boundingBox(),
        png = PNG.sync.read(await canvas.screenshot()),
        pos = await screen(a.position),
        x = Math.round(((pos.x - box.x) * png.width) / box.width),
        y = Math.round(((pos.y - box.y) * png.height) / box.height),
        rgb = [...png.data.subarray((y * png.width + x) * 4, (y * png.width + x) * 4 + 3)];
      assert.equal(appearance.perfect, expected);
      assert.ok(
        expected ? rgb.every((v) => v > 210) : rgb.every((v) => v < 90),
        `${seconds}: ${rgb}`,
      );
      samples.push({ seconds, perfect: appearance.perfect, center: rgb });
    }
    await jump(2.02);
    await shot('perfect-center');
    await page.getByRole('button', { name: '编辑', exact: true }).click();
    const input = page.getByLabel('Perfect 窗口', { exact: true });
    await input.fill('25');
    await input.press('Tab');
    await page.getByRole('button', { name: '试玩', exact: true }).click();
    await jump(1.96);
    assert.equal(
      (await metrics('perfect-25ms')).graphics.chart.appearances.find((v) => v.id === a.id).perfect,
      false,
    );
    await page.getByRole('button', { name: '编辑', exact: true }).click();
    await page.getByRole('button', { name: '撤销', exact: true }).click();
    assert.equal(await input.inputValue(), '50');
    await page.getByRole('button', { name: '预览', exact: true }).click();
    await jump(1.96);
    assert.equal(
      (await metrics('perfect-restored')).graphics.chart.appearances.find((v) => v.id === a.id)
        .perfect,
      true,
    );
    return { boundaries: samples, changedWindowMs: 25, undoRestoredMs: 50 };
  });
  await check('预览：收缩与粒子独立收尾、暂停稳定、定位重建', async () => {
    await jump(2.07);
    await shot('circle-hit');
    const first = await metrics('hit');
    assert.ok(first.graphics.chart.particles > 0);
    await frames();
    const again = await metrics('hit-paused');
    assert.deepEqual(again.graphics.chart, first.graphics.chart);
    await jump(2.28);
    await shot('particle-tail');
    assert.ok((await metrics('tail')).graphics.chart.particles > 0);
    await jump(2.5);
    assert.equal((await metrics('settled')).graphics.chart.particles, 0);
    await jump(2.07);
    assert.deepEqual((await metrics('hit-seek')).graphics.chart, first.graphics.chart);
    return { hit: first.graphics.chart, pausedTime: again.audio.timeUs };
  });
  await check('Slider 预览：光环与烟花粒子，暂停冻结及向后定位重建', async () => {
    await jump(3.67);
    await shot('slider-fireworks');
    const first = await metrics('slider-fireworks'),
      count = first.graphics.chart.particles;
    assert.ok(count > 0 && count <= 192);
    const png = PNG.sync.read(await page.getByTestId('pixi-canvas').screenshot());
    await frames();
    assert.deepEqual((await metrics('slider-frozen')).graphics.chart, first.graphics.chart);
    const again = PNG.sync.read(await page.getByTestId('pixi-canvas').screenshot());
    assert.deepEqual(again.data, png.data);
    await jump(3.2);
    await jump(3.67);
    assert.deepEqual((await metrics('slider-rebuilt')).graphics.chart, first.graphics.chart);
    return { particles: count, identicalPausedPixels: true, identicalAfterSeek: true };
  });
  await check('实际鼠标命中：使用真实判定触发粒子，向后定位清除未来反馈', async () => {
    await page.getByRole('button', { name: '试玩', exact: true }).click();
    await jump(1.6);
    await move(a.position);
    await page.getByRole('button', { name: '播放', exact: true }).click();
    await move(a.position);
    await until(1.98e6);
    await page.mouse.down();
    await page.mouse.up();
    await page.keyboard.press('Space');
    await frames();
    const status = await page
      .locator(`.result-item[data-note-id="${a.id}"]`)
      .getAttribute('data-result');
    assert.ok(['perfect', 'good'].includes(status), status);
    await shot('actual-hit');
    const record = await metrics('actual-hit');
    assert.ok(record.graphics.chart.particles > 0, JSON.stringify(record.graphics.chart));
    await jump(1.6);
    assert.equal((await metrics('rewind')).graphics.chart.particles, 0);
    return { status, time: record.audio.timeUs, chart: record.graphics.chart };
  });
  await check('实际漏点：淡出且没有成功粒子', async () => {
    await page.getByRole('button', { name: '从头试玩', exact: true }).click();
    await until(2.14e6);
    await page.keyboard.press('Space');
    await frames();
    assert.equal(
      await page.locator(`.result-item[data-note-id="${a.id}"]`).getAttribute('data-result'),
      'miss',
    );
    const record = await metrics('miss');
    assert.equal(record.graphics.chart.particles, 0);
    await shot('miss');
    return record.graphics.chart;
  });
  await check('真实曲线追踪：小光点按弧长移动，暂停冻结、继续完成', async () => {
    await jump(2.6);
    await move(curve.nodes[0].point);
    await page.getByRole('button', { name: '播放', exact: true }).click();
    await move(curve.nodes[0].point);
    await until(2.98e6);
    await page.keyboard.down('z');
    while ((await time()) < 3.8e6) await move(follow(((await time()) - 3e6) / 2e6));
    await page.keyboard.press('Space');
    await page.keyboard.up('z');
    await frames();
    await shot('slider-follow');
    const record = await metrics('slider-paused'),
      paused = await time();
    await frames();
    assert.equal(await time(), paused);
    await move(follow((paused - 3e6) / 2e6));
    await page.getByRole('button', { name: '播放', exact: true }).click();
    await move(follow((paused - 3e6) / 2e6));
    await page.keyboard.down('z');
    while ((await time()) < 5.03e6) await move(follow(((await time()) - 3e6) / 2e6));
    await page.keyboard.up('z');
    await page.keyboard.press('Space');
    assert.equal(
      await page.locator(`.result-item[data-note-id="${slider.id}"]`).getAttribute('data-result'),
      'complete',
    );
    return {
      paused: record.audio.timeUs,
      result: await page.locator(`.result-item[data-note-id="${slider.id}"]`).innerText(),
    };
  });
  await check('中途松键：追踪中断并失败，不产生完成反馈', async () => {
    await jump(2.6);
    await move(curve.nodes[0].point);
    await page.getByRole('button', { name: '播放', exact: true }).click();
    await move(curve.nodes[0].point);
    await until(2.98e6);
    await page.keyboard.down('x');
    while ((await time()) < 3.3e6) await move(follow(((await time()) - 3e6) / 2e6));
    await page.keyboard.up('x');
    await until(3.5e6);
    await page.keyboard.press('Space');
    await shot('slider-break');
    assert.equal(await page.getByTestId('tracking-status').getAttribute('data-valid'), 'false');
    await page.getByRole('button', { name: '播放', exact: true }).click();
    await until(3.75e6);
    await page.keyboard.press('Space');
    assert.equal((await metrics('slider-no-new-sparks')).graphics.chart.particles, 0);
    await page.getByRole('button', { name: '播放', exact: true }).click();
    await until(5.06e6);
    await page.keyboard.press('Space');
    assert.equal(
      await page.locator(`.result-item[data-note-id="${slider.id}"]`).getAttribute('data-result'),
      'failed',
    );
    return { result: await page.locator(`.result-item[data-note-id="${slider.id}"]`).innerText() };
  });
  await check('保存与重开：原判定半径和曲线数据完整，演示工程可直接播放', async () => {
    await page.getByRole('button', { name: '编辑', exact: true }).click();
    const demoDir = path.join(root, '示例工程', '光环与曲线'),
      demoFile = path.join(demoDir, '光环与曲线.rcproj');
    await fs.mkdir(demoDir, { recursive: true });
    let destination = demoFile;
    try {
      await fs.access(demoFile);
      destination = path.join(projectDir, '重开检查.rcproj');
    } catch {}
    await choose(destination, true);
    await page.getByRole('button', { name: '另存为', exact: true }).click();
    await page.locator('.editor-shell[aria-busy=false]').waitFor();
    await page.waitForFunction(
      (destination) => document.querySelector('.save-state')?.getAttribute('title') === destination,
      destination,
    );
    await page.waitForFunction(
      () => document.querySelector('.save-state')?.textContent?.trim() === '已保存',
    );
    const saved = JSON.parse(await fs.readFile(destination, 'utf8'));
    assert.deepEqual(saved.notes, p.notes);
    assert.deepEqual(saved.paths, p.paths);
    await choose(destination);
    await page.getByRole('button', { name: '打开', exact: true }).click();
    await page.locator('[data-testid=waveform][data-ready=true]').waitFor();
    await page.getByRole('button', { name: '预览', exact: true }).click();
    await jump(1.96);
    await shot('reopened');
    return {
      file: destination,
      notes: Object.keys(saved.notes).length,
      paths: Object.keys(saved.paths).length,
    };
  });
  await check('录制正式画布中的完整视觉演示', async () => {
    await jump(0.5);
    const a = await screen({ x: 0, y: 0 }),
      b = await screen({ x: 512, y: 384 });
    const bounds = await page.getByTestId('pixi-canvas').boundingBox();
    await page.evaluate(
      ({ a, b, bounds }) => {
        const source = document.querySelector('[data-testid=pixi-canvas]'),
          output = document.createElement('canvas');
        const ratio = source.width / bounds.width;
        output.width = Math.round(((b.x - a.x) * ratio) / 2) * 2;
        output.height = Math.round(((b.y - a.y) * ratio) / 2) * 2;
        const ctx = output.getContext('2d'),
          stream = output.captureStream(60),
          chunks = [];
        const recorder = new MediaRecorder(stream, {
          mimeType: 'video/webm;codecs=vp9',
          videoBitsPerSecond: 3000000,
        });
        let frame;
        const draw = () => {
          ctx.drawImage(
            source,
            (a.x - bounds.x) * ratio,
            (a.y - bounds.y) * ratio,
            output.width,
            output.height,
            0,
            0,
            output.width,
            output.height,
          );
          frame = requestAnimationFrame(draw);
        };
        recorder.ondataavailable = (e) => {
          if (e.data.size) chunks.push(e.data);
        };
        window.glowRecording = {
          recorder,
          done: new Promise((resolve) => {
            recorder.onstop = async () => {
              cancelAnimationFrame(frame);
              stream.getTracks().forEach((t) => t.stop());
              const bytes = new Uint8Array(await new Blob(chunks).arrayBuffer());
              let text = '';
              for (let i = 0; i < bytes.length; i += 8192)
                text += String.fromCharCode(...bytes.subarray(i, i + 8192));
              resolve(btoa(text));
            };
          }),
        };
        draw();
        recorder.start();
      },
      { a, b, bounds },
    );
    await page.getByRole('button', { name: '播放', exact: true }).click();
    await until(9.2e6);
    const encoded = await page.evaluate(async () => {
      window.glowRecording.recorder.stop();
      return await window.glowRecording.done;
    });
    await page.getByRole('button', { name: '暂停', exact: true }).click();
    const webm = path.join(directory, '光环与曲线预览.webm'),
      mp4 = path.join(directory, '光环与曲线预览.mp4');
    await fs.writeFile(webm, Buffer.from(encoded, 'base64'));
    execFileSync(
      process.env.FFMPEG_PATH ?? 'ffmpeg',
      [
        '-y',
        '-v',
        'error',
        '-i',
        webm,
        '-c:v',
        'libx264',
        '-crf',
        '19',
        '-pix_fmt',
        'yuv420p',
        '-movflags',
        '+faststart',
        mp4,
      ],
      { windowsHide: true },
    );
    return { file: mp4, bytes: (await fs.stat(mp4)).size, mode: 'preview', audio: false };
  });
  assert.deepEqual(report.errors, []);
  report.passed = true;
} catch (e) {
  report.passed = false;
  report.error = e.stack ?? String(e);
  console.error(report.error);
  await page?.screenshot({ path: path.join(directory, 'failure.png') }).catch(() => {});
  process.exitCode = 1;
} finally {
  await fs.writeFile(path.join(directory, 'report.json'), JSON.stringify(report, null, 2));
  if (app) {
    await app.evaluate(({ app }) => app.exit(0)).catch(() => {});
    await app.close().catch(() => {});
  }
  const resolved = path.resolve(profile);
  if (
    path.dirname(resolved) !== path.resolve(directory) ||
    !/^profile-\d+$/.test(path.basename(resolved))
  )
    throw Error('Unsafe test profile path');
  await fs.rm(resolved, { recursive: true, force: true });
}
console.log(`Glow: ${report.checks.filter((c) => c.passed).length}/${report.checks.length}`);
