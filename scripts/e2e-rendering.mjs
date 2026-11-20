import { _electron as electron } from 'playwright';
import { PNG } from 'pngjs';
import { writePsdBuffer } from 'ag-psd';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root =
  process.env.RHYTHM_RENDER_ROOT ??
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const directory = path.join(root, 'test-results', 'rendering');
await fs.mkdir(directory, { recursive: true });
const report = { checks: [], errors: [], startedAt: new Date().toISOString() };
const profile = path.join(directory, `profile-${Date.now()}`);
const env = { ...process.env, RHYTHM_USER_DATA: profile };
delete env.ELECTRON_RUN_AS_NODE;
delete env.ELECTRON_RENDERER_URL;
let app, page;
async function check(name, action) {
  try {
    const evidence = await action();
    report.checks.push({ name, passed: true, evidence });
    console.log(`PASS ${name}`);
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
async function ready() {
  await settled();
  await page.waitForFunction(
    () => document.querySelector('[data-testid=canvas-host]')?.dataset.loading === '0',
  );
  await page.waitForTimeout(180);
}
async function property(name, value) {
  const field = page.getByLabel(name, { exact: true });
  await field.fill(String(value));
  await field.press('Tab');
}
async function save(name) {
  const file = path.join(directory, name + '.rcproj');
  await choose(file, true);
  await page.getByRole('button', { name: '另存为', exact: true }).click();
  await settled();
  await page.waitForFunction(
    () => document.querySelector('.save-state')?.textContent.trim() === '已保存',
  );
  return { file, project: JSON.parse(await fs.readFile(file, 'utf8')) };
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
async function picture(file) {
  await choose(file);
  await page.getByRole('button', { name: '＋ 导入 PSD / PNG', exact: true }).click();
  await page
    .getByRole('dialog', { name: '图片导入进度', exact: true })
    .waitFor({ state: 'hidden', timeout: 180000 });
  await ready();
}
async function newProject(name, size) {
  await page.getByRole('button', { name: '新建', exact: true }).click();
  const discard = page.getByRole('button', { name: '放弃修改', exact: true });
  if (await discard.count()) await discard.click();
  await page.getByLabel('新工程名称').fill(name);
  await page.getByLabel('新工程宽度').fill(String(size));
  await page.getByLabel('新工程高度').fill(String(size));
  await page.getByRole('button', { name: '创建工程', exact: true }).click();
  if (await discard.isVisible()) await discard.click();
  await settled();
}
const row = (name) =>
  page
    .locator('.layer-row')
    .filter({ has: page.locator('.layer-name', { hasText: new RegExp(`^${name}$`) }) });
async function sample(x, y) {
  const canvas = page.getByTestId('pixi-canvas'),
    box = await canvas.boundingBox();
  const view = await page.getByTestId('canvas-host').evaluate((el) => ({
    z: Number(el.dataset.zoom),
    x: Number(el.dataset.panX),
    y: Number(el.dataset.panY),
  }));
  const png = PNG.sync.read(await canvas.screenshot());
  const px = Math.round(((view.x + x * view.z) * png.width) / box.width),
    py = Math.round(((view.y + y * view.z) * png.height) / box.height);
  return [...png.data.subarray((py * png.width + px) * 4, (py * png.width + px) * 4 + 3)];
}
function near(actual, expected) {
  assert.ok(
    actual.every((v, i) => Math.abs(v - expected[i]) <= 5),
    `${actual} != ${expected}`,
  );
}
const count = () => page.getByTestId('canvas-host').getAttribute('data-render-count').then(Number);
async function idle() {
  await ready();
  const before = await count();
  await page.waitForTimeout(350);
  assert.equal(await count(), before, 'Idle canvas must stop rendering');
  return before;
}
const size = 2048,
  pixels = new Uint8ClampedArray(size * size * 4);
for (let i = 0; i < pixels.length; i += 4) pixels.set([40, 145, 205, 255], i);
const fixture = path.join(directory, 'continuous.psd');
await fs.writeFile(
  fixture,
  writePsdBuffer(
    {
      width: size,
      height: size,
      children: [
        { name: '底色', imageData: { width: size, height: size, data: pixels } },
        {
          name: '前景',
          left: 50,
          top: 50,
          imageData: { width: 32, height: 32, data: new Uint8ClampedArray(32 * 32 * 4).fill(255) },
        },
      ],
    },
    { noBackground: true },
  ),
);
try {
  app = await electron.launch({ args: [root], cwd: root, env });
  page = await app.firstWindow();
  page.setDefaultTimeout(60000);
  page.on('pageerror', (e) => report.errors.push(String(e)));
  await page.getByTestId('pixi-canvas').waitFor();
  await settled();
  await check('图层属性和显隐保留已有场景；静止停止绘制', async () => {
    await newProject('按需渲染验证', size);
    await picture(fixture);
    await row('前景').click();
    await ready();
    const before = await metrics('before-edits');
    const center = await sample(1024, 1024);
    near(center, [40, 145, 205]);
    await property('图层 X', 75);
    await ready();
    near(await sample(1024, 1024), center);
    await row('前景')
      .getByRole('button', { name: /隐藏|显示/ })
      .click();
    await ready();
    near(await sample(1024, 1024), center);
    await page.getByRole('button', { name: '撤销', exact: true }).click();
    await ready();
    const box = await page.getByTestId('pixi-canvas').boundingBox();
    const view = await page.getByTestId('canvas-host').evaluate((el) => ({
      z: Number(el.dataset.zoom),
      x: Number(el.dataset.panX),
      y: Number(el.dataset.panY),
    }));
    await page.mouse.move(box.x + view.x + 91 * view.z, box.y + view.y + 66 * view.z);
    await page.mouse.down();
    await page.mouse.move(box.x + view.x + 131 * view.z, box.y + view.y + 86 * view.z, {
      steps: 8,
    });
    near(await sample(1024, 1024), center);
    await page.mouse.up();
    await ready();
    assert.ok(
      Math.abs(Number(await page.getByLabel('图层 X', { exact: true }).inputValue()) - 115) < 3,
    );
    await page.getByRole('button', { name: '撤销', exact: true }).click();
    await ready();
    const after = await metrics('after-edits');
    assert.equal(
      after.graphics.layers.sceneLayersCreated,
      before.graphics.layers.sceneLayersCreated,
    );
    assert.equal(
      after.graphics.layers.sceneLayersRemoved,
      before.graphics.layers.sceneLayersRemoved,
    );
    return { framesAtRest: await idle(), gpu: after.graphics.gpu, layers: after.graphics.layers };
  });
  await check('延迟分块解码时缩放保留旧画面；素材就绪自行更新', async () => {
    await page.evaluate(() => {
      const decode = window.createImageBitmap;
      window.createImageBitmap = async (...args) => {
        await new Promise((r) => setTimeout(r, 220));
        if (window.__failNextTile) {
          window.__failNextTile = false;
          throw Error('Injected tile decode failure');
        }
        return decode(...args);
      };
    });
    await page.getByRole('button', { name: '原尺寸', exact: true }).click();
    const during = await sample(1024, 1024);
    near(during, [40, 145, 205]);
    const pending = await page.getByTestId('canvas-host').getAttribute('data-loading');
    assert.ok(
      Number(pending) > 0,
      'Continuity must be sampled while replacement tiles are loading',
    );
    await ready();
    near(await sample(1024, 1024), [40, 145, 205]);
    await page.getByRole('button', { name: '适合窗口', exact: true }).click();
    await ready();
    near(await sample(1024, 1024), [40, 145, 205]);
    return { during, pending, framesAtRest: await idle() };
  });
  await check('分块加载失败保留旧画面并结束替换，随后静止停止绘制', async () => {
    await newProject('失败回退验证', size);
    await picture(fixture);
    await page.evaluate(() => {
      window.__failNextTile = true;
    });
    await page.getByRole('button', { name: '原尺寸', exact: true }).click();
    await ready();
    near(await sample(1024, 1024), [40, 145, 205]);
    const record = await metrics('failed-replacement');
    assert.equal(record.graphics.layers.failed, 1);
    assert.ok(record.graphics.layers.rgbaBytesEstimate <= record.graphics.layers.budgetBytes);
    return { layers: record.graphics.layers, framesAtRest: await idle() };
  });
  await check('窗口大小和选中反馈唤醒绘制；撤销与保存重开正确', async () => {
    const before = await count();
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1350, 950));
    await ready();
    assert.ok((await count()) > before);
    near(await sample(1024, 1024), [40, 145, 205]);
    const saved = await save('synthetic');
    await choose(saved.file);
    await page.getByRole('button', { name: '打开', exact: true }).click();
    await ready();
    const reopened = await save('reopened');
    assert.deepEqual(reopened.project.layers, saved.project.layers);
    assert.deepEqual(reopened.project.pixelSources, saved.project.pixelSources);
    return { framesAtRest: await idle() };
  });
  await check('真实 PSD 新建工程：移动、显隐、属性、缩放及保存重开', async () => {
    await newProject('2a 真实 PSD 操作验证', 6000);
    await picture(process.env.RHYTHM_TEST_PSD ?? 'C:/Users/00/Pictures/灰泽满/插画53 多图层.psd');
    const initial = await save('real-psd');
    const layer = Object.values(initial.project.layers).find(
      (l) => l.kind === 'raster' && l.enabled && !l.locked,
    );
    assert.ok(layer);
    await row(layer.name).click();
    await ready();
    const before = await metrics('real-before');
    const input = page.getByLabel('图层 X', { exact: true });
    await input.scrollIntoViewIfNeeded();
    const box = await input.boundingBox();
    await page.mouse.move(box.x + 20, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + 140, box.y + box.height / 2, { steps: 16 });
    await page.mouse.up();
    await ready();
    assert.notEqual(Number(await input.inputValue()), layer.transform.position.x);
    await property('图层不透明度', 65);
    await ready();
    await row(layer.name)
      .getByRole('button', { name: /隐藏|显示/ })
      .click();
    await ready();
    for (let i = 0; i < 3; i++) {
      await page.getByRole('button', { name: '撤销', exact: true }).click();
      await ready();
    }
    await page.getByRole('button', { name: '放大画布', exact: true }).click();
    await ready();
    await page.getByRole('button', { name: '缩小画布', exact: true }).click();
    await ready();
    const after = await metrics('real-after');
    assert.equal(
      after.graphics.layers.sceneLayersCreated,
      before.graphics.layers.sceneLayersCreated,
    );
    const result = await save('real-result');
    assert.deepEqual(result.project.layers, initial.project.layers);
    await choose(result.file);
    await page.getByRole('button', { name: '打开', exact: true }).click();
    await ready();
    const reopened = await save('real-reopened');
    assert.deepEqual(reopened.project.layers, result.project.layers);
    await page.screenshot({ path: path.join(directory, 'real-psd.png') });
    return {
      project: result.file,
      gpu: after.graphics.gpu,
      layers: Object.keys(result.project.layers).length,
      framesAtRest: await idle(),
    };
  });
  assert.deepEqual(report.errors, []);
  report.passed = true;
} catch (error) {
  report.passed = false;
  report.error = error.stack ?? String(error);
  console.error(report.error);
  process.exitCode = 1;
  await page?.screenshot({ path: path.join(directory, 'failure.png') }).catch(() => {});
} finally {
  await fs.writeFile(path.join(directory, 'report.json'), JSON.stringify(report, null, 2));
  if (app) {
    await app.evaluate(({ app }) => app.exit(0)).catch(() => {});
    await app.close().catch(() => {});
  }
  if (
    path.dirname(path.resolve(profile)) !== path.resolve(directory) ||
    !/^profile-\d+$/.test(path.basename(profile))
  )
    throw Error('Unsafe profile');
  await fs.rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
