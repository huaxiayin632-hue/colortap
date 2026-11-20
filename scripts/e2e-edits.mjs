import { _electron as electron } from 'playwright';
import { PNG } from 'pngjs';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { smallFixtures } from './image-fixtures.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const directory = path.join(root, 'test-results', 'editing');
const fixtures = await smallFixtures(path.join(directory, 'fixtures'));
const environment = {
  ...process.env,
  RHYTHM_USER_DATA: path.join(directory, `profile-${Date.now()}`),
};
delete environment.ELECTRON_RUN_AS_NODE;
delete environment.ELECTRON_RENDERER_URL;
const report = { startedAt: new Date().toISOString(), checks: [], consoleErrors: [] };
let application, page;

function makeWav() {
  const rate = 16000,
    frames = rate * 6,
    bytes = Buffer.alloc(44 + frames * 2);
  bytes.write('RIFF');
  bytes.writeUInt32LE(bytes.length - 8, 4);
  bytes.write('WAVEfmt ', 8);
  bytes.writeUInt32LE(16, 16);
  bytes.writeUInt16LE(1, 20);
  bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(rate, 24);
  bytes.writeUInt32LE(rate * 2, 28);
  bytes.writeUInt16LE(2, 32);
  bytes.writeUInt16LE(16, 34);
  bytes.write('data', 36);
  bytes.writeUInt32LE(frames * 2, 40);
  for (let i = 0; i < frames; i++)
    bytes.writeInt16LE(Math.round(Math.sin((i * Math.PI * 440) / rate) * 2000), 44 + i * 2);
  return bytes;
}
const audioA = path.join(directory, 'fixtures', '音乐 A.wav'),
  audioB = path.join(directory, 'fixtures', '音乐 B.wav');
await fs.writeFile(audioA, makeWav());
await fs.writeFile(audioB, makeWav());
async function check(name, action) {
  const started = performance.now();
  try {
    const evidence = await action();
    report.checks.push({
      name,
      passed: true,
      elapsedMs: Math.round(performance.now() - started),
      evidence,
    });
    console.log(`PASS ${name}`);
  } catch (error) {
    report.checks.push({ name, passed: false, error: String(error) });
    throw error;
  }
}
async function choose(file, save = false) {
  await application.evaluate(
    ({ dialog }, { file, save }) => {
      if (save) dialog.showSaveDialog = async () => ({ canceled: false, filePath: file });
      else dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] });
    },
    { file, save },
  );
}
async function settled() {
  await page.waitForFunction(
    () => document.querySelector('.editor-shell')?.getAttribute('aria-busy') === 'false',
  );
}
async function readyTextures() {
  await settled();
  await page.waitForFunction(
    () =>
      Number(
        document.querySelector('[data-testid=canvas-host]')?.getAttribute('data-loading') ?? 1,
      ) === 0,
  );
  await page.evaluate(
    () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
  );
}
function row(name) {
  return page
    .locator('.layer-row')
    .filter({ has: page.locator('.layer-name', { hasText: new RegExp(`^${name}$`) }) });
}
async function property(label, value) {
  const field = page.getByLabel(label, { exact: true });
  await field.fill(String(value));
  await field.press('Tab');
}
async function history(name = '撤销') {
  await page.getByRole('button', { name, exact: true }).click();
  await settled();
}
async function importPicture(file) {
  await choose(file);
  await page.getByRole('button', { name: '＋ 导入 PSD / PNG', exact: true }).click();
  await page.getByRole('dialog', { name: '图片导入进度' }).waitFor({ state: 'hidden' });
  await readyTextures();
}
async function importMusic(file) {
  await choose(file);
  await page.getByRole('button', { name: '导入音乐', exact: true }).first().click();
  await settled();
  await page.locator('[data-testid=waveform][data-ready=true]').waitFor();
}
async function view() {
  return page.getByTestId('canvas-host').evaluate((el) => ({
    zoom: Number(el.dataset.zoom),
    x: Number(el.dataset.panX),
    y: Number(el.dataset.panY),
    width: el.clientWidth,
    height: el.clientHeight,
  }));
}
async function pixel(x, y) {
  const png = PNG.sync.read(await page.getByTestId('pixi-canvas').screenshot()),
    v = await view();
  const px = Math.round(((x * v.zoom + v.x) * png.width) / v.width);
  const py = Math.round(((y * v.zoom + v.y) * png.height) / v.height);
  assert.ok(px >= 0 && py >= 0 && px < png.width && py < png.height, 'sample must be on screen');
  return [...png.data.subarray((py * png.width + px) * 4, (py * png.width + px) * 4 + 4)];
}
function near(actual, expected) {
  for (let c = 0; c < 3; c++)
    assert.ok(Math.abs(actual[c] - expected[c]) <= 4, `${actual} differs from ${expected}`);
}
async function clickWorld(x, y) {
  const v = await view(),
    bounds = await page.getByTestId('pixi-canvas').boundingBox();
  await page.mouse.click(bounds.x + v.x + x * v.zoom, bounds.y + v.y + y * v.zoom);
}
async function save(file, as = false) {
  await choose(file, true);
  await page.getByRole('button', { name: as ? '另存为' : '保存', exact: true }).click();
  await settled();
  await page.waitForFunction(
    () => document.querySelector('.save-state')?.textContent?.trim() === '已保存',
  );
  return JSON.parse(await fs.readFile(file, 'utf8'));
}
async function timeUs() {
  return Number(await page.getByTestId('playhead').getAttribute('data-time-us'));
}

try {
  application = await electron.launch({ args: [root], cwd: root, env: environment });
  page = await application.firstWindow();
  page.setDefaultTimeout(30000);
  page.on('pageerror', (e) => report.consoleErrors.push(String(e)));
  page.on('console', (m) => {
    if (m.type() === 'error') report.consoleErrors.push(m.text());
  });
  await page.getByTestId('pixi-canvas').waitFor();
  await settled();
  await check('真实 PSD 初始位置和半透明嵌套组渲染', async () => {
    await importPicture(fixtures.psd);
    assert.equal(await page.getByRole('treeitem').count(), 6);
    near(await pixel(200, 160), [20, 120, 160]);
    near(await pixel(150, 195), [130, 105, 50]);
  });
  await check('修改宽高自动适合窗口，右侧/底部越界像素裁切，越界不可选中', async () => {
    await property('画板宽度', 200);
    await property('画板高度', 180);
    await readyTextures();
    const v = await view();
    assert.ok(Math.abs(v.zoom - Math.min((v.width - 96) / 200, (v.height - 80) / 180)) < 1e-6);
    near(await pixel(190, 160), [20, 120, 160]);
    near(await pixel(230, 160), [32, 34, 38]);
    near(await pixel(150, 195), [32, 34, 38]);
    await row('蓝色').click();
    await clickWorld(230, 160);
    assert.equal(await page.locator('.layer-row[aria-selected=true]').count(), 0);
    await page.screenshot({ path: path.join(directory, 'cropped.png') });
    return {
      viewport: v,
      outsideRight: await pixel(230, 160),
      outsideBottom: await pixel(150, 195),
    };
  });
  await check('裁切后移动/旋转分组立即更新，普通编辑保留缩放，撤销还原尺寸和原始像素', async () => {
    await row('半透明组').click();
    const zoom = (await view()).zoom;
    await property('图层 X', 30);
    await property('图层旋转', 8);
    await readyTextures();
    assert.equal((await view()).zoom, zoom);
    near(await pixel(230, 160), [32, 34, 38]);
    await history();
    await history();
    await history();
    await history();
    assert.equal(await page.getByLabel('画板宽度', { exact: true }).inputValue(), '640');
    assert.equal(await page.getByLabel('画板高度', { exact: true }).inputValue(), '480');
    await readyTextures();
    near(await pixel(200, 160), [20, 120, 160]);
    near(await pixel(150, 195), [130, 105, 50]);
  });
  await check('拖拽数值框预览只创建一次撤销项，并支持撤销/重做', async () => {
    await row('半透明组').click();
    const field = page.getByLabel('图层 X', { exact: true });
    await page.locator('.inspector-scroll').evaluate((el) => (el.scrollTop = 0));
    await field.scrollIntoViewIfNeeded();
    const original = Number(await field.inputValue()),
      bounds = await field.boundingBox();
    assert.ok(bounds);
    assert.equal(
      await field.evaluate((input, { x, y }) => document.elementFromPoint(x, y) === input, {
        x: bounds.x + 10,
        y: bounds.y + bounds.height / 2,
      }),
      true,
    );
    await field.evaluate((input) => input.blur());
    await page.mouse.move(bounds.x + 10, bounds.y + bounds.height / 2);
    await page.mouse.down();
    await page.mouse.move(bounds.x + 70, bounds.y + bounds.height / 2, { steps: 6 });
    await page.mouse.up();
    await settled();
    const scrubbed = Number(await field.inputValue());
    assert.ok(
      Math.abs(scrubbed - original - 60) < 0.1,
      `${scrubbed} should be 60 above ${original}`,
    );
    await page.keyboard.press('Control+z');
    await settled();
    assert.equal(Number(await field.inputValue()), original);
    await page.keyboard.press('Control+y');
    await settled();
    assert.equal(Number(await field.inputValue()), scrubbed);
    await page.keyboard.press('Control+z');
    await settled();
    assert.equal(Number(await field.inputValue()), original);
    return { original, scrubbed };
  });
  await check('PNG 图层删除、Ctrl+Z 撤销、重做、Delete 快捷键', async () => {
    await importPicture(fixtures.png);
    await row('透明边缘.png').click();
    await page.getByRole('button', { name: '删除选中图层或分组', exact: true }).click();
    assert.equal(await row('透明边缘.png').count(), 0);
    await page.keyboard.press('Control+z');
    await settled();
    await row('透明边缘.png').waitFor();
    await history('重做');
    assert.equal(await row('透明边缘.png').count(), 0);
    await history();
    await row('透明边缘.png').click();
    await page.keyboard.press('Delete');
    assert.equal(await row('透明边缘.png').count(), 0);
    await readyTextures();
    near(await pixel(200, 160), [20, 120, 160]);
  });
  await check('删除分组保护锁定子层，并可一次撤销/重做整个嵌套树', async () => {
    await page.getByLabel('锁定 蓝色', { exact: true }).click();
    await row('半透明组').click();
    await page.getByRole('button', { name: '删除选中图层或分组', exact: true }).click();
    assert.equal(await page.getByRole('treeitem').count(), 6);
    assert.match(await page.locator('.status-message').textContent(), /先解锁/);
    await page.getByLabel('解锁 蓝色', { exact: true }).click();
    await row('半透明组').click();
    await page.getByRole('button', { name: '删除选中图层或分组', exact: true }).click();
    assert.equal(await page.getByRole('treeitem').count(), 2);
    await readyTextures();
    near(await pixel(200, 160), [20, 180, 80]);
    await history();
    assert.equal(await page.getByRole('treeitem').count(), 6);
    await readyTextures();
    near(await pixel(200, 160), [20, 120, 160]);
    await history('重做');
    assert.equal(await page.getByRole('treeitem').count(), 2);
    // Saving after deletion must not prevent undo or portable save-as from restoring the subtree.
    await save(path.join(directory, 'deleted', '已删组.rcproj'));
    await history();
    const restored = await save(path.join(directory, 'restored', '已恢复.rcproj'), true);
    assert.equal(Object.keys(restored.layers).length, 6);
    await readyTextures();
    near(await pixel(200, 160), [20, 120, 160]);
  });
  await check('删除非当前音频保持播放，撤销也不打断当前音乐', async () => {
    await importMusic(audioA);
    await property('音乐音量', 45);
    await importMusic(audioB);
    await page.getByRole('button', { name: '播放', exact: true }).click();
    await page.waitForFunction(
      () =>
        Number(document.querySelector('[data-testid=playhead]')?.getAttribute('data-time-us')) >
        200000,
    );
    const before = await timeUs();
    await page.getByRole('button', { name: '删除音频 音乐 A.wav', exact: true }).click();
    await settled();
    assert.equal(await page.locator('.asset-item').count(), 1);
    assert.ok(await page.getByRole('button', { name: '暂停', exact: true }).isEnabled());
    await page.waitForFunction(
      (before) =>
        Number(document.querySelector('[data-testid=playhead]')?.getAttribute('data-time-us')) >
        before + 200000,
      before,
    );
    await history();
    assert.equal(await page.locator('.asset-item').count(), 2);
    assert.ok(await page.getByRole('button', { name: '暂停', exact: true }).isEnabled());
  });
  await check('删除当前音乐立即停止并清空波形，撤销恢复音量/波形且可正常播放', async () => {
    await page.getByRole('button', { name: '删除音频 音乐 B.wav', exact: true }).click();
    await settled();
    assert.ok(await page.getByRole('button', { name: '播放', exact: true }).isDisabled());
    assert.equal(await page.locator('[data-testid=waveform][data-ready=true]').count(), 0);
    assert.equal(await timeUs(), 0);
    await history();
    await page.locator('[data-testid=waveform][data-ready=true]').waitFor();
    assert.equal(await page.getByLabel('音乐音量', { exact: true }).inputValue(), '45');
    await page.getByRole('button', { name: '播放', exact: true }).click();
    await page.waitForFunction(
      () =>
        Number(document.querySelector('[data-testid=playhead]')?.getAttribute('data-time-us')) >
        200000,
    );
    await page.getByRole('button', { name: '暂停', exact: true }).click();
    await history('重做');
    assert.ok(await page.getByRole('button', { name: '播放', exact: true }).isDisabled());
    await history();
    await page.locator('[data-testid=waveform][data-ready=true]').waitFor();
    return { restoredVolume: await page.getByLabel('音乐音量', { exact: true }).inputValue() };
  });
  await check('删除和画板裁切保存重开保持一致，PSD/PNG/音频源文件字节保持不变', async () => {
    await page.getByRole('button', { name: '删除音频 音乐 B.wav', exact: true }).click();
    await settled();
    await page.getByRole('button', { name: '删除音频 音乐 A.wav', exact: true }).click();
    await settled();
    await row('半透明组').click();
    await page.getByRole('button', { name: '删除选中图层或分组', exact: true }).click();
    await property('画板宽度', 200);
    await property('画板高度', 180);
    const file = path.join(directory, 'final', '裁切与删除.rcproj'),
      saved = await save(file, true);
    assert.equal(Object.keys(saved.layers).length, 2);
    assert.equal(saved.music, undefined);
    assert.ok(!Object.values(saved.assets).some((a) => a.kind === 'audio'));
    assert.deepEqual(saved.stage.artworkSize, { width: 200, height: 180 });
    for (const source of [fixtures.psd, fixtures.png]) {
      const a = Object.values(saved.assets).find((a) => a.originalName === path.basename(source));
      assert.equal(
        createHash('sha256')
          .update(await fs.readFile(source))
          .digest('hex'),
        a.sha256,
      );
      assert.deepEqual(
        await fs.readFile(path.join(path.dirname(file), a.relativePath)),
        await fs.readFile(source),
      );
    }
    assert.deepEqual(await fs.readFile(audioA), makeWav());
    assert.deepEqual(await fs.readFile(audioB), makeWav());
    await choose(file);
    await page.getByRole('button', { name: '打开', exact: true }).click();
    await readyTextures();
    assert.equal(await page.getByRole('treeitem').count(), 2);
    assert.equal(await page.getByLabel('画板宽度', { exact: true }).inputValue(), '200');
    assert.equal(await page.locator('.asset-item').count(), 0);
    assert.ok(await page.getByRole('button', { name: '播放', exact: true }).isDisabled());
    near(await pixel(230, 160), [32, 34, 38]);
    await page.screenshot({ path: path.join(directory, 'reopened.png') });
    return {
      project: file,
      layers: Object.keys(saved.layers).length,
      artworkSize: saved.stage.artworkSize,
    };
  });
  assert.deepEqual(report.consoleErrors, []);
  report.passed = true;
} catch (error) {
  report.passed = false;
  report.error = String(error);
  console.error(error);
  process.exitCode = 1;
  await page?.screenshot({ path: path.join(directory, 'failure.png') }).catch(() => {});
} finally {
  report.finishedAt = new Date().toISOString();
  await fs.writeFile(path.join(directory, 'report.json'), JSON.stringify(report, null, 2));
  if (application) {
    await application.evaluate(({ app }) => app.exit(0)).catch(() => {});
    await application.close().catch(() => {});
  }
  const profile = path.resolve(environment.RHYTHM_USER_DATA);
  if (path.dirname(profile) !== directory || !/^profile-\d+$/.test(path.basename(profile)))
    throw new Error('Unsafe test profile cleanup');
  await fs.rm(profile, { recursive: true, force: true });
}
console.log(`Editing: ${report.checks.filter((c) => c.passed).length}/${report.checks.length}`);
