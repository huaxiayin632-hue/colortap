import { _electron as electron } from 'playwright';
import { promises as fs } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { PNG } from 'pngjs';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const results = path.join(root, 'test-results/filters');
const directory = path.join(results, 'acceptance');
await fs.mkdir(directory, { recursive: true });
const source = path.join(results, 'fixtures/real/real.rcproj');
const projectFile = path.join(path.dirname(source), '2c试用工程.rcproj');
const project = JSON.parse(await fs.readFile(source, 'utf8'));
await fs.writeFile(projectFile, JSON.stringify(project, null, 2));
const env = { ...process.env, RHYTHM_USER_DATA: path.join(directory, `profile-${Date.now()}`) };
delete env.ELECTRON_RUN_AS_NODE;
delete env.ELECTRON_RENDERER_URL;
const report = {
  checks: [],
  errors: [],
  project: projectFile,
  limitations: [
    'Silent CDP recording of actual Electron operations. File-picker responses are substituted; decoding, rendering, audio transport, edits and persistence are real.',
  ],
};
let app, page, capture;
const frames = [],
  writes = [];
const frameFolder = path.join(directory, `frames-${Date.now()}`);
const button = (name) => page.getByRole('button', { name, exact: true });
const head = () => page.getByTestId('playhead').getAttribute('data-time-us').then(Number);
const cycle = () => page.getByTestId('practice-state').getAttribute('data-cycle').then(Number);
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
  if (await button('关闭兼容提示').isVisible()) await button('关闭兼容提示').click();
  await page.waitForFunction(
    () => document.querySelector('[data-testid=canvas-host]')?.dataset.loading === '0',
  );
  await page.waitForTimeout(250);
}
async function property(label, value) {
  const field = page.getByLabel(label, { exact: true });
  await field.focus();
  await page.evaluate(() => new Promise(requestAnimationFrame));
  await field.fill(String(value));
  await field.press('Tab');
  await ready();
}
const seek = (seconds) => property('定位到秒', seconds);
async function pause() {
  if (await button('暂停').isVisible()) await button('暂停').click();
  await ready();
}
async function metrics(name) {
  const file = path.join(directory, name + '.json');
  await choose(file, true);
  await button('查看运行记录').click();
  await button('保存性能记录').click();
  await ready();
  await button('关闭运行记录').click();
  return JSON.parse(await fs.readFile(file, 'utf8')).graphics;
}
async function check(name, action) {
  const evidence = await action();
  report.checks.push({ name, passed: true, evidence });
  console.log('PASS ' + name);
  await fs.writeFile(path.join(directory, 'report.json'), JSON.stringify(report, null, 2));
}
async function pixels(name, reference) {
  const file = path.join(directory, name + '.png');
  await page.getByTestId('pixi-canvas').screenshot({ path: file });
  const a = PNG.sync.read(await fs.readFile(file));
  const b = PNG.sync.read(await fs.readFile(path.join(results, 'baseline', reference + '.png')));
  assert.equal(a.width, b.width);
  assert.equal(a.height, b.height);
  let maximum = 0,
    overThree = 0;
  for (let i = 0; i < a.data.length; i += 4) {
    let d = 0;
    for (let c = 0; c < 3; c++) d = Math.max(d, Math.abs(a.data[i + c] - b.data[i + c]));
    maximum = Math.max(maximum, d);
    if (d > 3) overThree++;
  }
  assert.equal(
    overThree,
    0,
    `${name}: max ${maximum}, ${overThree} pixels outside existing tolerance`,
  );
  return { maximum, overThree };
}
async function save() {
  await choose(projectFile, true);
  await button('保存').click();
  await ready();
  return JSON.parse(await fs.readFile(projectFile, 'utf8'));
}
try {
  app = await electron.launch({ args: [root], cwd: root, env });
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
  await choose(projectFile);
  await button('打开').click();
  await ready();
  await button('适合窗口').click();
  await ready();
  await fs.mkdir(frameFolder);
  capture = await app.context().newCDPSession(page);
  capture.on('Page.screencastFrame', (event) => {
    const file = `frame-${String(frames.length).padStart(6, '0')}.jpg`;
    frames.push({ file, time: event.metadata.timestamp });
    writes.push(fs.writeFile(path.join(frameFolder, file), Buffer.from(event.data, 'base64')));
    void capture.send('Page.screencastFrameAck', { sessionId: event.sessionId }).catch(() => {});
  });
  await capture.send('Page.startScreencast', {
    format: 'jpeg',
    quality: 85,
    maxWidth: 1600,
    maxHeight: 1000,
    everyNthFrame: 2,
  });
  const initial = await metrics('initial');
  await check('真实 PSD 连续播放、暂停与回跳；父组渐显和剪贴显现切换', async () => {
    await button('播放').click();
    await page.waitForTimeout(3700);
    await pause();
    assert.ok((await head()) > 3000000);
    await seek(1.5);
    const during = await metrics('during');
    assert.equal(during.layers.compositeFilters, initial.layers.compositeFilters + 2);
    const middle = await pixels('after-play-seek', 'real-time-1.5-3');
    await seek(3.5);
    const after = await metrics('after');
    assert.equal(after.layers.compositeFilters, initial.layers.compositeFilters);
    assert.equal(after.layers.sceneLayersCreated, initial.layers.sceneLayersCreated);
    assert.equal(after.layers.sceneLayersRemoved, initial.layers.sceneLayersRemoved);
    const complete = await pixels('after-play-complete', 'real-time-3.5-5');
    return {
      during: during.compositing,
      after: after.compositing,
      middle,
      complete,
      sceneLayersCreated: after.layers.sceneLayersCreated,
    };
  });
  await check('播放中 0.5× → 1×；循环跨越动态路径边界后像素保持一致', async () => {
    await seek(0);
    await page.getByLabel('播放倍率', { exact: true }).selectOption('0.5');
    await button('播放').click();
    await page.waitForTimeout(2200);
    const slowTime = await head();
    assert.ok(slowTime > 500000 && slowTime < 2000000);
    await page.getByLabel('播放倍率', { exact: true }).selectOption('1');
    await page.waitForTimeout(2200);
    await pause();
    assert.ok((await head()) > 3000000);
    await page.getByLabel('时间轴缩放', { exact: true }).evaluate((el) => {
      el.value = '100';
      el.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await page.getByTestId('timeline-scroll').evaluate((el) => {
      el.scrollLeft = 0;
      el.scrollTop = 0;
    });
    const box = await page.getByTestId('timeline-scroll').boundingBox();
    const lane = await page.getByTestId('loop-lane').boundingBox();
    await page.mouse.move(box.x + 50, lane.y + 12);
    await page.mouse.down();
    await page.mouse.move(box.x + 350, lane.y + 12, { steps: 8 });
    await page.mouse.up();
    await button('循环播放').click();
    await seek(0.5);
    const first = await cycle();
    await button('播放').click();
    await page.waitForTimeout(6600);
    assert.ok((await cycle()) >= first + 2);
    await pause();
    const cycles = await cycle();
    await button('清除循环').click();
    await seek(1.5);
    const comparison = await pixels('after-loops', 'real-time-1.5-3');
    const m = await metrics('after-loops');
    assert.equal(m.layers.sceneLayersCreated, initial.layers.sceneLayersCreated);
    assert.equal(m.layers.sceneLayersRemoved, 0);
    return { slowTime, cycles, comparison, compositing: m.compositing };
  });
  await check('编辑透明度、显隐、删除与撤销；保存重开保持 PSD 结构和演出', async () => {
    await seek(0);
    const group = Object.values(project.layers).find(
      (l) => l.kind === 'group' && !l.clippingBaseId && l.blendMode === 'normal',
    );
    const row = page.locator(`[data-layer-id="${group.id}"]`);
    await row.click();
    await property('图层不透明度', 55);
    const faded = await metrics('edited-opacity');
    assert.equal(faded.layers.compositeFilters, initial.layers.compositeFilters + 1);
    await button('撤销').click();
    await ready();
    await row.getByRole('button', { name: `隐藏 ${group.name}`, exact: true }).click();
    await ready();
    await button('撤销').click();
    await ready();
    // PSD groups containing locked children are intentionally not deletable.
    const deletable = (layer) =>
      !layer.locked &&
      (layer.kind !== 'group' ||
        layer.childrenBottomToTop.every((id) => deletable(project.layers[id])));
    const removable = Object.values(project.layers).find(
      (l) => l.kind === 'group' && !l.clippingBaseId && deletable(l),
    );
    assert.ok(removable);
    await page.locator(`[data-layer-id="${removable.id}"]`).click();
    await ready();
    assert.ok(await button('删除选中图层或分组').isEnabled());
    await button('删除选中图层或分组').click();
    await ready();
    const deleted = await metrics('deleted');
    assert.ok(deleted.layers.sceneLayersRemoved > 0);
    assert.ok(deleted.layers.compositeFilters < initial.layers.compositeFilters);
    await button('撤销').click();
    await ready();
    const restored = await metrics('restored');
    assert.equal(restored.layers.compositeFilters, initial.layers.compositeFilters);
    const saved = await save();
    for (const key of ['layers', 'rootLayersBottomToTop', 'pixelSources', 'reveals'])
      assert.deepEqual(saved[key], project[key]);
    await choose(projectFile);
    await button('打开').click();
    await ready();
    await button('适合窗口').click();
    await ready();
    const reopenedPixels = await pixels('reopened', 'real-fit');
    await seek(2);
    await button('Circle 工具').click();
    const canvas = await page.getByTestId('pixi-canvas').boundingBox();
    await page.mouse.click(canvas.x + canvas.width / 2, canvas.y + canvas.height / 2);
    await button('选择 工具').click();
    await seek(0);
    await button('播放').click();
    await page.waitForTimeout(3200);
    await pause();
    const shortChart = await save();
    assert.equal(Object.keys(shortChart.notes).length, Object.keys(project.notes).length + 1);
    return {
      deleted: deleted.layers.sceneLayersRemoved,
      restored: restored.layers.compositeFilters,
      pixels: reopenedPixels,
      notes: Object.keys(shortChart.notes).length,
    };
  });
  await check('切工程释放纹理和滤镜；暂停后停止绘制', async () => {
    await button('新建').click();
    await page.getByLabel('新工程名称').fill('2c 空工程检查');
    await button('创建工程').click();
    await ready();
    const empty = await metrics('empty');
    assert.equal(empty.layers.residentTextures, 0);
    assert.equal(empty.layers.compositeFilters, 0);
    assert.equal(empty.compositing.filterPasses, 0);
    assert.equal(empty.layers.loading + empty.layers.queued, 0);
    const count = await page.getByTestId('canvas-host').getAttribute('data-render-count');
    await page.waitForTimeout(600);
    assert.equal(await page.getByTestId('canvas-host').getAttribute('data-render-count'), count);
    return empty;
  });
  assert.deepEqual(report.errors, []);
  report.passed = true;
} catch (e) {
  report.passed = false;
  report.error = String(e.stack ?? e);
  process.exitCode = 1;
  console.error(report.error);
  await page?.screenshot({ path: path.join(directory, 'failure.png') }).catch(() => {});
} finally {
  if (capture) await capture.send('Page.stopScreencast').catch(() => {});
  await Promise.all(writes);
  if (app) {
    await app.evaluate(({ app }) => app.exit(0)).catch(() => {});
    await app.close().catch(() => {});
  }
  if (frames.length) {
    const lines = ['ffconcat version 1.0'];
    for (let i = 0; i < frames.length; i++)
      lines.push(
        `file '${frames[i].file}'`,
        `duration ${Math.max(0.001, (frames[i + 1]?.time ?? frames[i].time + 0.1) - frames[i].time)}`,
      );
    lines.push(`file '${frames.at(-1).file}'`);
    await fs.writeFile(path.join(frameFolder, 'frames.txt'), lines.join('\n'));
    execFileSync(
      'ffmpeg',
      [
        '-y',
        '-v',
        'error',
        '-f',
        'concat',
        '-safe',
        '1',
        '-i',
        path.join(frameFolder, 'frames.txt'),
        '-vf',
        'pad=ceil(iw/2)*2:ceil(ih/2)*2',
        '-r',
        '30',
        '-c:v',
        'libx264',
        '-crf',
        '22',
        '-pix_fmt',
        'yuv420p',
        '-movflags',
        '+faststart',
        path.join(directory, '减少滤镜通道验收.mp4'),
      ],
      { windowsHide: true },
    );
    // Own transient capture frames only; the video and evidence remain.
    if (path.dirname(frameFolder) !== directory) throw Error('Unsafe capture folder');
    await fs.rm(frameFolder, { recursive: true });
  }
  await fs.writeFile(path.join(directory, 'report.json'), JSON.stringify(report, null, 2));
}
