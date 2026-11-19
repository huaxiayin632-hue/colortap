import { _electron as electron } from 'playwright';
import { PNG } from 'pngjs';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'),
  directory = path.join(root, 'test-results', 'outline');
const examples = process.env.RHYTHM_EXAMPLES_ROOT ?? path.join(root, '示例工程');
await fs.mkdir(directory, { recursive: true });
const env = { ...process.env, RHYTHM_USER_DATA: path.join(directory, `profile-${Date.now()}`) };
delete env.ELECTRON_RUN_AS_NODE;
delete env.ELECTRON_RENDERER_URL;
const report = {
  version: '0.4.1',
  startedAt: new Date().toISOString(),
  checks: [],
  consoleErrors: [],
  limitations: [
    'Pixel assertions use a generated transparent PNG circle, kept separate from the production PSD example.',
    'Actual Electron audio clock, keyboard/mouse gameplay, filesystem and Pixi rendering are used. Native file-picker return paths are substituted.',
    'The 100-outline fixture is a generated concurrency workload on the existing imported 6000-pixel PSD; it is not 100 full-size bitmap layers.',
  ],
};
const projectFile = path.join(directory, '工程', '描边验收.rcproj');
let app, page, saved, circle, slider, circleClip, sliderClip;
const circleFile = path.join(directory, '透明圆形.png');
const png = new PNG({ width: 512, height: 384 });
for (let y = 0; y < 384; y++)
  for (let x = 0; x < 512; x++) {
    const d = Math.hypot(x - 256, y - 192),
      i = (y * 512 + x) * 4;
    if (d <= 100) {
      png.data[i] = 95;
      png.data[i + 1] = 150;
      png.data[i + 2] = 240;
      png.data[i + 3] = 255;
    }
  }
await fs.writeFile(circleFile, PNG.sync.write(png));
const music = path.join(directory, '120BPM.wav');
function wav() {
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
await fs.writeFile(music, wav());
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
  } catch (e) {
    report.checks.push({ name, passed: false, error: String(e) });
    throw e;
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
async function textures() {
  await page.waitForFunction(
    () =>
      Number(document.querySelector('[data-testid=canvas-host]')?.getAttribute('data-loading')) ===
      0,
  );
  await frames();
}
async function property(label, value) {
  const i = page.getByLabel(label, { exact: true });
  await i.fill(String(value));
  await i.press('Tab');
  await frames();
}
async function jump(seconds) {
  await property('定位到秒', seconds);
  await textures();
}
async function save(file = projectFile) {
  await choose(file, true);
  await page.getByRole('button', { name: '保存', exact: true }).click();
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
  await textures();
  saved = JSON.parse(await fs.readFile(file, 'utf8'));
}
async function history() {
  await page.getByRole('button', { name: '撤销', exact: true }).click();
  await settled();
  await frames();
}
async function screen(p) {
  const h = await page.getByTestId('canvas-host').evaluate((el) => ({
      z: Number(el.dataset.zoom),
      x: Number(el.dataset.panX),
      y: Number(el.dataset.panY),
    })),
    b = await page.getByTestId('pixi-canvas').boundingBox();
  return { x: b.x + h.x + p.x * h.z, y: b.y + h.y + p.y * h.z };
}
async function click(p) {
  const a = await screen(p);
  await page.mouse.click(a.x, a.y);
  await frames();
}
async function moveTo(p) {
  const a = await screen(p);
  await page.mouse.move(a.x, a.y);
}
async function drag(a, b) {
  a = await screen(a);
  b = await screen(b);
  await page.mouse.move(a.x, a.y);
  await page.mouse.down();
  await page.mouse.move(b.x, b.y, { steps: 10 });
  await page.mouse.up();
  await frames();
}
async function selectClip(id) {
  await page.locator(`.reveal-select[data-reveal-id="${id}"]`).click();
  await frames();
}
async function state() {
  return page.getByTestId('reveal-state').evaluate((el) => ({
    progress: Number(el.dataset.progress),
    alpha: Number(el.dataset.alpha),
    phase: el.dataset.outlinePhase,
    opacity: Number(el.dataset.outlineOpacity),
    layerProgress: Number(el.dataset.layerProgress),
    started: el.dataset.started === 'true',
  }));
}
async function bind(noteId, layerId) {
  const d = page.locator('details.reveal-add');
  if ((await d.getAttribute('open')) === null) await d.locator('summary').click();
  await page.getByLabel('新绑定音符', { exact: true }).selectOption(noteId);
  await page.getByLabel('新绑定图层', { exact: true }).selectOption(layerId);
  await page.getByLabel('新绑定显现方式', { exact: true }).selectOption('outline');
  await page.getByRole('button', { name: '添加显现绑定', exact: true }).click();
  await frames();
  return page.getByTestId('reveal-state').getAttribute('data-reveal-id');
}
async function imagePixels() {
  return {
    png: PNG.sync.read(await page.getByTestId('pixi-canvas').screenshot()),
    box: await page.getByTestId('pixi-canvas').boundingBox(),
  };
}
async function pixel(p, near = 0) {
  const { png, box } = await imagePixels(),
    at = await screen(p),
    x = Math.round(((at.x - box.x) * png.width) / box.width),
    y = Math.round(((at.y - box.y) * png.height) / box.height);
  let best = [0, 0, 0];
  for (let dy = -near; dy <= near; dy++)
    for (let dx = -near; dx <= near; dx++) {
      const i = ((y + dy) * png.width + x + dx) * 4,
        rgb = [...png.data.subarray(i, i + 3)];
      if (Math.min(...rgb) > Math.min(...best)) best = rgb;
    }
  return best;
}
async function colorNear(p) {
  const { png, box } = await imagePixels(),
    at = await screen(p),
    x = Math.round(((at.x - box.x) * png.width) / box.width),
    y = Math.round(((at.y - box.y) * png.height) / box.height);
  let best = [0, 0, 0];
  for (let dy = -4; dy <= 4; dy++)
    for (let dx = -4; dx <= 4; dx++) {
      const i = ((y + dy) * png.width + x + dx) * 4,
        rgb = [...png.data.subarray(i, i + 3)];
      if (rgb[2] > best[2]) best = rgb;
    }
  return best;
}
// A prepared editable sample contour, not an automatic contour-extraction feature in the app.
async function sampleContour(project, layerId, folder) {
  const layer = project.layers[layerId],
    source = project.pixelSources[layer.pixelSourceId],
    r = source.cropRect,
    level = source.levels.find((l) => l.level === 0),
    alpha = new Uint8Array(r.width * r.height);
  for (const tile of level.tiles) {
    const image = PNG.sync.read(
      await fs.readFile(path.join(folder, project.assets[tile.assetId].relativePath)),
    );
    for (let y = 0; y < tile.sourceRect.height; y++)
      for (let x = 0; x < tile.sourceRect.width; x++) {
        const a = ((tile.pixelRect.y + y) * image.width + tile.pixelRect.x + x) * 4 + 3,
          d = (tile.sourceRect.y - r.y + y) * r.width + tile.sourceRect.x - r.x + x;
        alpha[d] = image.data[a];
      }
  }
  const sides = [];
  for (let y = 0; y < r.height; y += Math.max(1, Math.floor(r.height / 24))) {
    let left = 0,
      right = r.width - 1;
    while (left < r.width && alpha[y * r.width + left] < 32) left++;
    while (right >= left && alpha[y * r.width + right] < 32) right--;
    if (right >= left) sides.push({ y, left, right });
  }
  assert.ok(sides.length > 3);
  const parent = new Map();
  for (const l of Object.values(project.layers))
    if (l.kind === 'group') for (const id of l.childrenBottomToTop) parent.set(id, l.id);
  const chain = [];
  for (let id = layerId; id; id = parent.get(id)) chain.unshift(project.layers[id].transform);
  function world(p) {
    for (const t of [...chain].reverse()) {
      const a = Math.cos(t.rotationRad + t.skewRad.y) * t.scale.x,
        b = Math.sin(t.rotationRad + t.skewRad.y) * t.scale.x,
        c = -Math.sin(t.rotationRad - t.skewRad.x) * t.scale.y,
        d = Math.cos(t.rotationRad - t.skewRad.x) * t.scale.y,
        x = p.x - t.pivot.x,
        y = p.y - t.pivot.y;
      p = { x: a * x + c * y + t.position.x, y: b * x + d * y + t.position.y };
    }
    return p;
  }
  const points = [
    ...sides.map((s) => world({ x: r.x + s.left - 2, y: r.y + s.y })),
    ...sides.toReversed().map((s) => world({ x: r.x + s.right + 2, y: r.y + s.y })),
  ];
  return {
    id: crypto.randomUUID(),
    name: layer.name + ' · 可编辑轮廓示例',
    closed: true,
    interpolation: 'bezier',
    defaultWidth: 20,
    nodes: points.map((point, i) => {
      const prev = points[(i - 1 + points.length) % points.length],
        next = points[(i + 1) % points.length],
        v = { x: (next.x - prev.x) * 0.14, y: (next.y - prev.y) * 0.14 };
      return {
        id: crypto.randomUUID(),
        point,
        handleOut: v,
        handleIn: { x: -v.x, y: -v.y },
        mode: 'mirrored',
      };
    }),
  };
}
const white = (rgb) => Math.min(...rgb) > 180;
const pointOnCircle = (angle) => ({
  x: 256 + 100 * Math.sin((angle * Math.PI) / 180),
  y: 192 - 100 * Math.cos((angle * Math.PI) / 180),
});
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
function sampleCurve(note, p) {
  const ns = p.paths[note.path.pathId].nodes,
    a = ns[0],
    d = ns[1],
    b = { x: a.point.x + a.handleOut.x, y: a.point.y + a.handleOut.y },
    c = { x: d.point.x + d.handleIn.x, y: d.point.y + d.handleIn.y },
    samples = [];
  let length = 0;
  for (let i = 0; i <= 1000; i++) {
    const t = i / 1000,
      u = 1 - t,
      q = {
        x: u ** 3 * a.point.x + 3 * u * u * t * b.x + 3 * u * t * t * c.x + t ** 3 * d.point.x,
        y: u ** 3 * a.point.y + 3 * u * u * t * b.y + 3 * u * t * t * c.y + t ** 3 * d.point.y,
      },
      prev = samples.at(-1);
    if (prev) length += Math.hypot(q.x - prev.x, q.y - prev.y);
    samples.push({ ...q, d: length });
  }
  return (f) => {
    const target = Math.max(0, Math.min(1, f)) * length;
    let i = 1;
    while (i < samples.length - 1 && samples[i].d < target) i++;
    const a = samples[i - 1],
      b = samples[i],
      t = (target - a.d) / Math.max(1e-9, b.d - a.d);
    return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
  };
}
async function followTo(evaluate, end) {
  while ((await timeUs()) < end) {
    const now = await timeUs();
    await moveTo(evaluate((now - 5000000) / 2000000));
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
  app = await electron.launch({ args: [root], cwd: root, env });
  page = await app.firstWindow();
  page.setDefaultTimeout(30000);
  page.on('pageerror', (e) => report.consoleErrors.push(String(e)));
  page.on('console', (m) => {
    if (m.type() === 'error') report.consoleErrors.push(m.text());
  });
  await page.getByTestId('pixi-canvas').waitFor();
  await settled();
  await check('正式导入透明 PNG/音乐，界面创建 Circle 与独立轮廓描绘绑定', async () => {
    await choose(circleFile);
    await page.getByRole('button', { name: '＋ 导入 PSD / PNG', exact: true }).click();
    await page
      .getByRole('dialog', { name: '图片导入进度', exact: true })
      .waitFor({ state: 'hidden', timeout: 60000 });
    await settled();
    await textures();
    await property('图层不透明度', 60);
    await choose(music);
    await page.getByRole('button', { name: '导入音乐', exact: true }).first().click();
    await settled();
    await page.locator('[data-testid=waveform][data-ready=true]').waitFor();
    await save();
    await jump(1);
    await page.getByRole('button', { name: 'Circle 工具', exact: true }).click();
    await click({ x: 60, y: 60 });
    await save();
    circle = Object.values(saved.notes)[0];
    circleClip = await bind(circle.id, Object.keys(saved.layers)[0]);
    await property('显现时长', 2);
    await property('白线宽度', 2);
    await property('白线光点半径', 3);
    await property('描边后图层时长', 0.5);
    await property('白线淡出时长', 0.5);
    await page.getByRole('button', { name: '图层 工具', exact: true }).click();
    await save();
    assert.equal(saved.reveals[circleClip].effect.kind, 'outline');
    assert.equal(saved.paths[saved.reveals[circleClip].effect.path.pathId].closed, true);
    return { binding: circleClip, layerOpacity: Object.values(saved.layers)[0].opacity };
  });
  await check('Edit 默认按播放头演出：单向白线增长时原图隐藏，反转改变实际绘制方向', async () => {
    await jump(1.5);
    let s = await state();
    assert.equal(s.alpha, 0);
    assert.equal(s.phase, 'drawing');
    assert.ok(white(await pixel(pointOnCircle(45), 4)));
    assert.ok(!white(await pixel(pointOnCircle(315), 4)));
    assert.ok((await pixel({ x: 256, y: 192 }))[2] < 100);
    await page.getByRole('button', { name: '反转显现路径', exact: true }).click();
    await frames();
    assert.ok(white(await pixel(pointOnCircle(315), 4)));
    assert.ok(!white(await pixel(pointOnCircle(45), 4)));
    await history();
    await page.getByLabel('显示完整素材', { exact: true }).check();
    await textures();
    assert.ok((await pixel({ x: 256, y: 192 }))[2] > 130);
    await page.getByLabel('显示完整素材', { exact: true }).uncheck();
    await frames();
    assert.ok((await pixel({ x: 256, y: 192 }))[2] < 100);
    await page.screenshot({ path: path.join(directory, 'single-edit.png') });
    return s;
  });
  await check('白线颜色、发光强度与端点光点改变实际成像', async () => {
    const picker = page.getByLabel('白线颜色', { exact: true });
    await picker.evaluate((el) => {
      el.value = '#22ccff';
      el.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await frames();
    const cyan = await colorNear(pointOnCircle(45));
    assert.ok(cyan[2] > 200 && cyan[0] < 120, JSON.stringify(cyan));
    await picker.evaluate((el) => {
      el.value = '#ffffff';
      el.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await frames();
    const tip = { x: 359, y: 192 },
      on = await pixel(tip);
    await page.getByLabel('白线端点光点', { exact: true }).uncheck();
    await frames();
    const off = await pixel(tip);
    assert.ok(Math.min(...on) > Math.min(...off) + 40, JSON.stringify({ on, off }));
    await page.getByLabel('白线端点光点', { exact: true }).check();
    const outside = { x: 256 + 108 * Math.SQRT1_2, y: 192 - 108 * Math.SQRT1_2 };
    await property('白线发光强度', 0);
    const dark = await pixel(outside);
    await property('白线发光强度', 3);
    const glow = await pixel(outside);
    assert.ok(glow[0] > dark[0] + 8, JSON.stringify({ dark, glow }));
    await property('白线发光强度', 1);
    return { cyan, tipOn: on, tipOff: off, dark, glow };
  });
  await check('闭合双向从指定起点向两侧延伸，速度比例不相等时在正确位置汇合', async () => {
    await page.getByLabel('白线描绘模式', { exact: true }).selectOption('bidirectional');
    await property('白线起点', 0);
    await property('白线正向速度比例', 50);
    await jump(2);
    assert.ok(white(await pixel(pointOnCircle(90), 4)));
    assert.ok(white(await pixel(pointOnCircle(270), 4)));
    assert.ok(!white(await pixel(pointOnCircle(180), 4)));
    assert.equal((await state()).alpha, 0);
    await property('白线起点', 25);
    await jump(1.5);
    assert.ok(white(await pixel(pointOnCircle(45), 4)));
    assert.ok(white(await pixel(pointOnCircle(135), 4)));
    assert.ok(!white(await pixel(pointOnCircle(270), 4)));
    await property('白线起点', 0);
    await property('白线正向速度比例', 75);
    await jump(2);
    assert.ok(white(await pixel(pointOnCircle(135), 4)));
    assert.ok(white(await pixel(pointOnCircle(315), 4)));
    await jump(3);
    for (const angle of [0, 90, 180, 270]) assert.ok(white(await pixel(pointOnCircle(angle), 4)));
    assert.equal((await state()).alpha, 0);
    await page.screenshot({ path: path.join(directory, 'bidirectional-meeting.png') });
    return { opposingTips: true, meetingAtPathPercent: 75 };
  });
  await check('整层阶段不使用路径蒙版，Fade/Instant/Pop 与白线保留/淡出/消失有效', async () => {
    await jump(3.25);
    const middle = await state();
    assert.ok(Math.abs(middle.alpha - 0.5) < 0.001);
    assert.ok(Math.abs(middle.opacity - 0.5) < 0.001);
    await jump(3.6);
    const full = await pixel({ x: 256, y: 192 });
    assert.ok(full[2] > 145 && full[2] < 190, full.join());
    assert.equal((await state()).opacity, 0);
    await page.getByLabel('描边后图层方式', { exact: true }).selectOption('instant');
    await jump(3);
    assert.equal((await state()).alpha, 1);
    await page.getByLabel('白线完成后处理', { exact: true }).selectOption('keep');
    await frames();
    assert.equal((await state()).opacity, 1);
    await page.getByLabel('白线完成后处理', { exact: true }).selectOption('hide');
    await frames();
    assert.equal((await state()).opacity, 0);
    await page.getByLabel('描边后图层方式', { exact: true }).selectOption('pop');
    await jump(3.25);
    assert.ok(Math.abs((await state()).alpha - 0.5) < 0.001);
    await page.getByLabel('描边后图层方式', { exact: true }).selectOption('fade');
    await page.getByLabel('白线完成后处理', { exact: true }).selectOption('fade');
    await save();
    assert.equal(Object.values(saved.layers)[0].opacity, 0.6);
    await page.screenshot({ path: path.join(directory, 'layer-full.png') });
    return { middle, full, originalOpacity: 0.6 };
  });
  await check('两阶段时间轴分别显示，可拖动阈值及第二阶段时长并撤销', async () => {
    await page.getByLabel('显现缓动', { exact: true }).selectOption('ease-in');
    await property('整层显现阈值', 25);
    await jump(1.9);
    assert.equal((await state()).phase, 'drawing');
    await jump(2.1);
    assert.equal((await state()).phase, 'revealing');
    assert.ok(Math.abs((await state()).alpha - 0.04) < 0.001);
    await page.getByLabel('显现缓动', { exact: true }).selectOption('linear');
    await property('整层显现阈值', 100);
    const stages = page.locator(`.timeline-reveal[data-reveal-id="${circleClip}"]`);
    assert.equal(await stages.count(), 2);
    const layer = stages.locator('[data-stage=layer]');
    const bar = page.locator(`.timeline-reveal[data-reveal-id="${circleClip}"][data-stage=layer]`);
    await bar.scrollIntoViewIfNeeded();
    let b = await bar.boundingBox();
    await page.mouse.move(b.x + 12, b.y + 10);
    await page.mouse.down();
    await page.mouse.move(b.x - 10, b.y + 10, { steps: 8 });
    await page.mouse.up();
    await frames();
    assert.equal(Number(await page.getByLabel('整层显现阈值', { exact: true }).inputValue()), 75);
    await history();
    const handle = bar.locator('.duration-handle');
    b = await handle.boundingBox();
    await page.mouse.move(b.x + 4, b.y + 8);
    await page.mouse.down();
    await page.mouse.move(b.x + 26, b.y + 8, { steps: 8 });
    await page.mouse.up();
    await frames();
    assert.equal(Number(await page.getByLabel('描边后图层时长', { exact: true }).inputValue()), 1);
    await history();
    return { phases: 2, thresholdDrag: true, durationDrag: true };
  });
  await check('Preview 任意跳转恢复白线和完整图层；暂停保持两个阶段不变', async () => {
    await page.getByRole('button', { name: '预览', exact: true }).click();
    const values = [];
    for (const t of [3.6, 1.5, 3.25, 0, 2, 3.6]) {
      await jump(t);
      values.push(await state());
    }
    assert.equal(values[0].alpha, 1);
    assert.equal(values[1].alpha, 0);
    assert.equal(values[3].started, false);
    assert.equal(values[4].progress, 0.5);
    await jump(3.25);
    await page.getByRole('button', { name: '播放', exact: true }).click();
    await page.keyboard.press('Space');
    await frames();
    const before = await state();
    await new Promise((resolve) => setTimeout(resolve, 150));
    assert.deepEqual(await state(), before);
    return values;
  });
  await check('真实 Circle 输入触发描线；不点击时不会伪造白线或整层显现', async () => {
    await page.getByRole('button', { name: '试玩', exact: true }).click();
    await jump(0);
    await page.getByRole('button', { name: '播放', exact: true }).click();
    await until(1250000);
    await pause();
    await result(circle.id, 'miss');
    assert.equal((await state()).started, false);
    await page.getByRole('button', { name: '从头试玩', exact: true }).click();
    await moveTo(circle.position);
    await until(985000);
    await page.keyboard.down('z');
    await page.keyboard.up('z');
    await until(1500000);
    assert.equal((await state()).phase, 'drawing');
    assert.equal((await state()).alpha, 0);
    await until(3700000);
    await pause();
    assert.equal((await state()).alpha, 1);
    const color = await pixel({ x: 256, y: 192 });
    assert.ok(color[2] > 145 && color[2] < 190, JSON.stringify(color));
    return { realHit: true, missHidden: true, playtestSourceColor: color };
  });
  await check('创建弯曲 Slider，轮廓路径可复制/关联，并保存独立描线参数', async () => {
    await page.getByRole('button', { name: '编辑', exact: true }).click();
    await jump(5);
    await page.getByRole('button', { name: 'Slider 工具', exact: true }).click();
    await drag({ x: 80, y: 300 }, { x: 430, y: 300 });
    await drag({ x: 80 + 350 / 3, y: 300 }, { x: 150, y: 220 });
    await property('Slider 持续秒数', 2);
    await save();
    slider = Object.values(saved.notes).find((n) => n.kind === 'slider');
    sliderClip = await bind(slider.id, Object.keys(saved.layers)[0]);
    await page.getByLabel('复制关联 Slider', { exact: true }).selectOption(slider.id);
    await page.getByRole('button', { name: '关联 Slider 路径', exact: true }).click();
    await save();
    assert.equal(saved.reveals[sliderClip].effect.linkedSliderId, slider.id);
    await page.getByRole('button', { name: '解除关联', exact: true }).click();
    await save();
    assert.notEqual(saved.reveals[sliderClip].effect.path.pathId, slider.path.pathId);
    assert.equal(saved.reveals[sliderClip].effect.linkedSliderId, undefined);
    await page.getByLabel('白线描绘模式', { exact: true }).selectOption('bidirectional');
    await property('白线正向速度比例', 65);
    await property('白线宽度', 3);
    await property('白线发光强度', 1.7);
    await page.getByLabel('白线完成后处理', { exact: true }).selectOption('keep');
    await property('整层显现阈值', 60);
    await page.getByLabel('显现推进方式', { exact: true }).selectOption('slider-follow');
    await save();
    return { sliderId: slider.id, clip: sliderClip };
  });
  await check(
    'Slider Follow 松键冻结描线，恢复有效追踪才继续，达到真实阈值后完整显现',
    async () => {
      await page.getByRole('button', { name: '试玩', exact: true }).click();
      await jump(4.5);
      await page.getByRole('button', { name: '播放', exact: true }).click();
      const evaluate = sampleCurve(slider, saved);
      await moveTo(evaluate(0));
      await until(4985000);
      await page.keyboard.down('z');
      await followTo(evaluate, 5650000);
      await page.keyboard.up('z');
      await until(5750000);
      const before = await state();
      await until(6050000);
      const stopped = await state();
      assert.ok(before.progress > 0.2 && before.progress < 0.45, JSON.stringify(before));
      assert.ok(Math.abs(before.progress - stopped.progress) < 0.015);
      assert.equal(stopped.alpha, 0);
      await moveTo(evaluate(((await timeUs()) - 5000000) / 2000000));
      await page.keyboard.down('z');
      await followTo(evaluate, 7040000);
      await page.keyboard.up('z');
      await until(7600000);
      await pause();
      const full = await state();
      assert.ok(full.progress > 0.65 && full.progress < 0.95, JSON.stringify(full));
      assert.equal(full.alpha, 1);
      assert.equal(full.phase, 'complete');
      await page.screenshot({ path: path.join(directory, 'follow-resume.png') });
      return { before, stopped, full };
    },
  );
  await check('未达阈值的 Follow 保持部分白线，游戏结束不会自动补齐；跳转按记录恢复', async () => {
    await page.getByRole('button', { name: '从头试玩', exact: true }).click();
    await pause();
    await jump(4.5);
    await page.getByRole('button', { name: '播放', exact: true }).click();
    const evaluate = sampleCurve(slider, saved);
    await moveTo(evaluate(0));
    await until(4985000);
    await page.mouse.down();
    await followTo(evaluate, 5400000);
    await page.mouse.up();
    await until(7400000);
    await pause();
    let s = await state();
    assert.ok(s.progress > 0.1 && s.progress < 0.4);
    assert.equal(s.alpha, 0);
    assert.equal(s.phase, 'drawing');
    const partial = s.progress;
    await jump(8);
    assert.ok(Math.abs((await state()).progress - partial) < 0.001);
    await jump(5.2);
    assert.ok((await state()).progress < partial);
    return { partial, afterBackwardSeek: await state() };
  });
  await check(
    '绑定列表删除按钮直接可用，撤销恢复绑定及初始状态；保存重开完整保留参数',
    async () => {
      await page.getByRole('button', { name: '编辑', exact: true }).click();
      await page.locator(`[data-reveal-delete="${circleClip}"]`).click();
      assert.equal(await page.locator('.reveal-select').count(), 1);
      await history();
      assert.equal(await page.locator('.reveal-select').count(), 2);
      await save();
      const before = JSON.stringify({
        reveals: saved.reveals,
        paths: saved.paths,
        notes: saved.notes,
        layers: saved.layers,
      });
      await open(projectFile);
      assert.equal(
        JSON.stringify({
          reveals: saved.reveals,
          paths: saved.paths,
          notes: saved.notes,
          layers: saved.layers,
        }),
        before,
      );
      await selectClip(sliderClip);
      assert.equal(
        await page.getByLabel('白线描绘模式', { exact: true }).inputValue(),
        'bidirectional',
      );
      assert.equal(
        Number(await page.getByLabel('白线发光强度', { exact: true }).inputValue()),
        1.7,
      );
      return { roundTrip: true, deleteUndo: true };
    },
  );
  await check('6000 像素真实 PSD 示例使用独立白线，播放结束后完整腿部图层恢复', async () => {
    const folder = path.join(examples, '图层演出练习'),
      oldFile = path.join(folder, '真实PSD图层显现.rcproj'),
      p = JSON.parse(await fs.readFile(oldFile, 'utf8'));
    const target = Object.values(p.reveals).find((c) => c.effect.kind === 'path');
    assert.ok(target);
    // Fix the old demonstration without changing any of its authored geometry or other settings.
    if (target.effect.completion === 'keep-mask') {
      target.effect.completion = 'show-full-layer';
      await fs.writeFile(oldFile, JSON.stringify(p, null, 2) + '\n');
    }
    p.id = crypto.randomUUID();
    p.name = '白线描绘与整层显现练习';
    const contour = await sampleContour(p, target.layerId, folder);
    p.paths[contour.id] = contour;
    const pathUse = {
      pathId: contour.id,
      transform: {
        position: { x: 0, y: 0 },
        scale: { x: 1, y: 1 },
        rotationRad: 0,
        skewRad: { x: 0, y: 0 },
        pivot: { x: 0, y: 0 },
      },
    };
    target.effect = {
      kind: 'outline',
      path: pathUse,
      drawing: { mode: 'bidirectional', start: 0, forwardRatio: 0.5 },
      stroke: { color: '#ffffff', width: 20, glow: 1.2, tips: true, tipSize: 28 },
      layer: { kind: 'fade', threshold: 1, durationUs: 500000, fromScale: 0.25, overshoot: 0.18 },
      lineAfter: { kind: 'fade', durationUs: 500000 },
    };
    target.progress = { kind: 'slider-timeline', noteId: target.trigger.noteId };
    const file = path.join(folder, '描边后整层显现练习.rcproj');
    await fs.writeFile(file, JSON.stringify(p, null, 2) + '\n');
    await open(file);
    await selectClip(target.id);
    await jump(6);
    assert.equal((await state()).alpha, 0);
    assert.equal((await state()).phase, 'drawing');
    await page.screenshot({ path: path.join(directory, 'real-psd-line.png') });
    await jump(8);
    assert.equal((await state()).alpha, 1);
    assert.equal((await state()).opacity, 0);
    await page.screenshot({ path: path.join(directory, 'real-psd-full.png') });
    const perf = await metrics(path.join(directory, 'real-psd-performance.json'));
    assert.equal(perf.graphics.reveals.find((s) => s.clipId === target.id).mask, null);
    for (const asset of Object.values(p.assets)) {
      const bytes = await fs.readFile(path.join(folder, asset.relativePath));
      assert.equal(crypto.createHash('sha256').update(bytes).digest('hex'), asset.sha256);
    }
    report.example = file;
    return {
      size: p.stage.artworkSize,
      layers: Object.keys(p.layers).length,
      mask: null,
      assetsVerified: true,
      example: file,
    };
  });
  await check('6000×6000、100 层同时描线，无逐帧全尺寸位图蒙版', async () => {
    const base = path.join(examples, '图层练习'),
      p = JSON.parse(await fs.readFile(path.join(base, '6000像素图层练习.rcproj'), 'utf8')),
      folder = path.join(directory, '100层工程');
    await fs.mkdir(folder, { recursive: true });
    await fs.cp(path.join(base, 'assets'), path.join(folder, 'assets'), { recursive: true });
    p.name = '100层双向描线';
    p.notes = {};
    p.paths = {};
    p.reveals = {};
    p.sounds = {};
    const id = () => crypto.randomUUID(),
      identity = () => ({
        position: { x: 0, y: 0 },
        scale: { x: 1, y: 1 },
        rotationRad: 0,
        skewRad: { x: 0, y: 0 },
        pivot: { x: 0, y: 0 },
      }),
      node = (x, y) => ({
        id: id(),
        point: { x, y },
        handleIn: { x: 0, y: 0 },
        handleOut: { x: 0, y: 0 },
        mode: 'corner',
      });
    for (const l of Object.values(p.layers).filter((l) => l.kind === 'raster')) {
      const r = p.pixelSources[l.pixelSourceId].cropRect,
        x = l.transform.position.x + r.x,
        y = l.transform.position.y + r.y;
      const nodes = [
          node(x, y + r.height / 2),
          node(x + r.width / 2, y),
          node(x + r.width, y + r.height / 2),
          node(x + r.width / 2, y + r.height),
        ],
        pathData = {
          id: id(),
          name: l.name + ' 闭合轮廓',
          closed: true,
          interpolation: 'bezier',
          defaultWidth: 10,
          nodes,
        };
      const k = 0.5522847498307936,
        handles = [
          { x: 0, y: (-r.height / 2) * k },
          { x: (r.width / 2) * k, y: 0 },
          { x: 0, y: (r.height / 2) * k },
          { x: (-r.width / 2) * k, y: 0 },
        ];
      nodes.forEach((n, i) => {
        n.handleOut = handles[i];
        n.handleIn = { x: -handles[i].x, y: -handles[i].y };
        n.mode = 'mirrored';
      });
      p.paths[pathData.id] = pathData;
      l.initialReveal = 0;
      const clip = {
        id: id(),
        layerId: l.id,
        trigger: { kind: 'timeline', at: { basis: 'time', timeUs: 1000000 } },
        effect: {
          kind: 'outline',
          path: { pathId: pathData.id, transform: identity() },
          drawing: { mode: 'bidirectional', start: 0.25, forwardRatio: 0.65 },
          stroke: { color: '#ffffff', width: 12, glow: 1, tips: true, tipSize: 16 },
          layer: {
            kind: 'fade',
            threshold: 1,
            durationUs: 500000,
            fromScale: 0.25,
            overshoot: 0.18,
          },
          lineAfter: { kind: 'fade', durationUs: 500000 },
        },
        easing: 'linear',
        progress: { kind: 'elapsed', duration: { basis: 'time', durationUs: 10000000 } },
        after: 'hold',
        priority: 0,
      };
      p.reveals[clip.id] = clip;
    }
    const file = path.join(folder, '100层轮廓并发.rcproj');
    await fs.writeFile(file, JSON.stringify(p, null, 2));
    await open(file);
    await page.getByRole('button', { name: '预览', exact: true }).click();
    await jump(1.5);
    await page.getByRole('button', { name: '播放', exact: true }).click();
    const sample = await page.evaluate(
      () =>
        new Promise((resolve) => {
          const begin = performance.now(),
            samples = [];
          let last = begin;
          function frame(now) {
            samples.push(now - last);
            last = now;
            if (now - begin >= 3500) {
              const sorted = samples.slice(1).sort((a, b) => a - b),
                mean = sorted.reduce((a, b) => a + b, 0) / sorted.length;
              resolve({
                durationMs: now - begin,
                samples: sorted.length,
                fps: 1000 / mean,
                p95Ms: sorted[Math.ceil(sorted.length * 0.95) - 1],
                maxMs: sorted.at(-1),
              });
            } else requestAnimationFrame(frame);
          }
          requestAnimationFrame(frame);
        }),
    );
    await pause();
    const perf = await metrics(path.join(directory, '100-outline-performance.json'));
    assert.equal(perf.graphics.outlines.objects, 100);
    assert.equal(perf.graphics.outlines.visibleObjects, 100);
    assert.equal(perf.graphics.outlines.bitmapBytes, 0);
    assert.equal(perf.graphics.layers.vectorMasks, 0);
    report.performance = { sample, graphics: perf.graphics, processes: perf.processes.at(-1) };
    await page.screenshot({ path: path.join(directory, '100-outlines.png') });
    await jump(10.9);
    await page.getByRole('button', { name: '播放', exact: true }).click();
    await until(11700000);
    await pause();
    await textures();
    const complete = await metrics(path.join(directory, '100-outline-complete-performance.json'));
    assert.equal(
      complete.graphics.reveals.filter((s) => s.alpha === 1 && s.outlinePhase === 'complete')
        .length,
      100,
    );
    assert.equal(complete.graphics.outlines.visibleObjects, 0);
    report.performance.completedLayerTextures = complete.graphics.layers.rgbaBytesEstimate;
    return {
      sample,
      objects: 100,
      bitmapBytes: 0,
      managedTextureBytes: perf.graphics.layers.rgbaBytesEstimate,
    };
  });
  assert.deepEqual(report.consoleErrors, []);
  report.passed = true;
} catch (e) {
  report.passed = false;
  report.error = e.stack ?? String(e);
  console.error(report.error);
  process.exitCode = 1;
  if (page && !page.isClosed()) {
    await page.screenshot({ path: path.join(directory, 'failure.png') }).catch(() => {});
    report.lastState = await state().catch(() => null);
  }
} finally {
  report.finishedAt = new Date().toISOString();
  await fs.writeFile(path.join(directory, 'report.json'), JSON.stringify(report, null, 2));
  if (app) {
    await app.evaluate(({ app }) => app.exit(0)).catch(() => {});
    await app.close().catch(() => {});
  }
  const profile = path.resolve(env.RHYTHM_USER_DATA);
  assert.equal(path.dirname(profile), directory);
  assert.match(path.basename(profile), /^profile-\d+$/);
  await fs.rm(profile, { recursive: true, force: true });
}
console.log(`Outline: ${report.checks.filter((c) => c.passed).length}/${report.checks.length}`);
