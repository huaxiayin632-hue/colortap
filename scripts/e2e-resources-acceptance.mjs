import { _electron as electron } from 'playwright';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const directory = path.join(root, 'test-results', 'resources', 'acceptance');
const source = path.join(root, 'test-results', 'resources', 'candidate-final', 'saved');
await fs.mkdir(directory, { recursive: true });
const folder = path.join(directory, '工程');
await fs.cp(source, folder, { recursive: true });
const file = path.join(folder, '大PSD验收.rcproj');
const profile = path.join(directory, `profile-${Date.now()}`);
const env = { ...process.env, RHYTHM_USER_DATA: profile };
delete env.ELECTRON_RUN_AS_NODE;
delete env.ELECTRON_RENDERER_URL;
const report = { checks: [], errors: [], project: file, profile };
let app, page, capture;
const frames = [],
  writes = [];
const frameFolder = path.join(directory, 'frames');
await fs.mkdir(frameFolder, { recursive: true });
async function check(name, action) {
  const evidence = await action();
  report.checks.push({ name, passed: true, evidence });
  console.log('PASS ' + name);
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
async function ready() {
  await page.locator('.editor-shell[aria-busy=false]').waitFor();
  const warnings = page.getByRole('button', { name: '关闭兼容提示', exact: true });
  if (await warnings.isVisible()) await warnings.click();
  await page.waitForTimeout(200);
  await page.waitForFunction(
    () => document.querySelector('[data-testid=canvas-host]')?.dataset.loading === '0',
  );
  await page.waitForTimeout(200);
}
async function metrics(name) {
  const file = path.join(directory, name + '.json');
  await choose(file, true);
  await page.getByRole('button', { name: '查看运行记录', exact: true }).click();
  await page.getByRole('button', { name: '保存性能记录', exact: true }).click();
  await ready();
  await page.getByRole('button', { name: '关闭运行记录', exact: true }).click();
  return JSON.parse(await fs.readFile(file, 'utf8')).graphics;
}
async function budget(value) {
  await page.getByRole('button', { name: '查看运行记录', exact: true }).click();
  await page.getByLabel('纹理预算（本机）').selectOption(String(value));
  await page.getByRole('button', { name: '关闭运行记录', exact: true }).click();
  await ready();
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
  await choose(file);
  await page.getByRole('button', { name: '打开', exact: true }).click();
  await ready();
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
  await check('本机预算提高可见清晰度，设置不修改工程；回退保留画面', async () => {
    await page.getByRole('button', { name: '原尺寸', exact: true }).click();
    await ready();
    const low = await metrics('budget192');
    await budget(512);
    const high = await metrics('budget512');
    assert.ok(
      low.layers.levelBias > high.layers.levelBias,
      'more visible detail fits the chosen budget',
    );
    assert.equal(high.layers.loading + high.layers.queued, 0);
    assert.equal(high.layers.failed, 0);
    assert.equal((await page.locator('.save-state').innerText()).trim(), '已保存');
    await page.screenshot({ path: path.join(directory, '高清.png') });
    await budget(192);
    await page.getByRole('button', { name: '适合窗口', exact: true }).click();
    await ready();
    await page.waitForTimeout(2500);
    const reclaimed = await metrics('reclaimed');
    assert.ok(reclaimed.layers.rgbaBytesEstimate < low.layers.rgbaBytesEstimate);
    return { low: low.layers, high: high.layers, reclaimed: reclaimed.layers };
  });
  await check('真实 PSD 显隐、透明度、位置、撤销以及保存重开保持内容', async () => {
    const project = JSON.parse(await fs.readFile(file, 'utf8'));
    const layer = Object.values(project.layers).find(
      (l) => l.kind === 'raster' && l.enabled && !l.locked && !l.parentId,
    );
    assert.ok(layer);
    const row = page
      .locator('.layer-row')
      .filter({ has: page.locator('.layer-name', { hasText: new RegExp(`^${layer.name}$`) }) })
      .first();
    await row.click();
    for (const [label, value] of [
      ['图层 X', layer.transform.position.x + 40],
      ['图层不透明度', 60],
    ]) {
      await page.getByLabel(label, { exact: true }).fill(String(value));
      await page.getByLabel(label, { exact: true }).press('Tab');
      await ready();
    }
    await row.getByRole('button', { name: /隐藏|显示/ }).click();
    await ready();
    for (let i = 0; i < 3; i++) {
      await page.getByRole('button', { name: '撤销', exact: true }).click();
      await ready();
    }
    await page.getByRole('button', { name: '保存', exact: true }).click();
    await ready();
    const saved = JSON.parse(await fs.readFile(file, 'utf8'));
    assert.deepEqual(saved.layers, project.layers);
    assert.deepEqual(saved.pixelSources, project.pixelSources);
    return { layer: layer.name, layers: Object.keys(saved.layers).length };
  });
  await check('真实 PSD 短谱面播放与编辑可用', async () => {
    const music = path.join(root, 'test-results', 'recovery', 'fixtures', '音乐.wav');
    await choose(music);
    await page.getByRole('button', { name: '导入音乐', exact: false }).first().click();
    await ready();
    await page.getByRole('button', { name: 'Circle 工具', exact: true }).click();
    const box = await page.getByTestId('pixi-canvas').boundingBox();
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    await page.getByRole('button', { name: '选择 工具', exact: true }).click();
    await page.getByRole('button', { name: '播放', exact: true }).click();
    await page.waitForTimeout(1200);
    await page.getByRole('button', { name: '暂停', exact: true }).click();
    await page.getByRole('button', { name: '保存', exact: true }).click();
    await ready();
    const saved = JSON.parse(await fs.readFile(file, 'utf8'));
    assert.ok(saved.music);
    assert.ok(Object.keys(saved.notes).length > 0);
    return { notes: Object.keys(saved.notes).length };
  });
  await check('素材同大小损坏拒绝保存；恢复原素材后可保存与另存重开', async () => {
    const before = await fs.readFile(file, 'utf8'),
      project = JSON.parse(before);
    const asset = Object.values(project.assets).find((a) => a.kind === 'psd');
    const assetFile = path.join(folder, asset.relativePath);
    const bytes = await fs.readFile(assetFile),
      stat = await fs.stat(assetFile);
    const broken = Buffer.from(bytes);
    broken[broken.length - 1] ^= 255;
    await fs.writeFile(assetFile, broken);
    await fs.utimes(assetFile, stat.atime, stat.mtime);
    try {
      await page.getByLabel('BPM', { exact: true }).fill('141');
      await page.getByLabel('BPM', { exact: true }).press('Tab');
      await page.getByRole('button', { name: '保存', exact: true }).click();
      await ready();
      assert.equal(await fs.readFile(file, 'utf8'), before);
      assert.ok((await page.locator('.save-state').innerText()).includes('未保存'));
      await page.screenshot({ path: path.join(directory, '素材损坏拒绝保存.png') });
    } finally {
      await fs.writeFile(assetFile, bytes);
    }
    const copy = path.join(directory, '另存', '大PSD副本.rcproj');
    await choose(copy, true);
    await page.getByRole('button', { name: '另存为', exact: true }).click();
    await ready();
    assert.equal((await page.locator('.save-state').innerText()).trim(), '已保存');
    const saved = JSON.parse(await fs.readFile(copy, 'utf8'));
    for (const a of Object.values(saved.assets)) {
      const content = await fs.readFile(path.join(path.dirname(copy), a.relativePath));
      assert.equal(content.length, a.byteLength);
      assert.equal(createHash('sha256').update(content).digest('hex'), a.sha256);
    }
    await choose(copy);
    await page.getByRole('button', { name: '打开', exact: true }).click();
    await ready();
    assert.equal(Number(await page.getByLabel('BPM', { exact: true }).inputValue()), 141);
    return { verifiedAssets: Object.keys(saved.assets).length, copy };
  });
  await check('切工程释放全部纹理；预算页面重载记忆，无静止重绘', async () => {
    await budget(256);
    await page.getByRole('button', { name: '新建', exact: true }).click();
    await page.getByLabel('新工程名称').fill('空工程资源检查');
    await page.getByRole('button', { name: '创建工程', exact: true }).click();
    await ready();
    const empty = await metrics('empty');
    assert.equal(empty.layers.residentTextures, 0);
    assert.equal(empty.layers.loading + empty.layers.queued, 0);
    await capture.send('Page.stopScreencast');
    await capture.detach();
    capture = null;
    await page.reload();
    await ready();
    await page.getByRole('button', { name: '查看运行记录', exact: true }).click();
    assert.equal(await page.getByLabel('纹理预算（本机）').inputValue(), '256');
    await page.getByRole('button', { name: '关闭运行记录', exact: true }).click();
    await budget(192);
    await ready();
    const frames = await page.getByTestId('canvas-host').getAttribute('data-render-count');
    await page.waitForTimeout(600);
    assert.equal(await page.getByTestId('canvas-host').getAttribute('data-render-count'), frames);
    return empty.layers;
  });
  assert.deepEqual(report.errors, []);
  report.passed = true;
} catch (e) {
  report.passed = false;
  report.error = String(e.stack ?? e);
  console.error(report.error);
  process.exitCode = 1;
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
        path.join(directory, '分块纹理与保存验收.mp4'),
      ],
      { windowsHide: true },
    );
    if (path.dirname(frameFolder) !== directory) throw Error('Unsafe cleanup');
    await fs.rm(frameFolder, { recursive: true });
  }
  await fs.writeFile(path.join(directory, 'report.json'), JSON.stringify(report, null, 2));
}
