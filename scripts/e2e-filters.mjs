import { _electron as electron } from 'playwright';
import { promises as fs } from 'node:fs';
import { randomUUID, createHash } from 'node:crypto';
import { PNG } from 'pngjs';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const appRoot = process.env.RHYTHM_FILTER_APP_ROOT ?? root;
const label = process.argv.find((a) => a.startsWith('--label='))?.slice(8) ?? 'candidate';
const cases = process.argv
  .find((a) => a.startsWith('--cases='))
  ?.slice(8)
  .split(',');
const results = path.join(root, 'test-results', 'filters'),
  directory = path.join(results, label);
const fixtures = path.join(results, 'fixtures');
await fs.mkdir(directory, { recursive: true });
await fs.mkdir(fixtures, { recursive: true });
const realSource =
  process.env.RHYTHM_FILTER_PROJECT ??
  'C:/Users/00/.codex/worktrees/stage-2b-resources/音游编辑器/test-results/resources/candidate-final/saved/大PSD验收.rcproj';
const sourceFiles = {
  real: realSource,
  sample: path.join(root, 'test-results', 'compositing', 'project', '剪贴与蒙版.rcproj'),
};
const projectFiles = {};
for (const [key, source] of Object.entries(sourceFiles)) {
  const folder = path.join(fixtures, key),
    destination = path.join(folder, key + '.rcproj');
  try {
    await fs.access(destination);
  } catch {
    await fs.mkdir(folder, { recursive: true });
    await fs.cp(path.join(path.dirname(source), 'assets'), path.join(folder, 'assets'), {
      recursive: true,
    });
    const project = JSON.parse(await fs.readFile(source, 'utf8'));
    project.name = `2c ${key === 'real' ? '真实PSD' : '合成对照'}验收`;
    // A local six-second tone lets the exact same artwork exercise pause/rate/loop paths.
    const rate = 16000,
      samples = rate * 6,
      wav = Buffer.alloc(44 + samples * 2);
    wav.write('RIFF');
    wav.writeUInt32LE(wav.length - 8, 4);
    wav.write('WAVEfmt ', 8);
    wav.writeUInt32LE(16, 16);
    wav.writeUInt16LE(1, 20);
    wav.writeUInt16LE(1, 22);
    wav.writeUInt32LE(rate, 24);
    wav.writeUInt32LE(rate * 2, 28);
    wav.writeUInt16LE(2, 32);
    wav.writeUInt16LE(16, 34);
    wav.write('data', 36);
    wav.writeUInt32LE(samples * 2, 40);
    for (let i = 0; i < samples; i++)
      wav.writeInt16LE(Math.round(Math.sin((i / rate) * 880 * Math.PI) * 1500), 44 + i * 2);
    const id = randomUUID(),
      relativePath = `assets/audio/${id}.wav`;
    await fs.mkdir(path.join(folder, 'assets/audio'), { recursive: true });
    await fs.writeFile(path.join(folder, relativePath), wav);
    project.assets[id] = {
      id,
      kind: 'audio',
      relativePath,
      originalName: '验收节拍.wav',
      sha256: createHash('sha256').update(wav).digest('hex'),
      byteLength: wav.length,
      audio: { durationUs: 6000000, sampleRate: rate, channels: 1 },
    };
    project.music = { assetId: id, gain: 0.5 };
    const layers = Object.values(project.layers);
    const group = layers.find(
      (l) => l.kind === 'group' && !l.clippingBaseId && l.blendMode === 'normal',
    );
    const clipped = layers.find(
      (l) =>
        l.kind === 'raster' &&
        l.clippingBaseId &&
        l.blendMode === 'normal' &&
        !l.rasterMask?.enabled,
    );
    for (const [layer, effect] of [
      [group, { kind: 'fade' }],
      [clipped, { kind: 'directional', direction: { x: 1, y: 0 } }],
    ]) {
      if (!layer) continue;
      const id = randomUUID();
      project.reveals[id] = {
        id,
        layerId: layer.id,
        trigger: { kind: 'timeline', at: { basis: 'time', timeUs: 1000000 } },
        effect,
        easing: 'linear',
        progress: { kind: 'elapsed', duration: { basis: 'time', durationUs: 2000000 } },
        after: 'hold',
        priority: 0,
      };
    }
    await fs.writeFile(destination, JSON.stringify(project, null, 2));
  }
  projectFiles[key] = destination;
}
const profile = path.join(directory, `profile-${Date.now()}`);
// Reuse the same authorized assets for variants; only the current-format manifest changes.
for (const kind of ['masks-opaque', 'masks-disabled', 'transformed', 'normal-transformed']) {
  const file = path.join(path.dirname(projectFiles.sample), kind + '.rcproj');
  const p = JSON.parse(await fs.readFile(projectFiles.sample, 'utf8'));
  if (kind.startsWith('masks')) {
    for (const l of Object.values(p.layers))
      if (l.rasterMask) {
        if (kind === 'masks-opaque') l.opacity = 1;
        else l.rasterMask.enabled = false;
      }
  } else {
    for (const l of Object.values(p.layers))
      if (l.name !== '背景') {
        l.transform.scale = { x: 0.93, y: 1.07 };
        l.transform.rotationRad = Math.PI / 36;
      }
    p.camera.base.zoom = 0.95;
    p.camera.base.rotationRad = -Math.PI / 60;
    if (kind === 'normal-transformed') {
      for (const l of Object.values(p.layers)) {
        l.blendMode = 'normal';
        l.opacity = 1;
      }
    }
  }
  await fs.writeFile(file, JSON.stringify(p, null, 2));
  projectFiles[kind] = file;
}
const env = { ...process.env, RHYTHM_USER_DATA: profile };
delete env.ELECTRON_RUN_AS_NODE;
delete env.ELECTRON_RENDERER_URL;
const report = {
  label,
  checks: [],
  errors: [],
  limitations: [
    'Canvas screenshots include the editor board; pixel differences cover the same renderer and device, not Photoshop exports.',
    'filterPasses counts executed filters; it excludes mask texture drawing, stencil draws and final presentation. No speed threshold.',
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
async function ready() {
  await page.locator('.editor-shell[aria-busy=false]').waitFor();
  await page.waitForTimeout(120);
  const close = page.getByRole('button', { name: '关闭兼容提示', exact: true });
  if (await close.isVisible()) await close.click();
  await page.waitForFunction(
    () => document.querySelector('[data-testid=canvas-host]')?.dataset.loading === '0',
  );
  await page.waitForTimeout(250);
}
async function property(name, value) {
  const f = page.getByLabel(name, { exact: true });
  await f.focus();
  await page.evaluate(() => new Promise(requestAnimationFrame));
  await f.fill(String(value));
  await f.press('Tab');
  await ready();
}
async function metrics(name) {
  const f = path.join(directory, name + '.json');
  await choose(f, true);
  await page.getByRole('button', { name: '查看运行记录', exact: true }).click();
  await page.getByRole('button', { name: '保存性能记录', exact: true }).click();
  await ready();
  await page.getByRole('button', { name: '关闭运行记录', exact: true }).click();
  return JSON.parse(await fs.readFile(f, 'utf8'));
}
async function capture(name) {
  await ready();
  const file = path.join(directory, name + '.png');
  await page.getByTestId('pixi-canvas').screenshot({ path: file });
  const data = await metrics(name);
  const entry = { name, graphics: data.graphics };
  if (label !== 'baseline') {
    const a = PNG.sync.read(await fs.readFile(file)),
      b = PNG.sync.read(await fs.readFile(path.join(results, 'baseline', name + '.png')));
    assert.equal(a.width, b.width);
    assert.equal(a.height, b.height);
    let maximum = 0,
      changed = 0,
      large = 0,
      total = 0;
    for (let i = 0; i < a.data.length; i += 4) {
      let d = 0;
      for (let c = 0; c < 3; c++) d = Math.max(d, Math.abs(a.data[i + c] - b.data[i + c]));
      maximum = Math.max(maximum, d);
      if (d) changed++;
      if (d > 3) large++;
      total += d;
    }
    entry.pixels = {
      maximum,
      changed,
      overThree: large,
      mean: total / (a.width * a.height),
      count: a.width * a.height,
    };
    assert.equal(
      large,
      0,
      `${name}: ${large} pixels differ by more than the existing 3/255 compositing tolerance; max ${maximum}`,
    );
  }
  report.checks.push(entry);
  console.log(
    JSON.stringify({
      name,
      attached: data.graphics.layers.compositeFilters,
      executed: data.graphics.compositing,
      pixels: entry.pixels,
    }),
  );
  await fs.writeFile(path.join(directory, 'report.json'), JSON.stringify(report, null, 2));
}
try {
  app = await electron.launch({ args: [appRoot], cwd: root, env });
  page = await app.firstWindow();
  page.setDefaultTimeout(90000);
  page.on('pageerror', (e) => report.errors.push(String(e)));
  await page.getByTestId('pixi-canvas').waitFor();
  await app.evaluate(({ BrowserWindow }) => {
    const w = BrowserWindow.getAllWindows()[0];
    w.setSize(1600, 1000);
    w.show();
    w.focus();
  });
  for (const [key, file] of Object.entries(projectFiles)) {
    if (cases && !cases.includes(key)) continue;
    await choose(file);
    await page.getByRole('button', { name: '打开', exact: true }).click();
    await ready();
    await page.getByRole('button', { name: '适合窗口', exact: true }).click();
    await capture(key + '-fit');
    await page.getByRole('button', { name: '原尺寸', exact: true }).click();
    await capture(key + '-actual');
    await page.getByRole('button', { name: '适合窗口', exact: true }).click();
    if (key !== 'real' && key !== 'sample') continue;
    for (const time of [0, 1.5, 2.5, 3.5, 1.5, 0]) {
      await property('定位到秒', time);
      await capture(`${key}-time-${time}-${report.checks.length}`);
    }
    const project = JSON.parse(await fs.readFile(file, 'utf8')),
      group = Object.values(project.layers).find(
        (l) => l.kind === 'group' && !l.clippingBaseId && l.blendMode === 'normal',
      );
    if (group) {
      const row = page
        .locator('.layer-row')
        .filter({ has: page.locator('.layer-name', { hasText: new RegExp(`^${group.name}$`) }) })
        .first();
      await row.click();
      await property('图层不透明度', 55);
      await capture(key + '-opacity');
      await page.getByRole('button', { name: '撤销', exact: true }).click();
      await capture(key + '-undo');
      await page.getByRole('button', { name: '重做', exact: true }).click();
      await capture(key + '-redo');
      await page.getByRole('button', { name: '撤销', exact: true }).click();
      await ready();
      await property('图层旋转', 13);
      await property('图层缩放 X', 0.85);
      await capture(key + '-transform');
      for (let i = 0; i < 2; i++) {
        await page.getByRole('button', { name: '撤销', exact: true }).click();
        await ready();
      }
    }
    // Save/reopen still runs through the real file service; selection is intentionally reset.
    await choose(file, true);
    await page.getByRole('button', { name: '保存', exact: true }).click();
    await ready();
    assert.equal((await page.locator('.save-state').innerText()).trim(), '已保存');
    const saved = JSON.parse(await fs.readFile(file, 'utf8'));
    assert.deepEqual(saved.layers, project.layers);
    assert.deepEqual(saved.reveals, project.reveals);
    const count = await page.getByTestId('canvas-host').getAttribute('data-render-count');
    await page.waitForTimeout(600);
    assert.equal(await page.getByTestId('canvas-host').getAttribute('data-render-count'), count);
  }
  assert.deepEqual(report.errors, []);
  report.passed = true;
} catch (e) {
  report.passed = false;
  report.error = String(e.stack ?? e);
  console.error(report.error);
  process.exitCode = 1;
  await page?.screenshot({ path: path.join(directory, 'failure.png') }).catch(() => {});
} finally {
  await fs.writeFile(path.join(directory, 'report.json'), JSON.stringify(report, null, 2));
  if (app) {
    await app.evaluate(({ app }) => app.exit(0)).catch(() => {});
    await app.close().catch(() => {});
  }
}
