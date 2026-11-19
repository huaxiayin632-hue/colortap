import { _electron as electron } from 'playwright';
import { PNG } from 'pngjs';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dir = path.join(root, 'test-results', 'binding');
await fs.mkdir(dir, { recursive: true });
const profile = path.join(dir, `profile-${Date.now()}`),
  env = { ...process.env, RHYTHM_USER_DATA: profile };
delete env.ELECTRON_RUN_AS_NODE;
delete env.ELECTRON_RENDERER_URL;
const transform = (x = 0, y = 0) => ({
  position: { x, y },
  scale: { x: 1, y: 1 },
  rotationRad: 0,
  skewRad: { x: 0, y: 0 },
  pivot: { x: 0, y: 0 },
});
const template = JSON.parse(
  await fs.readFile(path.join(root, '示例工程', '节拍练习.rcproj'), 'utf8'),
);
let p = structuredClone(template),
  asset = p.assets[p.music.assetId];
p.id = randomUUID();
p.name = '图像路径与镜头 · 贴合练习';
p.stage = {
  artworkSize: { width: 512, height: 384 },
  chartSize: { width: 512, height: 384 },
  playfieldRect: { x: 0, y: 0, width: 512, height: 384 },
};
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
p.assets = { [asset.id]: asset };
p.rootLayersBottomToTop = [];
p.music.gain = 0.3;
p.camera = {
  enabled: false,
  base: { position: { x: 256, y: 192 }, zoom: 1, rotationRad: 0 },
  keys: {},
  shakes: {},
};
const work = path.join(dir, '工程'),
  file = path.join(work, '贴合练习.rcproj');
await fs.mkdir(path.dirname(path.join(work, asset.relativePath)), { recursive: true });
await fs.copyFile(
  path.join(root, '示例工程', asset.relativePath),
  path.join(work, asset.relativePath),
);
await fs.writeFile(file, JSON.stringify(p, null, 2));
const curve = {
  id: randomUUID(),
  name: '图案中的曲线',
  closed: false,
  defaultWidth: 1,
  interpolation: 'bezier',
  nodes: [
    {
      id: randomUUID(),
      point: { x: 125, y: 280 },
      handleIn: { x: 0, y: 0 },
      handleOut: { x: -5, y: -80 },
      mode: 'corner',
    },
    {
      id: randomUUID(),
      point: { x: 390, y: 110 },
      handleIn: { x: -100, y: -30 },
      handleOut: { x: 0, y: 0 },
      mode: 'corner',
    },
  ],
};
const samples = [];
let total = 0;
for (let i = 0; i <= 2000; i++) {
  const u = i / 2000,
    v = 1 - u,
    at = {
      x: v ** 3 * 125 + 3 * v * v * u * 120 + 3 * v * u * u * 290 + u ** 3 * 390,
      y: v ** 3 * 280 + 3 * v * v * u * 200 + 3 * v * u * u * 80 + u ** 3 * 110,
    };
  if (samples.length) total += Math.hypot(at.x - samples.at(-1).x, at.y - samples.at(-1).y);
  samples.push({ ...at, distance: total });
}
const follow = (t) =>
  samples.find((s) => s.distance >= Math.max(0, Math.min(1, t)) * total) ?? samples.at(-1);
const png = new PNG({ width: 512, height: 384 });
for (let y = 0; y < png.height; y++)
  for (let x = 0; x < png.width; x++) {
    const i = (y * png.width + x) * 4,
      tone = Math.max(0, 1 - Math.hypot((x - 255) / 370, (y - 192) / 290));
    png.data[i] = 23 + tone * 8;
    png.data[i + 1] = 33 + tone * 13;
    png.data[i + 2] = 42 + tone * 15;
    png.data[i + 3] = 255;
  }
function stamp(x, y, radius, color) {
  for (let yy = Math.max(0, Math.floor(y - radius)); yy <= Math.min(383, y + radius); yy++)
    for (let xx = Math.max(0, Math.floor(x - radius)); xx <= Math.min(511, x + radius); xx++) {
      if (Math.hypot(xx - x, yy - y) > radius) continue;
      const i = (yy * 512 + xx) * 4;
      png.data[i] = color[0];
      png.data[i + 1] = color[1];
      png.data[i + 2] = color[2];
    }
}
for (const s of samples.filter((_, i) => i % 3 === 0)) stamp(s.x, s.y, 10, [38, 64, 69]);
for (const s of samples.filter((_, i) => i % 2 === 0)) stamp(s.x, s.y, 1.2, [97, 151, 145]);
const pngFile = path.join(dir, '曲线图案.png');
await fs.writeFile(pngFile, PNG.sync.write(png));
const note = {
  id: randomUUID(),
  kind: 'slider',
  at: { basis: 'time', timeUs: 2e6 },
  duration: { basis: 'time', durationUs: 5e6 },
  headRadius: 24,
  followRadius: 28,
  path: { pathId: curve.id, transform: transform() },
};
const parentId = randomUUID(),
  outlineId = randomUUID(),
  slideId = randomUUID();
let layerId, app, page;
const report = {
  checks: [],
  errors: [],
  limitations: [
    'Generated PNG is imported through the production image importer. Pointer input, audio clock, render transforms and judgement are real.',
    'Moving targets use a fixed 2 ms geometry grid; this is a bounded numerical approximation, not a physical display-latency measurement.',
  ],
};
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
async function settled() {
  await page.locator('.editor-shell[aria-busy=false]').waitFor();
  await frames();
}
async function open(file) {
  await choose(file);
  await page.getByRole('button', { name: '打开', exact: true }).click();
  if (await page.getByRole('dialog', { name: '未保存的修改', exact: true }).count())
    await page.getByRole('button', { name: '放弃修改', exact: true }).click();
  await settled();
  await page.locator('[data-testid=waveform][data-ready=true]').waitFor();
}
async function save(to = file, as = false) {
  await choose(to, true);
  await page.getByRole('button', { name: as ? '另存为' : '保存', exact: true }).click();
  await page.waitForFunction(
    (file) =>
      document.querySelector('.save-state')?.getAttribute('title') === file &&
      document.querySelector('.save-state')?.textContent?.trim() === '已保存',
    to,
  );
  await settled();
  p = JSON.parse(await fs.readFile(to, 'utf8'));
  return p;
}
async function jump(t) {
  const input = page.getByLabel('定位到秒', { exact: true });
  await input.fill(String(t));
  await input.press('Tab');
  await frames();
}
async function screen(at) {
  const v = await page
      .getByTestId('canvas-host')
      .evaluate((el) => ({ x: +el.dataset.panX, y: +el.dataset.panY, z: +el.dataset.zoom })),
    box = await page.getByTestId('pixi-canvas').boundingBox();
  return { x: box.x + v.x + at.x * v.z, y: box.y + v.y + at.y * v.z };
}
async function move(at) {
  const p = await screen(at);
  await page.mouse.move(p.x, p.y);
}
async function shot(name) {
  const a = await screen({ x: 0, y: 0 }),
    b = await screen({ x: 512, y: 384 });
  await page.screenshot({
    path: path.join(dir, name + '.png'),
    clip: { x: a.x, y: a.y, width: b.x - a.x, height: b.y - a.y },
  });
}
const time = async () => Number(await page.getByTestId('playhead').getAttribute('data-time-us'));
async function until(t) {
  await page.waitForFunction(
    (t) => +document.querySelector('[data-testid=playhead]').getAttribute('data-time-us') >= t,
    t,
    { polling: 'raf', timeout: 16000 },
  );
}
async function select() {
  await page.locator(`.timeline-note[data-note-id="${note.id}"]`).click();
}
async function metrics(name) {
  const f = path.join(dir, name + '.json');
  await choose(f, true);
  await page.getByRole('button', { name: '查看运行记录', exact: true }).click();
  await page.getByRole('button', { name: '保存性能记录', exact: true }).click();
  await settled();
  await page.getByRole('button', { name: '关闭运行记录', exact: true }).click();
  return JSON.parse(await fs.readFile(f, 'utf8'));
}
async function check(name, fn) {
  try {
    const evidence = await fn();
    report.checks.push({ name, passed: true, evidence });
    console.log('PASS ' + name);
  } catch (e) {
    report.checks.push({ name, passed: false, error: String(e) });
    throw e;
  }
}
// Independent camera/parent calculation for this fixture, with dense cubic arc sampling above.
function displayed(at, us) {
  const t = us / 1e6,
    w = Math.max(0, 1 - t / 10);
  const u = t < 2 ? 0 : t <= 5 ? (t - 2) / 3 : t < 8 ? (8 - t) / 3 : 0;
  const zoom = 1 + 0.12 * u,
    angle = -0.08 * u,
    c = Math.cos(angle) * zoom,
    s = Math.sin(angle) * zoom;
  const x = at.x - 50 * w - 256,
    y = at.y + 35 * w - 192;
  return { x: c * x - s * y + 256 - 24 * u, y: s * x + c * y + 192 + 22 * u };
}
try {
  app = await electron.launch({ args: [root], cwd: root, env });
  page = await app.firstWindow();
  page.setDefaultTimeout(22000);
  page.on('pageerror', (e) => report.errors.push(String(e)));
  await page.getByTestId('pixi-canvas').waitFor();
  await settled();
  await app.evaluate(({ BrowserWindow }) => {
    const w = BrowserWindow.getAllWindows()[0];
    w.setSize(1500, 980);
    w.show();
    w.focus();
  });
  await page.bringToFront();
  await open(file);
  await check('正式导入曲线 PNG 并准备可编辑镜头/图层演出', async () => {
    await choose(pngFile);
    await page.getByRole('button', { name: /导入 PSD \/ PNG/ }).click();
    await settled();
    await save();
    layerId = Object.keys(p.layers)[0];
    assert.ok(layerId);
    p.layers[layerId].name = '曲线图案';
    p.layers[parentId] = {
      id: parentId,
      name: '移动图案',
      kind: 'group',
      childrenBottomToTop: [layerId],
      isolation: 'pass-through',
      expanded: true,
      transform: transform(),
      opacity: 1,
      enabled: true,
      locked: false,
      initialReveal: 1,
      blendMode: 'normal',
    };
    p.rootLayersBottomToTop = [parentId];
    p.notes[note.id] = note;
    p.paths[curve.id] = curve;
    p.reveals[slideId] = {
      id: slideId,
      layerId: parentId,
      trigger: { kind: 'timeline', at: { basis: 'time', timeUs: 0 } },
      effect: { kind: 'slide-in', offset: { x: -50, y: 35 } },
      easing: 'linear',
      progress: { kind: 'elapsed', duration: { basis: 'time', durationUs: 10e6 } },
      after: 'hold',
      priority: 0,
    };
    p.reveals[outlineId] = {
      id: outlineId,
      layerId,
      trigger: { kind: 'timeline', at: { basis: 'time', timeUs: 2e6 } },
      effect: {
        kind: 'outline',
        path: { pathId: curve.id, transform: transform() },
        drawing: { mode: 'single', start: 0, forwardRatio: 0.5 },
        stroke: { color: '#a5d9c9', width: 1, glow: 0.6, tips: false, tipSize: 2 },
        layer: { kind: 'instant', threshold: 0, durationUs: 0, fromScale: 1, overshoot: 0 },
        lineAfter: { kind: 'keep', durationUs: 0 },
      },
      easing: 'linear',
      progress: { kind: 'slider-timeline', noteId: note.id },
      after: 'hold',
      priority: 0,
    };
    p.camera.enabled = true;
    for (const [at, x, y, zoom, angle] of [
      [0, 256, 192, 1, 0],
      [2e6, 256, 192, 1, 0],
      [5e6, 280, 170, 1.12, 0.08],
      [8e6, 256, 192, 1, 0],
    ]) {
      const id = randomUUID();
      p.camera.keys[id] = {
        id,
        at: { basis: 'time', timeUs: at },
        position: { x, y },
        zoom,
        rotationRad: angle,
        easingToNext: 'linear',
      };
    }
    await fs.writeFile(file, JSON.stringify(p, null, 2));
    await open(file);
    await select();
    await jump(4);
    return {
      layerId,
      imageSize: p.stage.artworkSize,
      keyframes: Object.keys(p.camera.keys).length,
    };
  });
  await check('界面绑定和解除绑定保留当前位置，撤销恢复', async () => {
    await page.getByLabel('Slider 贴合图层', { exact: true }).selectOption(layerId);
    await frames();
    let record = await metrics('attached');
    const head = record.graphics.chart.boundNotes[0].head;
    assert.ok(Math.hypot(head.x - 125, head.y - 280) < 0.001, JSON.stringify(head));
    await page.getByLabel('Slider 贴合图层', { exact: true }).selectOption('');
    await save();
    assert.equal(p.notes[note.id].binding, undefined);
    await page.getByRole('button', { name: '撤销', exact: true }).click();
    await frames();
    assert.equal(await page.getByLabel('Slider 贴合图层').inputValue(), layerId);
    await page.getByRole('button', { name: '撤销', exact: true }).click();
    await frames();
    assert.equal(await page.getByLabel('Slider 贴合图层').inputValue(), '');
    return { headBeforeAndAfter: head };
  });
  await check('复用图层描边：节点与移动位置共同关联，保存完整', async () => {
    await jump(12);
    await page.getByLabel('复用图层描边', { exact: true }).selectOption(outlineId);
    await page.getByRole('button', { name: '贴合这条路径', exact: true }).click();
    await save();
    assert.equal(p.notes[note.id].binding.layerId, layerId);
    assert.equal(p.reveals[outlineId].effect.linkedSliderId, note.id);
    assert.equal(p.notes[note.id].path.pathId, curve.id);
    return { binding: p.notes[note.id].binding, pathId: curve.id };
  });
  await check('镜头平移缩放旋转和图层位移下，真实光点仍覆盖 PNG 曲线', async () => {
    await page.getByRole('button', { name: '预览', exact: true }).click();
    const evidence = [];
    for (const t of [2.8, 4.4, 6.5]) {
      await jump(t);
      await shot(`alignment-${t}`);
      const at = displayed(follow((t - 2) / 5), t * 1e6),
        xy = await screen(at),
        box = await page.getByTestId('pixi-canvas').boundingBox();
      const image = PNG.sync.read(await page.getByTestId('pixi-canvas').screenshot()),
        x = Math.round(((xy.x - box.x) * image.width) / box.width),
        y = Math.round(((xy.y - box.y) * image.height) / box.height);
      const rgb = [
        ...image.data.subarray((y * image.width + x) * 4, (y * image.width + x) * 4 + 3),
      ];
      assert.ok(
        rgb.every((c) => c > 210),
        `${t}: dot not at expected PNG path ${rgb}`,
      );
      evidence.push({ t, at, rgb });
    }
    return evidence;
  });
  await check('实际按住曲线：边移动镜头边追踪，暂停继续后完成', async () => {
    await page.getByRole('button', { name: '试玩', exact: true }).click();
    await jump(1.6);
    await page.getByRole('button', { name: '播放', exact: true }).click();
    await move(displayed(follow(0), 2e6));
    await until(1.985e6);
    await page.keyboard.down('z');
    while ((await time()) < 4.1e6) {
      const t = await time();
      await move(displayed(follow((t - 2e6) / 5e6), t));
    }
    await page.keyboard.press('Space');
    await page.keyboard.up('z');
    await frames();
    await shot('actual-follow');
    const paused = await time();
    await frames();
    assert.equal(await time(), paused);
    await page.getByRole('button', { name: '播放', exact: true }).click();
    await move(displayed(follow((paused - 2e6) / 5e6), paused));
    await page.keyboard.down('z');
    while ((await time()) < 7.04e6) {
      const t = await time();
      await move(displayed(follow((t - 2e6) / 5e6), t));
    }
    await page.keyboard.up('z');
    await page.keyboard.press('Space');
    const result = page.locator(`.result-item[data-note-id="${note.id}"]`);
    assert.equal(await result.getAttribute('data-result'), 'complete');
    return { result: await result.innerText(), paused };
  });
  await check('不跟随移动图案会记录偏离并失败', async () => {
    await jump(1.6);
    await page.getByRole('button', { name: '播放', exact: true }).click();
    await move(displayed(follow(0), 2e6));
    await until(1.985e6);
    await page.keyboard.down('x');
    await until(7.04e6);
    await page.keyboard.up('x');
    await page.keyboard.press('Space');
    const result = page.locator(`.result-item[data-note-id="${note.id}"]`);
    assert.equal(await result.getAttribute('data-result'), 'failed');
    return await result.innerText();
  });
  await check('镜头下拖动节点、复制、删除父分组与撤销', async () => {
    await page.getByRole('button', { name: '编辑', exact: true }).click();
    await select();
    await jump(4);
    await page.getByRole('button', { name: '编辑路径', exact: true }).click();
    const a = await screen(displayed(curve.nodes[0].point, 4e6));
    await page.mouse.move(a.x, a.y);
    await page.mouse.down();
    await page.mouse.move(a.x + 25, a.y - 15, { steps: 8 });
    await page.mouse.up();
    await save();
    assert.ok(
      Math.hypot(
        p.paths[curve.id].nodes[0].point.x - 125,
        p.paths[curve.id].nodes[0].point.y - 280,
      ) > 5,
    );
    await page.getByRole('button', { name: '撤销', exact: true }).click();
    await save();
    assert.deepEqual(p.paths[curve.id], curve);
    await page.keyboard.press('Control+d');
    await save();
    const copies = Object.values(p.notes).filter((n) => n.kind === 'slider');
    assert.equal(copies.length, 2);
    assert.ok(copies.every((n) => n.binding.layerId === layerId));
    assert.equal(new Set(copies.map((n) => n.path.pathId)).size, 2);
    await page.getByRole('button', { name: '撤销', exact: true }).click();
    await frames();
    await page.locator(`.layer-row[data-layer-id="${parentId}"]`).click();
    await page.keyboard.press('Delete');
    await settled();
    await save();
    assert.equal(p.layers[parentId], undefined);
    assert.equal(p.notes[note.id].binding, undefined);
    await page.getByRole('button', { name: '撤销', exact: true }).click();
    await save();
    assert.equal(p.notes[note.id].binding.layerId, layerId);
    return { copiedPathsIndependent: true, deletionDetached: true, restored: true };
  });
  await check('关联路径蒙版随图层与镜头移动，已画段显示、未画段裁切', async () => {
    const variant = structuredClone(p),
      clip = variant.reveals[outlineId];
    clip.effect = {
      kind: 'path',
      path: structuredClone(note.path),
      linkedSliderId: note.id,
      maskWidth: 14,
      completion: 'keep-mask',
    };
    clip.progress = { kind: 'slider-timeline', noteId: note.id };
    const variantFile = path.join(work, '路径蒙版检查.rcproj');
    await fs.writeFile(variantFile, JSON.stringify(variant, null, 2));
    await open(variantFile);
    await page.getByRole('button', { name: '预览', exact: true }).click();
    await jump(4.4);
    await shot('bound-mask');
    const image = PNG.sync.read(await page.getByTestId('pixi-canvas').screenshot()),
      box = await page.getByTestId('pixi-canvas').boundingBox(),
      colors = [];
    for (const progress of [0.2, 0.8]) {
      const on = follow(progress),
        before = follow(progress - 0.005),
        after = follow(progress + 0.005),
        length = Math.hypot(after.x - before.x, after.y - before.y);
      const offset = {
        x: on.x - ((after.y - before.y) / length) * 5,
        y: on.y + ((after.x - before.x) / length) * 5,
      };
      const pos = await screen(displayed(offset, 4.4e6));
      const x = Math.round(((pos.x - box.x) * image.width) / box.width),
        y = Math.round(((pos.y - box.y) * image.height) / box.height);
      colors.push([
        ...image.data.subarray((y * image.width + x) * 4, (y * image.width + x) * 4 + 3),
      ]);
    }
    // Slide-in also fades its parent: at 4.4 / 10 seconds the PNG contributes 44%.
    const expected = [38, 64, 69].map((channel, i) => channel * 0.44 + [45, 49, 54][i] * 0.56);
    assert.ok(
      colors[0].every((channel, i) => Math.abs(channel - expected[i]) < 2.5),
      JSON.stringify(colors),
    );
    assert.ok(
      colors[1].every((channel, i) => Math.abs(channel - [45, 49, 54][i]) < 2),
      JSON.stringify(colors),
    );
    await open(file);
    return { revealed: colors[0], clipped: colors[1] };
  });
  await check('工程重开与素材完整性', async () => {
    const demoDir = path.join(root, '示例工程', '图像路径贴合'),
      demo = path.join(demoDir, '图像路径与镜头.rcproj');
    await fs.mkdir(demoDir, { recursive: true });
    let destination = demo;
    try {
      await fs.access(demo);
      destination = path.join(work, '重开检查.rcproj');
    } catch {}
    await save(destination, true);
    await open(destination);
    await select();
    assert.equal(await page.getByLabel('Slider 贴合图层').inputValue(), layerId);
    for (const a of Object.values(p.assets))
      assert.equal(
        createHash('sha256')
          .update(await fs.readFile(path.join(path.dirname(destination), a.relativePath)))
          .digest('hex'),
        a.sha256,
      );
    await page.getByRole('button', { name: '预览', exact: true }).click();
    await jump(4.4);
    await shot('reopened');
    return { destination, assets: Object.keys(p.assets).length, binding: p.notes[note.id].binding };
  });
  await check('录制移动图案与曲线同轨的正式画布预览', async () => {
    await jump(0.5);
    const a = await screen({ x: 0, y: 0 }),
      b = await screen({ x: 512, y: 384 }),
      bounds = await page.getByTestId('pixi-canvas').boundingBox();
    await page.evaluate(
      ({ a, b, bounds }) => {
        const source = document.querySelector('[data-testid=pixi-canvas]'),
          output = document.createElement('canvas'),
          ratio = source.width / bounds.width;
        output.width = Math.round(((b.x - a.x) * ratio) / 2) * 2;
        output.height = Math.round(((b.y - a.y) * ratio) / 2) * 2;
        const ctx = output.getContext('2d'),
          stream = output.captureStream(60),
          recorder = new MediaRecorder(stream, {
            mimeType: 'video/webm;codecs=vp9',
            videoBitsPerSecond: 3e6,
          }),
          chunks = [];
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
        window.bindingRecording = {
          recorder,
          done: new Promise((resolve) => {
            recorder.onstop = async () => {
              cancelAnimationFrame(frame);
              stream.getTracks().forEach((t) => t.stop());
              const bytes = new Uint8Array(await new Blob(chunks).arrayBuffer());
              let s = '';
              for (let i = 0; i < bytes.length; i += 8192)
                s += String.fromCharCode(...bytes.subarray(i, i + 8192));
              resolve(btoa(s));
            };
          }),
        };
        draw();
        recorder.start();
      },
      { a, b, bounds },
    );
    await page.getByRole('button', { name: '播放', exact: true }).click();
    await until(8.2e6);
    const encoded = await page.evaluate(async () => {
      window.bindingRecording.recorder.stop();
      return await window.bindingRecording.done;
    });
    await page.getByRole('button', { name: '暂停', exact: true }).click();
    const webm = path.join(dir, '路径贴合预览.webm'),
      mp4 = path.join(dir, '路径贴合预览.mp4');
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
    return { mp4, bytes: (await fs.stat(mp4)).size, audio: false };
  });
  assert.deepEqual(report.errors, []);
  report.passed = true;
} catch (e) {
  report.passed = false;
  report.error = e.stack ?? String(e);
  console.error(report.error);
  await page?.screenshot({ path: path.join(dir, 'failure.png') }).catch(() => {});
  process.exitCode = 1;
} finally {
  await fs.writeFile(path.join(dir, 'report.json'), JSON.stringify(report, null, 2));
  if (app) {
    await app.evaluate(({ app }) => app.exit(0)).catch(() => {});
    await app.close().catch(() => {});
  }
  const target = path.resolve(profile);
  if (path.dirname(target) !== path.resolve(dir) || !/^profile-\d+$/.test(path.basename(target)))
    throw Error('Unsafe test profile cleanup');
  await fs.rm(target, { recursive: true, force: true });
}
console.log(`Binding: ${report.checks.filter((c) => c.passed).length}/${report.checks.length}`);
