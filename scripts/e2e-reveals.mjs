import { _electron as electron } from 'playwright';
import { PNG } from 'pngjs';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { smallFixtures } from './image-fixtures.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const directory = path.join(root, 'test-results', 'stage4');
await fs.mkdir(directory, { recursive: true });
const fixture = await smallFixtures(path.join(directory, 'fixtures'));
const realPSD = process.env.RHYTHM_TEST_PSD ?? 'C:\\Users\\00\\Pictures\\灰泽满\\插画53 多图层.psd';
await fs.access(realPSD);
const environment = {
  ...process.env,
  RHYTHM_USER_DATA: path.join(directory, `profile-${Date.now()}`),
};
delete environment.ELECTRON_RUN_AS_NODE;
delete environment.ELECTRON_RENDERER_URL;
const report = {
  stage: 4,
  startedAt: new Date().toISOString(),
  checks: [],
  consoleErrors: [],
  measurements: {},
  limitations: [
    'The named production PSD is decoded through the real importer. Synthetic PNG pixels are separately used for exact six-effect mask assertions.',
    'Only native file-picker return paths are substituted. Actual filesystem, audio clock, mouse/keyboard judgement and Pixi rendering are used.',
    'Measured managed RGBA bytes exclude graphics-driver memory and internal Pixi render targets. FPS is a short local sample, not a stable 60 FPS claim.',
  ],
};
let app, page, saved, circles, slider, pathClip;
const projectFile = path.join(directory, '工程', '真实PSD演出.rcproj');
function makeWav() {
  const rate = 24000,
    frames = rate * 16,
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
    const age = (i / rate) % 0.5;
    b.writeInt16LE(
      Math.round(Math.sin(age * Math.PI * 2 * 880) * Math.exp(-age * 50) * 4000),
      44 + i * 2,
    );
  }
  return b;
}
const music = path.join(directory, '120BPM.wav');
await fs.writeFile(music, makeWav());
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
async function settled() {
  await page.locator('.editor-shell[aria-busy=false]').waitFor();
}
async function frames() {
  await page.evaluate(
    () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
  );
}
async function property(label, value) {
  const l = page.getByLabel(label, { exact: true });
  await l.fill(String(value));
  await l.press('Tab');
  await frames();
}
async function jump(seconds) {
  await property('定位到秒', seconds);
}
async function save(file, as = false) {
  await choose(file, true);
  await page.getByRole('button', { name: as ? '另存为' : '保存', exact: true }).click();
  await settled();
  await page.waitForFunction(
    () => document.querySelector('.save-state')?.textContent?.trim() === '已保存',
  );
  saved = JSON.parse(await fs.readFile(file, 'utf8'));
  return saved;
}
async function open(file) {
  await choose(file);
  await page.getByRole('button', { name: '打开', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '未保存的修改', exact: true });
  if (await dialog.count())
    await page.getByRole('button', { name: '放弃修改', exact: true }).click();
  await settled();
  await frames();
}
async function importImage(file) {
  await choose(file);
  await page.getByRole('button', { name: '＋ 导入 PSD / PNG', exact: true }).click();
  await page
    .getByRole('dialog', { name: '图片导入进度', exact: true })
    .waitFor({ state: 'hidden', timeout: 600000 });
  await settled();
  if (await page.getByRole('dialog', { name: 'PSD 兼容提示', exact: true }).count())
    await page.getByRole('button', { name: '返回编辑', exact: true }).click();
  await textures();
}
async function textures() {
  await page.waitForFunction(
    () =>
      Number(document.querySelector('[data-testid=canvas-host]')?.getAttribute('data-loading')) ===
      0,
  );
  await frames();
}
async function history() {
  await page.getByRole('button', { name: '撤销', exact: true }).click();
  await settled();
  await frames();
}
function map(p) {
  const r = p.stage.playfieldRect,
    s = p.stage.artworkSize,
    c = p.stage.chartSize,
    x = Math.max(0, r.x),
    y = Math.max(0, r.y),
    w = Math.min(s.width, r.x + r.width) - x,
    h = Math.min(s.height, r.y + r.height) - y,
    scale = Math.min(w / c.width, h / c.height);
  return { scale, x: x + (w - c.width * scale) / 2, y: y + (h - c.height * scale) / 2 };
}
async function screen(p, chart = true) {
  const m = chart ? map(saved) : { scale: 1, x: 0, y: 0 };
  const v = await page.getByTestId('canvas-host').evaluate((el) => ({
    z: Number(el.dataset.zoom),
    x: Number(el.dataset.panX),
    y: Number(el.dataset.panY),
  }));
  const b = await page.getByTestId('pixi-canvas').boundingBox();
  return { x: b.x + v.x + (m.x + p.x * m.scale) * v.z, y: b.y + v.y + (m.y + p.y * m.scale) * v.z };
}
async function click(p, chart = true) {
  const a = await screen(p, chart);
  await page.mouse.click(a.x, a.y);
  await frames();
}
async function drag(a, b, chart = true) {
  a = await screen(a, chart);
  b = await screen(b, chart);
  await page.mouse.move(a.x, a.y);
  await page.mouse.down();
  await page.mouse.move(b.x, b.y, { steps: 12 });
  await page.mouse.up();
  await frames();
}
async function bind(noteId, layerId, kind) {
  const details = page.locator('details.reveal-add');
  if ((await details.getAttribute('open')) === null) await details.locator('summary').click();
  await page.getByLabel('新绑定音符', { exact: true }).selectOption(noteId);
  await page.getByLabel('新绑定图层', { exact: true }).selectOption(layerId);
  await page.getByLabel('新绑定显现方式', { exact: true }).selectOption(kind);
  await page.getByRole('button', { name: '添加显现绑定', exact: true }).click();
  await frames();
  return await page.getByTestId('reveal-state').getAttribute('data-reveal-id');
}
async function selectClip(id) {
  await page.locator(`.reveal-list button[data-reveal-id="${id}"]`).click();
  await frames();
}
async function revealState() {
  return page.getByTestId('reveal-state').evaluate((el) => ({
    id: el.dataset.revealId,
    clip: el.dataset.clipId,
    progress: Number(el.dataset.progress),
    alpha: Number(el.dataset.alpha),
    started: el.dataset.started === 'true',
  }));
}
async function progressPercent(percent) {
  await page.getByLabel('显现预览进度', { exact: true }).fill(String(percent));
  await frames();
  await textures();
}
async function rgb(p) {
  const b = await page.getByTestId('pixi-canvas').boundingBox(),
    at = await screen(p, false),
    png = PNG.sync.read(await page.getByTestId('pixi-canvas').screenshot());
  const x = Math.round(((at.x - b.x) * png.width) / b.width),
    y = Math.round(((at.y - b.y) * png.height) / b.height),
    i = (y * png.width + x) * 4;
  return [...png.data.subarray(i, i + 3)];
}
async function timeUs() {
  return Number(await page.getByTestId('playhead').getAttribute('data-time-us'));
}
async function until(at) {
  await page.waitForFunction(
    (at) =>
      Number(document.querySelector('[data-testid=playhead]')?.getAttribute('data-time-us')) >= at,
    at,
    { timeout: 20000 },
  );
}
async function pause() {
  if (await page.getByRole('button', { name: '暂停', exact: true }).isEnabled())
    await page.getByRole('button', { name: '暂停', exact: true }).click();
  await frames();
}
async function result(id, status) {
  await page
    .locator(`.result-item[data-note-id="${id}"][data-result="${status}"]`)
    .waitFor({ state: 'attached', timeout: 3000 });
}
async function moveTo(p) {
  const a = await screen(p);
  await page.mouse.move(a.x, a.y);
}
// Independent dense cubic sampling, never reading a rendered ball or mocking a hit.
function samplePath(note, p) {
  const path = p.paths[note.path.pathId],
    t = note.path.transform,
    points = [];
  let length = 0;
  const tx = (v) => ({
    x:
      (v.x - t.pivot.x) * Math.cos(t.rotationRad) * t.scale.x -
      (v.y - t.pivot.y) * Math.sin(t.rotationRad) * t.scale.y +
      t.position.x,
    y:
      (v.x - t.pivot.x) * Math.sin(t.rotationRad) * t.scale.x +
      (v.y - t.pivot.y) * Math.cos(t.rotationRad) * t.scale.y +
      t.position.y,
  });
  for (let i = 1; i < path.nodes.length; i++) {
    const a = path.nodes[i - 1],
      d = path.nodes[i],
      b = { x: a.point.x + a.handleOut.x, y: a.point.y + a.handleOut.y },
      c = { x: d.point.x + d.handleIn.x, y: d.point.y + d.handleIn.y };
    for (let j = 0; j <= 500; j++) {
      const u = j / 500,
        v = 1 - u,
        p = tx(
          path.interpolation === 'polyline'
            ? { x: a.point.x * v + d.point.x * u, y: a.point.y * v + d.point.y * u }
            : {
                x:
                  v ** 3 * a.point.x +
                  3 * v * v * u * b.x +
                  3 * v * u * u * c.x +
                  u ** 3 * d.point.x,
                y:
                  v ** 3 * a.point.y +
                  3 * v * v * u * b.y +
                  3 * v * u * u * c.y +
                  u ** 3 * d.point.y,
              },
        ),
        prev = points.at(-1);
      if (prev) length += Math.hypot(p.x - prev.x, p.y - prev.y);
      points.push({ ...p, length });
    }
  }
  return (progress) => {
    const d = Math.max(0, Math.min(1, note.path.reversed ? 1 - progress : progress)) * length;
    let i = 1;
    while (i < points.length - 1 && points[i].length < d) i++;
    const a = points[i - 1],
      b = points[i],
      u = (d - a.length) / Math.max(1e-9, b.length - a.length);
    return { x: a.x + (b.x - a.x) * u, y: a.y + (b.y - a.y) * u };
  };
}
async function followTo(evaluate, start, end) {
  while ((await timeUs()) < end) {
    const now = await timeUs();
    await moveTo(evaluate((now - start) / 2000000));
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
async function metrics(file) {
  await choose(file, true);
  await page.getByRole('button', { name: '查看运行记录', exact: true }).click();
  await page.getByRole('button', { name: '保存性能记录', exact: true }).click();
  await settled();
  await page.getByRole('button', { name: '关闭运行记录', exact: true }).click();
  return JSON.parse(await fs.readFile(file, 'utf8'));
}

try {
  app = await electron.launch({ args: [root], cwd: root, env: environment });
  page = await app.firstWindow();
  page.setDefaultTimeout(30000);
  page.on('pageerror', (e) => report.consoleErrors.push(String(e)));
  page.on('console', (m) => {
    if (m.type() === 'error') report.consoleErrors.push(m.text());
  });
  await page.getByTestId('pixi-canvas').waitFor();
  await settled();
  await check('导入指定的真实美术 PSD，保持原尺寸、嵌套分组、图层引用及音乐', async () => {
    await importImage(realPSD);
    await save(projectFile);
    assert.deepEqual(saved.stage.artworkSize, { width: 6111, height: 3700 });
    assert.ok(Object.values(saved.layers).filter((l) => l.kind === 'raster').length >= 20);
    assert.ok(
      Object.values(saved.layers).some(
        (l) =>
          l.kind === 'group' &&
          l.childrenBottomToTop.some((id) => saved.layers[id].kind === 'group'),
      ),
    );
    // This production PSD contains a duplicate leg variant, which would cover the animated layer. Hide only that logical variant.
    while (await page.locator('.layer-row[aria-expanded=false] button.tree-toggle').count())
      await page.locator('.layer-row[aria-expanded=false] button.tree-toggle').first().click();
    const duplicate = Object.values(saved.layers).find((l) => l.name.trim() === 'leg-l 2');
    await page.locator(`.layer-row[data-layer-id="${duplicate.id}"] button`).nth(0).click();
    await choose(music);
    await page.getByRole('button', { name: '导入音乐', exact: true }).first().click();
    await settled();
    await page.locator('[data-testid=waveform][data-ready=true]').waitFor();
    await save(projectFile);
    await page.screenshot({ path: path.join(directory, 'real-psd-import.png') });
    const perf = await metrics(path.join(directory, 'real-import-performance.json'));
    report.measurements.realImport = perf.lastImageImport;
    return {
      size: saved.stage.artworkSize,
      rasterLayers: Object.values(saved.layers).filter((l) => l.kind === 'raster').length,
      groups: Object.values(saved.layers).filter((l) => l.kind === 'group').length,
      warnings: Object.values(saved.sourceDocuments).flatMap((s) => s.warnings ?? []),
    };
  });
  await check(
    '画布创建三个 Circle、一条弯曲 Slider，并在界面绑定 Instant、Fade、Pop 和 Path Reveal',
    async () => {
      for (let i = 0; i < 3; i++) {
        await jump(1.5 + i);
        await page.getByRole('button', { name: 'Circle 工具', exact: true }).click();
        await click({ x: [90, 205, 420][i], y: 90 });
      }
      await jump(5);
      await page.getByRole('button', { name: 'Slider 工具', exact: true }).click();
      await drag({ x: 240, y: 160 }, { x: 220, y: 230 });
      await click({ x: 310, y: 350 });
      await page.getByRole('button', { name: '完成 Slider', exact: true }).click();
      await property('Slider 持续秒数', 2);
      await save(projectFile);
      circles = Object.values(saved.notes)
        .filter((n) => n.kind === 'circle')
        .sort((a, b) => a.at.tick - b.at.tick);
      slider = Object.values(saved.notes).find((n) => n.kind === 'slider');
      const find = (name) => Object.values(saved.layers).find((l) => l.name.trim() === name).id;
      const ids = [];
      for (const [i, name, kind] of [
        [0, 'hair_back_r', 'instant'],
        [1, 'glasses', 'fade'],
        [2, 'ribbon', 'pop'],
      ])
        ids.push(await bind(circles[i].id, find(name), kind));
      pathClip = await bind(slider.id, find('leg-l'), 'path');
      await page.getByLabel('复制关联 Slider', { exact: true }).selectOption(slider.id);
      await page.getByRole('button', { name: '复制 Slider 路径', exact: true }).click();
      await property('显现遮罩宽度', 650);
      await page.getByLabel('显现缓动', { exact: true }).selectOption('linear');
      await save(projectFile);
      assert.equal(Object.keys(saved.reveals).length, 4);
      assert.ok(saved.reveals[pathClip].effect.path.pathId !== slider.path.pathId);
      await page.screenshot({ path: path.join(directory, 'real-bindings.png') });
      return { circleBindings: ids, pathClip };
    },
  );
  await check(
    '独立显现路径节点/控制柄可编辑，复制不影响 Slider，关联与解除关联可撤销',
    async () => {
      const source = JSON.stringify(saved.paths[slider.path.pathId]);
      await page.getByRole('button', { name: '编辑显现路径', exact: true }).click();
      const m = map(saved),
        a = { x: m.x + 240 * m.scale, y: m.y + 160 * m.scale },
        b = { x: a.x - 100, y: a.y + 70 };
      await drag(a, b, false);
      await page.getByRole('button', { name: '结束显现路径编辑', exact: true }).click();
      await save(projectFile);
      assert.equal(JSON.stringify(saved.paths[slider.path.pathId]), source);
      await page.getByRole('button', { name: '关联 Slider 路径', exact: true }).click();
      await save(projectFile);
      assert.equal(saved.reveals[pathClip].effect.linkedSliderId, slider.id);
      await page.getByRole('button', { name: '解除关联', exact: true }).click();
      await save(projectFile);
      assert.equal(saved.reveals[pathClip].effect.linkedSliderId, undefined);
      await history();
      await save(projectFile);
      assert.equal(saved.reveals[pathClip].effect.linkedSliderId, slider.id);
      await page.getByRole('button', { name: '解除关联', exact: true }).click();
      await page.getByRole('button', { name: '独立绘制路径', exact: true }).click();
      for (const p of [
        { x: 2800, y: 1700 },
        { x: 2700, y: 2400 },
        { x: 3100, y: 3500 },
      ])
        await click(p, false);
      await page.keyboard.press('Enter');
      await page.getByRole('button', { name: '结束显现路径编辑', exact: true }).click();
      await save(projectFile);
      assert.equal(saved.paths[saved.reveals[pathClip].effect.path.pathId].nodes.length, 3);
      await page.screenshot({ path: path.join(directory, 'real-path-editor.png') });
      return {
        independentNodes: 3,
        sliderUnchanged: JSON.stringify(saved.paths[slider.path.pathId]) === source,
      };
    },
  );
  await check('同一 Circle 可绑定多个图层，图层演出轨道可编辑延迟和时长并撤销', async () => {
    const arm = Object.values(saved.layers).find((l) => l.name.trim() === 'arm-r');
    await bind(circles[0].id, arm.id, 'fade');
    assert.equal(await page.locator('.reveal-list .reveal-select').count(), 5);
    await history();
    assert.equal(await page.locator('.reveal-list .reveal-select').count(), 4);
    const fade = Object.values(saved.reveals).find((c) => c.effect.kind === 'fade');
    const bar = page.locator(`.timeline-reveal[data-reveal-id="${fade.id}"]`);
    await bar.scrollIntoViewIfNeeded();
    let b = await bar.boundingBox();
    await page.mouse.move(b.x + 15, b.y + b.height / 2);
    await page.mouse.down();
    await page.mouse.move(b.x + 37, b.y + b.height / 2, { steps: 8 });
    await page.mouse.up();
    await frames();
    assert.equal(Number(await bar.getAttribute('data-time-us')), 3000000);
    await history();
    assert.equal(Number(await bar.getAttribute('data-time-us')), 2500000);
    const handle = bar.locator('.duration-handle');
    b = await handle.boundingBox();
    await page.mouse.move(b.x + 4, b.y + 8);
    await page.mouse.down();
    await page.mouse.move(b.x + 26, b.y + 8, { steps: 8 });
    await page.mouse.up();
    await frames();
    assert.equal(Number(await bar.getAttribute('data-end-us')), 3500000);
    await history();
    assert.equal(Number(await bar.getAttribute('data-end-us')), 3000000);
    await selectClip(pathClip);
    return { sameCircleMultipleLayers: true, draggedDelayUs: 500000, draggedDurationUs: 1000000 };
  });
  await check('Preview 随机跳转恢复六秒半程及 Circle 显现，不需要先播放', async () => {
    await page.getByRole('button', { name: '预览', exact: true }).click();
    await jump(6);
    await selectClip(pathClip);
    assert.ok(Math.abs((await revealState()).progress - 0.5) < 0.001);
    const states = [];
    for (const t of [7.5, 5.25, 6, 0, 6.5]) {
      await jump(t);
      states.push(await revealState());
    }
    assert.ok(states[0].progress === 1);
    assert.ok(states[1].progress < 0.2);
    assert.equal(states[3].started, false);
    assert.ok(Math.abs(states[4].progress - 0.75) < 0.001);
    await page.screenshot({ path: path.join(directory, 'real-timeline-half.png') });
    await page.getByRole('button', { name: '播放', exact: true }).click();
    await until(7000000);
    await pause();
    return states;
  });
  await check(
    'Playtest 未点击 Circle 不会触发图层，Slider 完成事件可作为后续触发条件',
    async () => {
      await page.getByRole('button', { name: '试玩', exact: true }).click();
      await jump(0);
      const instant = Object.values(saved.reveals).find((c) => c.effect.kind === 'instant');
      await selectClip(instant.id);
      await page.getByRole('button', { name: '播放', exact: true }).click();
      await until(1800000);
      await pause();
      await result(circles[0].id, 'miss');
      assert.equal((await revealState()).started, false);
      await page.getByRole('button', { name: '编辑', exact: true }).click();
      await selectClip(pathClip);
      await page.getByLabel('显现触发条件', { exact: true }).selectOption('slider-complete');
      await save(projectFile);
      assert.equal(saved.reveals[pathClip].trigger.event, 'slider-complete');
      await history();
      await save(projectFile);
      assert.equal(saved.reveals[pathClip].trigger.event, 'slider-start');
      return { missRevealed: false, completionTriggerSaved: true };
    },
  );
  await check('Playtest 实际点击三个 Circle，分别触发对应图层', async () => {
    await page.getByRole('button', { name: '试玩', exact: true }).click();
    await jump(0);
    await page.getByRole('button', { name: '播放', exact: true }).click();
    for (let i = 0; i < 3; i++) {
      const at = 1500000 + i * 1000000;
      await moveTo(circles[i].position);
      await until(at - 15000);
      await page.keyboard.down('z');
      await page.keyboard.up('z');
    }
    await until(4000000);
    await pause();
    for (const n of circles) {
      const status = await page
        .locator(`.result-item[data-note-id="${n.id}"]`)
        .getAttribute('data-result');
      assert.ok(['perfect', 'good'].includes(status), status);
    }
    const clipIds = Object.keys(saved.reveals).filter((id) => id !== pathClip);
    for (const id of clipIds) {
      await selectClip(id);
      assert.equal((await revealState()).started, true);
    }
    await page.screenshot({ path: path.join(directory, 'real-circle-hits.png') });
    return { hits: 3 };
  });
  await check('Follow 真实追踪中松键冻结、恢复后增长，结束不自动补满', async () => {
    await page.getByRole('button', { name: '编辑', exact: true }).click();
    await selectClip(pathClip);
    await page.getByLabel('显现推进方式', { exact: true }).selectOption('slider-follow');
    await save(projectFile);
    await page.getByRole('button', { name: '试玩', exact: true }).click();
    await jump(4.5);
    await moveTo(samplePath(slider, saved)(0));
    await page.getByRole('button', { name: '播放', exact: true }).click();
    await moveTo(samplePath(slider, saved)(0));
    await until(4985000);
    await page.keyboard.down('z');
    const follow = samplePath(slider, saved);
    await followTo(follow, 5000000, 5600000);
    await page.keyboard.up('z');
    await until(5750000);
    const before = await revealState();
    await until(6100000);
    const stopped = await revealState();
    assert.ok(before.progress > 0.15 && before.progress < 0.5, JSON.stringify(before));
    assert.ok(
      Math.abs(before.progress - stopped.progress) < 0.015,
      JSON.stringify({ before, stopped }),
    );
    await moveTo(follow(0.56));
    await page.keyboard.down('z');
    await followTo(follow, 5000000, 7020000);
    await page.keyboard.up('z');
    await pause();
    const ended = await revealState();
    assert.ok(
      ended.progress > stopped.progress + 0.2 && ended.progress < 0.85,
      JSON.stringify(ended),
    );
    await result(slider.id, 'failed');
    await page.screenshot({ path: path.join(directory, 'real-follow-interrupted.png') });
    const endProgress = ended.progress;
    await jump(8);
    assert.ok(Math.abs((await revealState()).progress - endProgress) < 0.001);
    await jump(5.4);
    const restored = await revealState();
    assert.ok(restored.progress > 0 && restored.progress < endProgress);
    return { before, stopped, ended, restored };
  });
  await check('真实完整追踪可完成；暂停冻结，重播清空图层显现记录', async () => {
    await jump(4.5);
    const follow = samplePath(slider, saved);
    await moveTo(follow(0));
    await page.getByRole('button', { name: '播放', exact: true }).click();
    await moveTo(samplePath(slider, saved)(0));
    await until(4985000);
    await page.mouse.down();
    await followTo(follow, 5000000, 5600000);
    await page.keyboard.press('Space');
    const paused = await revealState();
    await new Promise((resolve) => setTimeout(resolve, 180));
    assert.ok(Math.abs((await revealState()).progress - paused.progress) < 0.002);
    await page.mouse.up();
    await page.keyboard.press('Space');
    await moveTo(follow(((await timeUs()) - 5000000) / 2000000));
    await page.mouse.down();
    await followTo(follow, 5000000, 7040000);
    await page.mouse.up();
    await pause();
    await result(slider.id, 'complete');
    const completed = await revealState();
    assert.ok(completed.progress > 0.9, JSON.stringify(completed));
    await page.getByRole('button', { name: '从头试玩', exact: true }).click();
    await frames();
    assert.equal((await revealState()).started, false);
    await pause();
    return { paused, completed };
  });
  await check('保存重开真实 PSD 工程，绑定、独立路径、分组和音频完整恢复', async () => {
    await page.getByRole('button', { name: '编辑', exact: true }).click();
    await save(projectFile);
    const before = JSON.stringify({
      reveals: saved.reveals,
      paths: saved.paths,
      layers: saved.layers,
      notes: saved.notes,
      music: saved.music,
    });
    await open(projectFile);
    await selectClip(pathClip);
    await save(projectFile);
    assert.equal(
      JSON.stringify({
        reveals: saved.reveals,
        paths: saved.paths,
        layers: saved.layers,
        notes: saved.notes,
        music: saved.music,
      }),
      before,
    );
    await page.getByRole('button', { name: '预览', exact: true }).click();
    await jump(6);
    assert.ok(Math.abs((await revealState()).progress - 0.5) < 0.001);
    report.measurements.realPreview = await metrics(
      path.join(directory, 'real-preview-performance.json'),
    );
    await page.getByRole('button', { name: '编辑', exact: true }).click();
    const example = path.join(directory, '旧路径练习', 'PathReveal旧路径.rcproj');
    await property('工程名称', '真实 PSD 图层显现练习');
    await save(example, true);
    report.example = example;
    return {
      bindings: Object.keys(saved.reveals).length,
      paths: Object.keys(saved.paths).length,
      example,
    };
  });
  await check('独立 PNG 的六种显现方式，使用画布像素验证透明度、位移、缩放和方向遮罩', async () => {
    await page.getByRole('button', { name: '新建', exact: true }).click();
    await page.getByLabel('新工程名称').fill('显现像素验收');
    await page.getByRole('button', { name: '创建工程', exact: true }).click();
    await settled();
    await importImage(fixture.png);
    await save(path.join(directory, '像素工程', '显现像素.rcproj'));
    await page.getByRole('button', { name: 'Circle 工具', exact: true }).click();
    await click({ x: 100, y: 100 });
    await save(path.join(directory, '像素工程', '显现像素.rcproj'));
    const n = Object.values(saved.notes)[0],
      l = Object.values(saved.layers)[0];
    await bind(n.id, l.id, 'instant');
    await page.getByRole('button', { name: '图层 工具', exact: true }).click();
    const pixels = {};
    await progressPercent(0);
    pixels.instant = await rgb({ x: 65, y: 90 });
    assert.ok(pixels.instant[0] > 220, pixels.instant.join());
    await page.getByLabel('显现方式', { exact: true }).selectOption('fade');
    await page.getByLabel('显现缓动', { exact: true }).selectOption('linear');
    await progressPercent(50);
    pixels.fade = await rgb({ x: 65, y: 90 });
    assert.ok(pixels.fade[0] > 125 && pixels.fade[0] < 170, pixels.fade.join());
    await page.getByLabel('显现方式', { exact: true }).selectOption('slide-in');
    await property('滑入偏移 X', -60);
    await progressPercent(50);
    pixels.slideLeft = await rgb({ x: 5, y: 90 });
    pixels.slideRight = await rgb({ x: 205, y: 90 });
    assert.ok(pixels.slideLeft[0] > 110, pixels.slideLeft.join());
    assert.ok(pixels.slideRight[0] < 90, pixels.slideRight.join());
    await page.getByLabel('显现方式', { exact: true }).selectOption('pop');
    await progressPercent(50);
    pixels.popCenter = await rgb({ x: 120, y: 90 });
    pixels.popEdge = await rgb({ x: 35, y: 90 });
    assert.ok(pixels.popCenter[0] > 110);
    assert.ok(pixels.popEdge[0] < 90);
    await page.getByLabel('显现方式', { exact: true }).selectOption('directional');
    await progressPercent(50);
    pixels.directionLeft = await rgb({ x: 65, y: 90 });
    pixels.directionRight = await rgb({ x: 175, y: 90 });
    assert.ok(pixels.directionLeft[0] > 220);
    assert.ok(pixels.directionRight[0] < 90);
    return pixels;
  });
  await check(
    'Path Reveal 像素验证：弧长半程、反向、保留遮罩、完成整层与随机进度恢复',
    async () => {
      await page.getByLabel('显现方式', { exact: true }).selectOption('path');
      await page.getByLabel('路径完成方式', { exact: true }).selectOption('keep-mask');
      await property('显现遮罩宽度', 40);
      await progressPercent(50);
      const half = {
        left: await rgb({ x: 65, y: 90 }),
        right: await rgb({ x: 175, y: 90 }),
        outside: await rgb({ x: 65, y: 40 }),
      };
      assert.ok(half.left[0] > 220, JSON.stringify(half));
      assert.ok(half.right[0] < 90, JSON.stringify(half));
      assert.ok(half.outside[0] < 90, JSON.stringify(half));
      await page.getByRole('button', { name: '反转显现路径', exact: true }).click();
      await frames();
      const reverse = { left: await rgb({ x: 65, y: 90 }), right: await rgb({ x: 175, y: 90 }) };
      assert.ok(reverse.left[0] < 90, JSON.stringify(reverse));
      assert.ok(reverse.right[0] > 220, JSON.stringify(reverse));
      await progressPercent(100);
      assert.ok((await rgb({ x: 120, y: 40 }))[0] < 90);
      await page.getByLabel('路径完成方式', { exact: true }).selectOption('show-full-layer');
      await frames();
      await textures();
      assert.ok((await rgb({ x: 120, y: 40 }))[0] > 220);
      await progressPercent(25);
      assert.ok((await rgb({ x: 65, y: 90 }))[0] < 90);
      await progressPercent(50);
      assert.ok((await rgb({ x: 175, y: 90 }))[0] > 220);
      await page.screenshot({ path: path.join(directory, 'path-mask-pixels.png') });
      const m = await metrics(path.join(directory, 'mask-performance.json'));
      assert.equal(m.graphics.layers.maskBitmapBytes, 0);
      return {
        half,
        reverse,
        masks: m.graphics.layers.vectorMasks,
        chunks: m.graphics.layers.pathMaskChunks,
        maskBitmapBytes: m.graphics.layers.maskBitmapBytes,
      };
    },
  );

  await check('6000 × 6000 典型裁剪 PSD 的 100 个图层同时运行路径显现、缩放和跳转', async () => {
    const sourceDir = path.join(root, '示例工程', '图层练习'),
      p = JSON.parse(await fs.readFile(path.join(sourceDir, '6000像素图层练习.rcproj'), 'utf8'));
    const perfDir = path.join(directory, '100层演出工程');
    await fs.mkdir(perfDir, { recursive: true });
    await fs.cp(path.join(sourceDir, 'assets'), path.join(perfDir, 'assets'), { recursive: true });
    p.notes = {};
    p.paths = {};
    p.reveals = {};
    p.sounds = {};
    p.name = '100 层同时路径显现';
    p.stage.artworkSize = { width: 6000, height: 6000 };
    const id = () => crypto.randomUUID(),
      identity = () => ({
        position: { x: 0, y: 0 },
        scale: { x: 1, y: 1 },
        rotationRad: 0,
        skewRad: { x: 0, y: 0 },
        pivot: { x: 0, y: 0 },
      });
    const node = (x, y) => ({
      id: id(),
      point: { x, y },
      handleIn: { x: 0, y: 0 },
      handleOut: { x: 0, y: 0 },
      mode: 'corner',
    });
    const timingPath = {
      id: id(),
      name: '时间进度 Slider',
      closed: false,
      interpolation: 'polyline',
      defaultWidth: 48,
      nodes: [node(80, 200), node(420, 200)],
    };
    p.paths[timingPath.id] = timingPath;
    const n = {
      id: id(),
      kind: 'slider',
      at: { basis: 'time', timeUs: 1000000 },
      path: { pathId: timingPath.id, transform: identity() },
      duration: { basis: 'time', durationUs: 10000000 },
      headRadius: 24,
      followRadius: 48,
    };
    p.notes[n.id] = n;
    for (const l of Object.values(p.layers).filter((l) => l.kind === 'raster')) {
      const r = p.pixelSources[l.pixelSourceId].cropRect,
        x = l.transform.position.x + r.x,
        y = l.transform.position.y + r.y;
      const nodes = [node(x, y + r.height * 0.3), node(x + r.width, y + r.height * 0.7)];
      nodes[0].handleOut = { x: r.width * 0.3, y: r.height * 0.7 };
      nodes[1].handleIn = { x: -r.width * 0.3, y: -r.height * 0.7 };
      const pathData = {
        id: id(),
        name: l.name + ' 显现',
        closed: false,
        interpolation: 'bezier',
        defaultWidth: 200,
        nodes,
      };
      p.paths[pathData.id] = pathData;
      l.initialReveal = 0;
      const clip = {
        id: id(),
        layerId: l.id,
        trigger: { kind: 'note', noteId: n.id, event: 'slider-start' },
        effect: {
          kind: 'path',
          path: { pathId: pathData.id, transform: identity() },
          maskWidth: Math.max(100, r.height * 0.55),
          completion: 'keep-mask',
        },
        easing: 'linear',
        progress: { kind: 'slider-timeline', noteId: n.id },
        after: 'hold',
        priority: 0,
      };
      p.reveals[clip.id] = clip;
    }
    const file = path.join(perfDir, '100层同时路径显现.rcproj');
    await fs.writeFile(file, JSON.stringify(p, null, 2));
    await page.getByRole('button', { name: '新建', exact: true }).click();
    await page.getByRole('button', { name: '创建工程', exact: true }).click();
    const confirmation = page.getByRole('dialog', { name: '未保存的修改', exact: true });
    if (await confirmation.count())
      await page.getByRole('button', { name: '放弃修改', exact: true }).click();
    await settled();
    await open(file);
    saved = p;
    await page.getByRole('button', { name: '预览', exact: true }).click();
    await jump(1.5);
    await textures();
    await page.getByRole('button', { name: '播放', exact: true }).click();
    const sample = await page.evaluate(
      () =>
        new Promise((resolve) => {
          const begin = performance.now(),
            deltas = [];
          let previous = begin;
          function tick(now) {
            deltas.push(now - previous);
            previous = now;
            if (now - begin >= 3500) {
              const values = deltas.slice(1).sort((a, b) => a - b),
                mean = values.reduce((a, b) => a + b, 0) / values.length;
              resolve({
                samples: values.length,
                durationMs: now - begin,
                fps: 1000 / mean,
                p95Ms: values[Math.ceil(values.length * 0.95) - 1],
                maxMs: values.at(-1),
              });
            } else requestAnimationFrame(tick);
          }
          requestAnimationFrame(tick);
        }),
    );
    await pause();
    const perf = await metrics(path.join(directory, '100-paths-performance.json'));
    report.measurements.hundredPaths = {
      sample,
      graphics: perf.graphics,
      processes: perf.processes.at(-1),
      synthetic: true,
    };
    assert.equal(perf.graphics.reveals.filter((s) => s.progress > 0 && s.progress < 1).length, 100);
    assert.equal(perf.graphics.layers.vectorMasks, 100);
    assert.equal(perf.graphics.layers.maskBitmapBytes, 0);
    await jump(6);
    await page.getByRole('button', { name: '放大画布', exact: true }).click();
    await textures();
    await jump(2);
    await frames();
    await page.screenshot({ path: path.join(directory, '100-paths.png') });
    return {
      layers: 100,
      sample,
      managedTextureBytes: perf.graphics.layers.rgbaBytesEstimate,
      pathMaskChunks: perf.graphics.layers.pathMaskChunks,
      maskBitmapBytes: perf.graphics.layers.maskBitmapBytes,
      fixture:
        'Generated PSD fixture imported and saved by the real stage-2 importer; reveal clips generated for concurrency load.',
    };
  });
  assert.deepEqual(report.consoleErrors, []);
  report.passed = true;
} catch (error) {
  report.passed = false;
  report.error = error.stack ?? String(error);
  console.error(report.error);
  process.exitCode = 1;
  if (page && !page.isClosed()) {
    await page.screenshot({ path: path.join(directory, 'failure.png') }).catch(() => {});
    report.lastState = await revealState().catch(() => null);
    report.lastResults = await page
      .locator('.result-item')
      .evaluateAll((items) =>
        items.map((el) => ({
          id: el.dataset.noteId,
          result: el.dataset.result,
          progress: el.dataset.progress,
        })),
      )
      .catch(() => []);
  }
} finally {
  report.finishedAt = new Date().toISOString();
  await fs.writeFile(path.join(directory, 'report.json'), JSON.stringify(report, null, 2));
  if (app) {
    await app.evaluate(({ app }) => app.exit(0)).catch(() => {});
    await app.close().catch(() => {});
  }
  const profile = path.resolve(environment.RHYTHM_USER_DATA);
  if (path.dirname(profile) !== directory || !/^profile-\d+$/.test(path.basename(profile)))
    throw new Error('Unsafe test profile cleanup');
  await fs.rm(profile, { recursive: true, force: true });
}
console.log(`Stage 4: ${report.checks.filter((c) => c.passed).length}/${report.checks.length}`);
