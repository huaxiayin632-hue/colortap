import { _electron as electron } from 'playwright';
import { PNG } from 'pngjs';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID, createHash } from 'node:crypto';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const results = path.join(root, 'test-results', 'fan');
const example = path.join(root, '示例工程', '扇形动画');
await fs.mkdir(results, { recursive: true });
await fs.mkdir(example, { recursive: true });
const baseDir = path.join(root, '示例工程', '第五阶段');
const base = JSON.parse(await fs.readFile(path.join(baseDir, '音效与镜头联动.rcproj'), 'utf8'));
const identity = () => ({
  position: { x: 0, y: 0 },
  scale: { x: 1, y: 1 },
  rotationRad: 0,
  skewRad: { x: 0, y: 0 },
  pivot: { x: 0, y: 0 },
});
function document(name, size) {
  const p = structuredClone(base),
    now = new Date().toISOString();
  Object.assign(p, {
    id: randomUUID(),
    name,
    revision: 0,
    createdAt: now,
    modifiedAt: now,
    stage: {
      artworkSize: size,
      chartSize: { width: 512, height: 512 },
      playfieldRect: { x: 0, y: 0, ...size },
    },
    sourceDocuments: {},
    assets: {},
    pixelSources: {},
    layers: {},
    rootLayersBottomToTop: [],
    paths: {},
    notes: {},
    reveals: {},
    sounds: {},
    timing: {
      ppq: 960,
      beatZeroUs: 0,
      points: [{ id: randomUUID(), tick: 0, bpm: 120, meter: [4, 4] }],
    },
    camera: {
      enabled: false,
      base: { position: { x: size.width / 2, y: size.height / 2 }, zoom: 1, rotationRad: 0 },
      keys: {},
      shakes: {},
    },
    tracks: {
      order: ['music', 'notes', 'layers', 'outlines', 'sounds', 'camera'],
      collapsed: ['outlines', 'sounds', 'camera'],
      hidden: [],
    },
    mixer: {
      music: { gain: 0.5, muted: false },
      hit: { gain: 1, muted: false },
      animation: { gain: 1, muted: false },
    },
  });
  return p;
}
async function putAsset(p, dir, filename, bytes, extra) {
  const id = randomUUID(),
    relativePath = 'assets/' + filename;
  await fs.mkdir(path.join(dir, 'assets'), { recursive: true });
  await fs.writeFile(path.join(dir, relativePath), bytes);
  p.assets[id] = {
    id,
    relativePath,
    originalName: filename,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    byteLength: bytes.length,
    ...extra,
  };
  return id;
}
async function music(p, dir) {
  const a = base.assets[base.music.assetId],
    bytes = await fs.readFile(path.join(baseDir, a.relativePath));
  const id = await putAsset(p, dir, '节拍.wav', bytes, {
    kind: 'audio',
    audioRole: 'music',
    audio: a.audio,
  });
  p.music = { assetId: id, gain: 0.55 };
}
async function raster(p, dir, png, name, position, scale = 1) {
  const bytes = PNG.sync.write(png),
    assetId = await putAsset(p, dir, name + '.png', bytes, {
      kind: 'png',
      pixelSize: { width: png.width, height: png.height },
    });
  const sid = randomUUID(),
    id = randomUUID(),
    rect = { x: 0, y: 0, width: png.width, height: png.height };
  p.pixelSources[sid] = {
    id: sid,
    sourceAssetId: assetId,
    originalBounds: rect,
    cropRect: rect,
    levels: [
      {
        level: 0,
        scale: 1,
        pixelSize: { width: png.width, height: png.height },
        tileSize: Math.max(png.width, png.height),
        gutter: 0,
        tiles: [{ assetId, sourceRect: rect, pixelRect: rect }],
      },
    ],
  };
  p.layers[id] = {
    id,
    name,
    kind: 'raster',
    pixelSourceId: sid,
    transform: { ...identity(), position, scale: { x: scale, y: scale } },
    opacity: 1,
    enabled: true,
    locked: false,
    initialReveal: 1,
    blendMode: 'normal',
  };
  p.rootLayersBottomToTop.push(id);
  return id;
}
function circle(p, seconds) {
  const id = randomUUID();
  p.notes[id] = {
    id,
    kind: 'circle',
    at: { basis: 'time', timeUs: seconds * 1e6 },
    position: { x: 470, y: 470 },
    radius: 18,
  };
  return id;
}
function fan(mode = 'open', patch = {}) {
  return {
    kind: 'fan',
    center: { x: 0.5, y: 1 },
    startAngleRad: -Math.PI,
    sweepAngleRad: Math.PI,
    direction: 'clockwise',
    mode,
    ...patch,
  };
}
function reveal(p, layerId, at, duration, effect) {
  const id = randomUUID();
  p.reveals[id] = {
    id,
    layerId,
    trigger: { kind: 'timeline', at: { basis: 'time', timeUs: at * 1e6 } },
    effect,
    easing: 'linear',
    progress: { kind: 'elapsed', duration: { basis: 'time', durationUs: duration * 1e6 } },
    after: 'hold',
    priority: 0,
  };
  return id;
}
const fixture = document('扇形像素验证', { width: 1000, height: 1000 });
await music(fixture, results);
const pixels = new PNG({ width: 128, height: 128 });
const colors = [
  [232, 93, 117],
  [87, 199, 133],
  [86, 149, 237],
  [234, 185, 83],
];
for (let y = 0; y < 128; y++)
  for (let x = 0; x < 128; x++) {
    const color = colors[(y >= 64 ? 2 : 0) + (x >= 64 ? 1 : 0)],
      i = (y * 128 + x) * 4;
    pixels.data.set([...color, 255], i);
  }
const fixtureLayer = await raster(
  fixture,
  results,
  pixels,
  '四色 PNG',
  { x: 200, y: 200 },
  600 / 128,
);
circle(fixture, 1);
const fixtureFile = path.join(results, 'fixture.rcproj');
await fs.writeFile(fixtureFile, JSON.stringify(fixture, null, 2));

// Reassemble the supplied PSD's original lossless layer tiles into one unchanged PNG.
const originalLayer = Object.values(base.layers).find((l) => l.name.trim() === 'skirt_front');
const source = base.pixelSources[originalLayer.pixelSourceId];
const garment = new PNG({ width: source.cropRect.width, height: source.cropRect.height });
for (const tile of source.levels.find((l) => l.level === 0).tiles) {
  const image = PNG.sync.read(
    await fs.readFile(path.join(baseDir, base.assets[tile.assetId].relativePath)),
  );
  PNG.bitblt(
    image,
    garment,
    tile.pixelRect.x,
    tile.pixelRect.y,
    tile.pixelRect.width,
    tile.pixelRect.height,
    tile.sourceRect.x,
    tile.sourceRect.y,
  );
}
const demo = document('PNG 扇形展开与收拢', { width: 1600, height: 1800 });
await music(demo, example);
const demoLayer = await raster(demo, example, garment, '裙摆 PNG', { x: 268, y: 90 });
demo.layers[demoLayer].initialReveal = 0;
const demoClips = [
  reveal(demo, demoLayer, 1, 3, fan()),
  reveal(demo, demoLayer, 5, 3, fan('close')),
  reveal(
    demo,
    demoLayer,
    9,
    3,
    fan('open', {
      center: { x: 0.5, y: 0.5 },
      startAngleRad: -Math.PI / 2,
      sweepAngleRad: Math.PI * 2,
      direction: 'counterclockwise',
    }),
  ),
  reveal(
    demo,
    demoLayer,
    13,
    3,
    fan('close', {
      center: { x: 0.5, y: 0.5 },
      startAngleRad: -Math.PI / 2,
      sweepAngleRad: Math.PI * 2,
      direction: 'counterclockwise',
    }),
  ),
];
for (const t of [1, 5, 9, 13]) circle(demo, t);
const demoFile = path.join(example, 'PNG扇形展开与收拢.rcproj');
await fs.writeFile(demoFile, JSON.stringify(demo, null, 2));
const env = { ...process.env, RHYTHM_USER_DATA: path.join(results, 'profile') };
delete env.ELECTRON_RUN_AS_NODE;
delete env.ELECTRON_RENDERER_URL;
let app, page;
const report = { checks: [], errors: [], example: demoFile, exampleClipIds: demoClips };
async function check(name, task) {
  const evidence = await task();
  report.checks.push({ name, passed: true, evidence });
  console.log('PASS ' + name);
}
async function picker(file) {
  await app.evaluate(({ dialog }, file) => {
    globalThis.__originalOpen ??= dialog.showOpenDialog;
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] });
  }, file);
}
async function open(file) {
  await picker(file);
  await page.getByRole('button', { name: '打开', exact: true }).click();
  await page.locator('.editor-shell[aria-busy=false]').waitFor();
  await app.evaluate(({ dialog }) => {
    dialog.showOpenDialog = globalThis.__originalOpen;
  });
  await page.getByRole('button', { name: '适合窗口', exact: true }).click();
  await settle();
}
async function settle() {
  await page.waitForTimeout(150);
  await page.waitForFunction(
    () => Number(document.querySelector('[data-testid=canvas-host]').dataset.loading) === 0,
    null,
    { timeout: 10000 },
  );
}
async function property(label, value) {
  const el = page.getByLabel(label, { exact: true });
  await el.fill(String(value));
  await el.press('Tab');
  await settle();
}
async function progress(value) {
  await page.getByLabel('显现预览进度', { exact: true }).fill(String(value));
  await settle();
}
async function sample(points) {
  // Read the displayed canvas: an idle WebGL drawing buffer need not retain its pixels.
  const canvas = page.getByTestId('pixi-canvas'),
    box = await canvas.boundingBox(),
    png = PNG.sync.read(await canvas.screenshot());
  const view = await page.getByTestId('canvas-host').evaluate((el) => ({
    zoom: Number(el.dataset.zoom),
    x: Number(el.dataset.panX),
    y: Number(el.dataset.panY),
  }));
  return points.map((p) => {
    const x = Math.round(((view.x + p.x * view.zoom) * png.width) / box.width),
      y = Math.round(((view.y + p.y * view.zoom) * png.height) / box.height);
    return [...png.data.subarray((y * png.width + x) * 4, (y * png.width + x) * 4 + 3)];
  });
}

const points = [
  { x: 350, y: 350 },
  { x: 650, y: 350 },
  { x: 350, y: 650 },
  { x: 650, y: 650 },
];
async function expectColors(visible, at = points) {
  const actual = await sample(at);
  actual.forEach((rgb, i) => {
    const near = rgb.every((v, j) => Math.abs(v - colors[i][j]) < 12);
    assert.equal(near, visible[i], `quadrant ${i}: ${rgb}, expected visible=${visible[i]}`);
  });
  return actual;
}
try {
  app = await electron.launch({ args: [root], env });
  page = await app.firstWindow();
  page.setDefaultTimeout(8000);
  page.on('pageerror', (e) => report.errors.push(String(e)));
  await app.evaluate(({ BrowserWindow }) => {
    const w = BrowserWindow.getAllWindows()[0];
    w.setSize(1600, 1000);
    w.show();
    w.focus();
  });
  await open(fixtureFile);
  await check('UI creates a PNG fan with bottom-center defaults', async () => {
    await page.getByLabel('新绑定图层', { exact: true }).selectOption(fixtureLayer);
    await page.getByLabel('新绑定显现方式', { exact: true }).selectOption('fan');
    await page.getByRole('button', { name: '添加显现绑定', exact: true }).click();
    await property('显现时长', 2);
    await page.getByLabel('显现缓动', { exact: true }).selectOption('linear');
    assert.equal(await page.getByLabel('扇形中心 Y', { exact: true }).inputValue(), '100');
    await progress(0);
    await expectColors([false, false, false, false]);
    await progress(50);
    return expectColors([true, false, true, false]);
  });
  await check('Counterclockwise and closing use the correct moving edge', async () => {
    await page.getByLabel('扇形扫动方向', { exact: true }).selectOption('counterclockwise');
    await settle();
    await expectColors([false, true, false, true]);
    await page.getByLabel('扇形模式', { exact: true }).selectOption('close');
    await settle();
    await expectColors([true, false, true, false]);
    await progress(100);
    return expectColors([false, false, false, false]);
  });
  await check(
    'Undo/redo restore the mode; partial and 270-degree sectors stay masked',
    async () => {
      await page.getByRole('button', { name: '撤销', exact: true }).click();
      assert.equal(await page.getByLabel('扇形模式').inputValue(), 'open');
      await page.getByRole('button', { name: '重做', exact: true }).click();
      assert.equal(await page.getByLabel('扇形模式').inputValue(), 'close');
      await page.getByLabel('扇形模式').selectOption('open');
      await page.getByRole('button', { name: '图片中心', exact: true }).click();
      await property('扇形起始角', 0);
      await property('扇形角度范围', 90);
      await progress(100);
      await expectColors([false, false, false, true]);
      await property('扇形角度范围', 270);
      return expectColors([true, false, true, true]);
    },
  );
  await check('Saved fan parameters reopen unchanged', async () => {
    await page.getByRole('button', { name: '保存', exact: true }).click();
    await page.locator('.editor-shell[aria-busy=false]').waitFor();
    const saved = JSON.parse(await fs.readFile(fixtureFile, 'utf8')),
      clip = Object.values(saved.reveals)[0];
    assert.equal(clip.effect.kind, 'fan');
    assert.equal(clip.effect.sweepAngleRad, Math.PI * 1.5);
    await open(fixtureFile);
    await page.locator(`[data-reveal-id="${clip.id}"].reveal-select`).click();
    assert.equal(await page.getByLabel('扇形角度范围').inputValue(), '270');
    await progress(100);
    await expectColors([true, false, true, true]);
    return clip.effect;
  });
  await check('Rotated/scaled groups and camera preserve mask-to-image alignment', async () => {
    const grouped = structuredClone(fixture),
      id = randomUUID();
    grouped.id = randomUUID();
    grouped.layers[fixtureLayer].transform.position = { x: -300, y: -300 };
    grouped.layers[id] = {
      id,
      name: '旋转分组',
      kind: 'group',
      childrenBottomToTop: [fixtureLayer],
      isolation: 'isolated',
      transform: {
        ...identity(),
        position: { x: 500, y: 500 },
        rotationRad: Math.PI / 6,
        scale: { x: 0.8, y: 1 },
      },
      opacity: 1,
      enabled: true,
      locked: false,
      initialReveal: 0,
      blendMode: 'normal',
    };
    grouped.rootLayersBottomToTop = [id];
    grouped.camera.enabled = true;
    grouped.camera.base = {
      position: { x: 500, y: 500 },
      pivot: { x: 500, y: 500 },
      zoom: 1.1,
      rotationRad: -0.1,
    };
    reveal(grouped, id, 1, 1, fan());
    const file = path.join(results, 'grouped.rcproj');
    await fs.writeFile(file, JSON.stringify(grouped));
    await open(file);
    await property('定位到秒', 1.5);
    const transformed = points.map((p) => {
      const x = (p.x - 500) * 0.8,
        y = p.y - 500,
        xx = Math.cos(Math.PI / 6) * x - Math.sin(Math.PI / 6) * y,
        yy = Math.sin(Math.PI / 6) * x + Math.cos(Math.PI / 6) * y;
      return {
        x: 500 + (Math.cos(0.1) * xx - Math.sin(0.1) * yy) * 1.1,
        y: 500 + (Math.sin(0.1) * xx + Math.cos(0.1) * yy) * 1.1,
      };
    });
    return expectColors([true, false, true, false], transformed);
  });
  await check(
    'Real PSD-extracted PNG demonstrates opening and closing at random music times',
    async () => {
      await open(demoFile);
      await page.locator(`[data-reveal-id="${demoClips[0]}"].reveal-select`).click();
      for (const [at, alpha] of [
        [0, 0],
        [4.1, 1],
        [8.1, 0],
        [12.1, 1],
        [16.1, 0],
      ]) {
        await property('定位到秒', at);
        const c = demoClips[Math.min(3, Math.max(0, Math.floor((at - 1) / 4)))];
        await page.locator(`[data-reveal-id="${c}"].reveal-select`).click();
        await settle();
        assert.equal(
          Number(await page.getByTestId('reveal-state').getAttribute('data-alpha')),
          alpha,
        );
      }
      await page.locator(`[data-reveal-id="${demoClips[0]}"].reveal-select`).click();
      await property('定位到秒', 2.5);
      await page.locator('.fan-properties').scrollIntoViewIfNeeded();
      await page.screenshot({ path: path.join(results, 'fan-editor.png') });
      return { file: demoFile, clips: 4 };
    },
  );
  assert.deepEqual(report.errors, []);
} finally {
  await fs.writeFile(path.join(results, 'report.json'), JSON.stringify(report, null, 2));
  await app?.evaluate(({ app }) => app.exit(0)).catch(() => {});
  await app?.close();
}
