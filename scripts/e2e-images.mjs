import { _electron as electron } from 'playwright';
import { PNG } from 'pngjs';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { smallFixtures, largeFixture, denseFixture } from './image-fixtures.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const directory = path.join(root, 'test-results', 'stage2'),
  fixtures = path.join(directory, 'fixtures');
await fs.mkdir(directory, { recursive: true });
const small = await smallFixtures(fixtures);
const stress = process.argv.includes('--stress');
let dense;
if (stress) {
  try {
    dense = {
      psd: path.join(fixtures, '6000x6000-100层-全尺寸压力.psd'),
      metadata: JSON.parse(
        await fs.readFile(path.join(fixtures, 'dense-fixture-description.json'), 'utf8'),
      ),
    };
  } catch {
    dense = await denseFixture(fixtures);
  }
}
const bigPath = path.join(fixtures, '6000x6000-100层-典型裁剪.psd');
try {
  await fs.access(bigPath);
} catch {
  await largeFixture(fixtures);
}
const environment = {
  ...process.env,
  RHYTHM_USER_DATA: path.join(directory, `profile-${Date.now()}`),
};
delete environment.ELECTRON_RUN_AS_NODE;
delete environment.ELECTRON_RENDERER_URL;
const report = {
  stage: 2,
  startedAt: new Date().toISOString(),
  hardware: {
    platform: process.platform,
    release: os.release(),
    cpu: os.cpus()[0]?.model,
    logicalCores: os.cpus().length,
    ramBytes: os.totalmem(),
  },
  fixtures: JSON.parse(await fs.readFile(path.join(fixtures, 'fixture-description.json'), 'utf8')),
  checks: [],
  consoleErrors: [],
  measurements: {},
  limitations: [
    'PSD files are generated with ag-psd, not Photoshop-authored production illustrations.',
    'GPU bytes are managed RGBA estimates, not driver-reported VRAM.',
    'No Circle/Slider judgement or dynamic path masks in stage 2.',
  ],
};
let application, page;
async function check(name, fn) {
  const start = performance.now();
  try {
    const evidence = await fn();
    report.checks.push({
      name,
      passed: true,
      elapsedMs: Math.round(performance.now() - start),
      evidence,
    });
    console.log(`PASS ${name}`);
  } catch (e) {
    report.checks.push({ name, passed: false, error: String(e) });
    throw e;
  }
}
async function chooseOpen(file) {
  await application.evaluate(({ dialog }, file) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] });
  }, file);
}
async function chooseSave(file) {
  await application.evaluate(({ dialog }, file) => {
    dialog.showSaveDialog = async () => ({ canceled: false, filePath: file });
  }, file);
}
async function importPicture(file) {
  await chooseOpen(file);
  await page.getByRole('button', { name: '＋ 导入 PSD / PNG', exact: true }).click();
  await page
    .getByRole('dialog', { name: '图片导入进度', exact: true })
    .waitFor({ state: 'hidden', timeout: 600000 });
  await page.waitForFunction(
    () => document.querySelector('.editor-shell')?.getAttribute('aria-busy') === 'false',
  );
}
async function readyTextures() {
  await page.waitForFunction(
    () =>
      Number(
        document.querySelector('[data-testid=canvas-host]')?.getAttribute('data-loading') ?? 1,
      ) === 0,
    {},
    { timeout: 120000 },
  );
  await page.waitForTimeout(150);
}
function row(name) {
  return page
    .locator('.layer-row')
    .filter({ has: page.locator('.layer-name', { hasText: new RegExp(`^${name}$`) }) });
}
async function property(label, value) {
  const input = page.getByLabel(label, { exact: true });
  await input.fill(String(value));
  await input.press('Tab');
}
async function save(file) {
  await chooseSave(file);
  await page.getByRole('button', { name: '保存', exact: true }).click();
  await page.waitForFunction(
    () => document.querySelector('.editor-shell')?.getAttribute('aria-busy') === 'false',
    undefined,
    { timeout: 120000 },
  );
  await page.waitForFunction(
    () => document.querySelector('.save-state')?.textContent?.trim() === '已保存',
    undefined,
    { timeout: 120000 },
  );
  return JSON.parse(await fs.readFile(file, 'utf8'));
}
async function pixel(x, y) {
  const png = PNG.sync.read(await page.getByTestId('pixi-canvas').screenshot());
  const view = await page.getByTestId('canvas-host').evaluate((el) => ({
    zoom: Number(el.dataset.zoom),
    x: Number(el.dataset.panX),
    y: Number(el.dataset.panY),
    width: el.clientWidth,
    height: el.clientHeight,
  }));
  const px = Math.round(((x * view.zoom + view.x) * png.width) / view.width),
    py = Math.round(((y * view.zoom + view.y) * png.height) / view.height),
    i = (py * png.width + px) * 4;
  return [...png.data.subarray(i, i + 4)];
}
function near(actual, expected, tolerance = 4) {
  assert.equal(actual.length, 4);
  for (let i = 0; i < 3; i++)
    assert.ok(Math.abs(actual[i] - expected[i]) <= tolerance, `${actual} differs from ${expected}`);
}
async function performanceRecord(name) {
  const file = path.join(directory, `${name}-performance.json`);
  await chooseSave(file);
  await page.locator('.status-bar button').click();
  await page.getByRole('button', { name: '保存性能记录', exact: true }).click();
  await page.getByRole('button', { name: '返回编辑', exact: true }).click();
  return JSON.parse(await fs.readFile(file, 'utf8'));
}
async function profileFrames(milliseconds) {
  return page.evaluate(async (ms) => {
    let previous = performance.now();
    const frames = [];
    await new Promise((resolve) => {
      const end = previous + ms;
      const frame = (now) => {
        frames.push(now - previous);
        previous = now;
        if (now < end) requestAnimationFrame(frame);
        else resolve();
      };
      requestAnimationFrame(frame);
    });
    frames.shift();
    const sorted = [...frames].sort((a, b) => a - b),
      total = frames.reduce((a, b) => a + b, 0);
    return {
      windowMs: ms,
      samples: frames.length,
      fps: (1000 * frames.length) / total,
      p95Ms: sorted[Math.floor(sorted.length * 0.95)],
      maxMs: sorted.at(-1),
    };
  }, milliseconds);
}
try {
  application = await electron.launch({
    args: [root],
    cwd: root,
    env: environment,
    timeout: 30000,
  });
  page = await application.firstWindow();
  page.setDefaultTimeout(120000);
  page.on('pageerror', (e) => report.consoleErrors.push(String(e)));
  page.on('console', (m) => {
    if (m.type() === 'error') report.consoleErrors.push(m.text());
  });
  await page.getByTestId('pixi-canvas').waitFor();
  await page
    .getByRole('button', { name: '＋ 导入 PSD / PNG', exact: true })
    .waitFor({ state: 'visible' });
  await check('真实 PSD 导入、嵌套树、坐标及分组合成透明度', async () => {
    await importPicture(small.psd);
    await readyTextures();
    assert.equal(await page.getByRole('treeitem').count(), 6);
    near(await pixel(200, 160), [20, 120, 160]);
    near(await pixel(150, 120), [130, 105, 50]);
    near(await pixel(80, 80), [20, 180, 80]);
    await row('蓝色').click();
    assert.equal(await page.getByLabel('图层 X', { exact: true }).inputValue(), '180');
    assert.equal(await page.getByLabel('图层 Y', { exact: true }).inputValue(), '140');
    return { overlappingBlueGroup: await pixel(200, 160), redGroup: await pixel(150, 120) };
  });
  await check('隐藏/显示、锁定、折叠、属性变换及单步撤销', async () => {
    await page.getByLabel('隐藏 蓝色', { exact: true }).click();
    await readyTextures();
    near(await pixel(200, 160), [130, 105, 50]);
    await page.getByLabel('显示 蓝色', { exact: true }).click();
    await readyTextures();
    near(await pixel(200, 160), [20, 120, 160]);
    await page.getByLabel('锁定 蓝色', { exact: true }).click();
    assert.ok(await page.getByLabel('图层 X', { exact: true }).isDisabled());
    await page.getByLabel('解锁 蓝色', { exact: true }).click();
    await property('图层 X', 210);
    await property('图层缩放 X', 1.3);
    await property('图层缩放 Y', 0.8);
    await property('图层旋转', 15);
    await property('图层不透明度', 70);
    await page.getByRole('button', { name: '撤销', exact: true }).click();
    assert.equal(await page.getByLabel('图层不透明度', { exact: true }).inputValue(), '100');
    await page.getByRole('button', { name: '重做', exact: true }).click();
    assert.equal(await page.getByLabel('图层不透明度', { exact: true }).inputValue(), '70');
    await page.getByLabel('折叠 嵌套组', { exact: true }).click();
    assert.equal(await row('蓝色').count(), 0);
    await page.getByLabel('展开 嵌套组', { exact: true }).click();
    assert.equal(await row('蓝色').count(), 1);
  });
  await check('真实图层拖拽排序和跨组移动保持位置', async () => {
    await page.evaluate(() => {
      window.__dnd = [];
      for (const type of ['dragstart', 'dragover', 'drop', 'dragend'])
        document.addEventListener(
          type,
          (e) =>
            window.__dnd.push({
              type,
              name: e.target.closest?.('.layer-row')?.dataset.layerName,
              y: e.clientY,
              prevented: e.defaultPrevented,
            }),
          true,
        );
    });
    const from = row('红色'),
      to = row('底色');
    const fromRect = await from.boundingBox(),
      toRect = await to.boundingBox();
    await page.mouse.move(fromRect.x + 65, fromRect.y + 14);
    await page.mouse.down();
    await page.mouse.move(fromRect.x + 65, fromRect.y + 22, { steps: 4 });
    await page.mouse.move(toRect.x + 65, toRect.y + toRect.height - 3, { steps: 10 });
    await page.mouse.move(toRect.x + 67, toRect.y + toRect.height - 3);
    await page.mouse.up();
    const dragEvents = await page.evaluate(() => window.__dnd);
    assert.ok(dragEvents.some((e) => e.type === 'drop' && e.name === '底色'));
    const file = path.join(directory, 'small', '层编辑.rcproj');
    const saved = await save(file);
    const red = Object.values(saved.layers).find((l) => l.name === '红色');
    assert.ok(saved.rootLayersBottomToTop.includes(red.id));
    assert.deepEqual(red.transform.position, { x: 120, y: 100 });
    assert.ok(
      saved.rootLayersBottomToTop.indexOf(red.id) <
        saved.rootLayersBottomToTop.findIndex((id) => saved.layers[id].name === '底色'),
    );
    await row('底色').click();
    await page.getByRole('button', { name: '图层上移', exact: true }).click();
  });
  await check('PNG 原始分辨率与裁剪偏移，画布直接拖动只产生一步撤销', async () => {
    await importPicture(small.png);
    await readyTextures();
    await row('透明边缘.png').click();
    const before = Number(await page.getByLabel('图层 X', { exact: true }).inputValue());
    const view = await page.getByTestId('canvas-host').evaluate((el) => ({
      zoom: Number(el.dataset.zoom),
      x: Number(el.dataset.panX),
      y: Number(el.dataset.panY),
    }));
    const bounds = await page.getByTestId('pixi-canvas').boundingBox(),
      x = bounds.x + view.x + 100 * view.zoom,
      y = bounds.y + view.y + 90 * view.zoom;
    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.move(x + 45, y + 25, { steps: 8 });
    await page.mouse.up();
    assert.ok(Number(await page.getByLabel('图层 X', { exact: true }).inputValue()) > before + 20);
    await page.getByRole('button', { name: '撤销', exact: true }).click();
    assert.equal(Number(await page.getByLabel('图层 X', { exact: true }).inputValue()), before);
  });
  let savedSmall;
  await check('保存/重新打开，图层与所有资源完整恢复且与来源脱离', async () => {
    const file = path.join(directory, 'small', '层编辑.rcproj');
    savedSmall = await save(file);
    await chooseOpen(file);
    await page.getByRole('button', { name: '打开', exact: true }).click();
    await page.waitForFunction(
      () => document.querySelector('.save-state')?.textContent?.trim() === '已保存',
    );
    await readyTextures();
    const second = path.join(directory, 'portable', '可携带.rcproj');
    await chooseSave(second);
    await page.getByRole('button', { name: '另存为', exact: true }).click();
    await page.waitForTimeout(400);
    const copy = JSON.parse(await fs.readFile(second, 'utf8'));
    assert.deepEqual(copy.layers, savedSmall.layers);
    assert.deepEqual(copy.pixelSources, savedSmall.pixelSources);
    for (const asset of Object.values(copy.assets))
      assert.equal(
        (await fs.stat(path.join(path.dirname(second), asset.relativePath))).size,
        asset.byteLength,
      );
    return { layers: Object.keys(copy.layers).length, assets: Object.keys(copy.assets).length };
  });
  await check('损坏 PSD、高位深和未实现混合模式有明确提示且不破坏原工程', async () => {
    const count = await page.getByRole('treeitem').count();
    await importPicture(small.bad);
    assert.match(await page.locator('.status-message').innerText(), /有效的 PSD/);
    assert.equal(await page.getByRole('treeitem').count(), count);
    await importPicture(small.highBit);
    assert.match(await page.locator('.status-message').innerText(), /8 位 RGB/);
    await importPicture(small.warning);
    await page.getByRole('dialog', { name: 'PSD 兼容提示' }).waitFor();
    assert.match(await page.getByRole('dialog', { name: 'PSD 兼容提示' }).innerText(), /screen/);
    await page.getByLabel('关闭兼容提示', { exact: true }).click();
  });
  await check('6000 × 6000 / 100 可渲染层后台导入，界面持续响应', async () => {
    await page.getByRole('button', { name: '新建', exact: true }).click();
    await page.getByLabel('新工程名称', { exact: true }).fill('阶段2 · 6000像素图层练习');
    await page.getByRole('button', { name: '创建工程', exact: true }).click();
    await page.getByRole('button', { name: '放弃修改', exact: true }).click();
    await page.getByRole('dialog', { name: '新建工程', exact: true }).waitFor({ state: 'hidden' });
    await page.evaluate(() => {
      window.__importFrames = [];
      let prev = performance.now();
      window.__importMeasure = true;
      const frame = (now) => {
        if (!window.__importMeasure) return;
        window.__importFrames.push(now - prev);
        prev = now;
        requestAnimationFrame(frame);
      };
      requestAnimationFrame(frame);
    });
    const start = performance.now(),
      memory = [];
    const task = importPicture(bigPath);
    let finished = false;
    void task.then(
      () => {
        finished = true;
      },
      () => {
        finished = true;
      },
    );
    while (!finished) {
      const sample = await page.evaluate(() => window.desktop.processSample());
      if (sample.ok) memory.push(sample.value);
      await page.waitForTimeout(100);
    }
    await task;
    const wallMs = Math.round(performance.now() - start);
    await readyTextures();
    assert.equal(await page.getByRole('treeitem').count(), 110);
    const frames = await page.evaluate(() => {
      window.__importMeasure = false;
      return window.__importFrames;
    });
    const recording = await performanceRecord('large-import');
    assert.equal(recording.lastImageImport.metrics.rasterLayers, 100);
    assert.equal(recording.lastImageImport.metrics.groups, 10);
    report.measurements.import = {
      wallMs,
      worker: recording.lastImageImport.metrics,
      processSamples: memory,
      uiFrames: {
        samples: frames.length,
        maxMs: Math.max(...frames),
        meanMs: frames.reduce((a, b) => a + b, 0) / frames.length,
      },
    };
    assert.ok(frames.length > 10);
    assert.ok(recording.graphics.layers.failed === 0);
    return {
      wallMs,
      worker: recording.lastImageImport.metrics,
      uiFrames: report.measurements.import.uiFrames,
    };
  });
  await check('后台导入可取消且保留现有图层', async () => {
    const count = await page.getByRole('treeitem').count();
    await chooseOpen(bigPath);
    await page.getByRole('button', { name: '＋ 导入 PSD / PNG', exact: true }).click();
    await page.getByRole('dialog', { name: '图片导入进度', exact: true }).waitFor();
    await page.waitForTimeout(120);
    await page.getByRole('button', { name: '取消导入', exact: true }).click();
    await page
      .getByRole('dialog', { name: '图片导入进度', exact: true })
      .waitFor({ state: 'hidden' });
    assert.match(await page.locator('.status-message').innerText(), /已取消/);
    assert.equal(await page.getByRole('treeitem').count(), count);
  });
  await check('100 层缩放/平移、按需 LOD、排序及高清原像素检查', async () => {
    near(await pixel(2985, 2940), [233, 183, 111], 8);
    await page.screenshot({ path: path.join(directory, 'large-overview.png') });
    const overview = await performanceRecord('large-overview');
    report.measurements.overview = {
      frames: await profileFrames(3500),
      graphics: overview.graphics,
      processes: overview.processes.at(-1),
    };
    await row('色环 050').click();
    await page.getByRole('button', { name: '原尺寸', exact: true }).click();
    await readyTextures();
    const detail = await performanceRecord('large-detail');
    assert.equal(detail.graphics.layers.selectedLevel, 0);
    assert.ok(
      detail.graphics.layers.rgbaBytesEstimate <
        detail.graphics.layers.budgetBytes + 8 * 1024 * 1024,
    );
    const canvas = await page.getByTestId('pixi-canvas').boundingBox();
    await page.mouse.move(canvas.x + canvas.width / 2, canvas.y + canvas.height / 2);
    await page.mouse.down({ button: 'middle' });
    await page.mouse.move(canvas.x + canvas.width / 2 + 120, canvas.y + canvas.height / 2 + 90, {
      steps: 12,
    });
    await page.mouse.up({ button: 'middle' });
    await readyTextures();
    await page.screenshot({ path: path.join(directory, 'large-detail.png') });
    report.measurements.detail = { frames: await profileFrames(3500), graphics: detail.graphics };
    await page.getByRole('button', { name: '适合窗口', exact: true }).click();
    await readyTextures();
    await row('色环 050').click();
    await page.getByRole('button', { name: '图层上移', exact: true }).click();
    await page.getByLabel('隐藏 色环 050', { exact: true }).click();
    await page.getByLabel('显示 色环 050', { exact: true }).click();
  });
  await check('大工程音乐、时间轴跳转与保存重新打开回归', async () => {
    await chooseOpen(path.join(root, 'test-results/e2e/输入素材/示例节拍 120BPM.wav'));
    await page.getByRole('button', { name: '导入音乐', exact: true }).first().click();
    await page.getByRole('button', { name: '播放', exact: true }).waitFor({ state: 'visible' });
    await page.getByRole('button', { name: '播放', exact: true }).click();
    await page.waitForTimeout(800);
    await page.getByRole('button', { name: '暂停', exact: true }).click();
    const frozen = await page.getByTestId('current-time').innerText();
    await page.waitForTimeout(150);
    assert.equal(await page.getByTestId('current-time').innerText(), frozen);
    await property('定位到秒', 5);
    assert.match(await page.getByTestId('current-time').innerText(), /00:05/);
    const file = path.join(directory, '示例工程', '6000像素图层练习.rcproj'),
      saved = await save(file);
    await chooseOpen(file);
    await page.getByRole('button', { name: '打开', exact: true }).click();
    await page.waitForFunction(
      () => document.querySelector('.save-state')?.textContent?.trim() === '已保存',
    );
    await readyTextures();
    assert.equal(await page.getByRole('treeitem').count(), 110);
    await page.getByRole('button', { name: '播放', exact: true }).click();
    await page.waitForTimeout(400);
    await page.getByRole('button', { name: '暂停', exact: true }).click();
    const again = await save(file);
    assert.deepEqual(again.layers, saved.layers);
    assert.deepEqual(again.pixelSources, saved.pixelSources);
    assert.deepEqual(again.music, saved.music);
    await page.screenshot({ path: path.join(directory, 'editor.png') });
    report.measurements.final = await performanceRecord('final');
    return { file, layers: Object.keys(saved.layers).length };
  });
  if (stress)
    await check('100 张 6000 × 6000 全尺寸图层压力测试', async () => {
      await page.getByRole('button', { name: '新建', exact: true }).click();
      await page.getByLabel('新工程名称', { exact: true }).fill('全尺寸压力测试');
      await page.getByRole('button', { name: '创建工程', exact: true }).click();
      await page
        .getByRole('dialog', { name: '新建工程', exact: true })
        .waitFor({ state: 'hidden' });
      const start = performance.now(),
        samples = [];
      let done = false;
      const task = importPicture(dense.psd);
      void task.then(
        () => {
          done = true;
        },
        () => {
          done = true;
        },
      );
      while (!done) {
        const sample = await page.evaluate(() => window.desktop.processSample());
        if (sample.ok) samples.push(sample.value);
        await page.waitForTimeout(250);
      }
      await task;
      await readyTextures();
      const overview = await performanceRecord('dense-overview');
      assert.equal(overview.lastImageImport.metrics.rasterLayers, 100);
      assert.ok(overview.graphics.layers.failed === 0);
      const expected = [32, 40, 53],
        palette = [
          [60, 120, 180],
          [180, 120, 60],
          [120, 180, 60],
          [60, 180, 120],
        ],
        alpha = (200 / 255) * (Math.round(0.65 * 255) / 255);
      for (let i = 0; i < 100; i++)
        for (let c = 0; c < 3; c++)
          expected[c] = palette[i % 4][c] * alpha + expected[c] * (1 - alpha);
      near(await pixel(3000, 3000), expected, 5);
      report.measurements.dense = {
        fixture: dense.metadata,
        wallMs: Math.round(performance.now() - start),
        worker: overview.lastImageImport.metrics,
        overview: { frames: await profileFrames(3500), graphics: overview.graphics },
        processSamples: samples,
      };
      await page.screenshot({ path: path.join(directory, 'dense-overview.png') });
      await row('全尺寸 100').click();
      await page.getByRole('button', { name: '原尺寸', exact: true }).click();
      await readyTextures();
      const detail = await performanceRecord('dense-detail');
      assert.equal(detail.graphics.layers.selectedLevel, 0);
      assert.ok(detail.graphics.layers.failed === 0);
      report.measurements.dense.detail = {
        frames: await profileFrames(3500),
        graphics: detail.graphics,
      };
      const denseFile = path.join(directory, '全尺寸压力工程', '压力工程.rcproj');
      const saveStarted = performance.now();
      const savedDense = await save(denseFile);
      report.measurements.dense.savedProject = denseFile;
      report.measurements.dense.saveMs = Math.round(performance.now() - saveStarted);
      await chooseOpen(denseFile);
      await page.getByRole('button', { name: '打开', exact: true }).click();
      await page.waitForFunction(
        () => document.querySelector('.editor-shell')?.getAttribute('aria-busy') === 'false',
      );
      await readyTextures();
      assert.equal(await page.getByRole('treeitem').count(), 102);
      near(await pixel(3000, 3000), expected, 5);
      const reopenedDense = await save(denseFile);
      assert.deepEqual(reopenedDense.layers, savedDense.layers);
      assert.deepEqual(reopenedDense.pixelSources, savedDense.pixelSources);
      return {
        wallMs: report.measurements.dense.wallMs,
        worker: overview.lastImageImport.metrics,
        overview: report.measurements.dense.overview.frames,
        detail: report.measurements.dense.detail.frames,
      };
    });
  assert.deepEqual(report.consoleErrors, []);
  report.passed = true;
} catch (error) {
  report.passed = false;
  report.error = String(error);
  console.error(error);
  if (page) await page.screenshot({ path: path.join(directory, 'failure.png') }).catch(() => {});
  process.exitCode = 1;
} finally {
  report.finishedAt = new Date().toISOString();
  await fs.writeFile(path.join(directory, stress?'stress-report.json':'report.json'), JSON.stringify(report, null, 2));
  if (application) {
    await application.evaluate(({ app }) => app.exit(0)).catch(() => {});
    await application.close().catch(() => {});
  }
  // This exact timestamped directory belongs only to this run; never delete projects/fixtures.
  const profile = path.resolve(environment.RHYTHM_USER_DATA);
  if (path.dirname(profile) !== directory || !/^profile-\d+$/.test(path.basename(profile)))
    throw new Error('Unsafe test profile cleanup');
  await fs.rm(profile, { recursive: true, force: true });
}
console.log(`Stage 2: ${report.checks.filter((x) => x.passed).length}/${report.checks.length}`);
