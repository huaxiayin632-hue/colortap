import { _electron as electron } from 'playwright';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { smallFixtures } from './image-fixtures.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const directory = path.join(root, 'test-results', 'workspace');
const fixtures = await smallFixtures(path.join(directory, 'fixtures'));
const profile = path.join(directory, `profile-${Date.now()}`);
const env = { ...process.env, RHYTHM_USER_DATA: profile };
delete env.ELECTRON_RUN_AS_NODE;
delete env.ELECTRON_RENDERER_URL;
const realPSD = process.argv.find((a) => a.startsWith('--psd='))?.slice(6);
const recording = process.argv.includes('--record');
const key = 'rhythm-canvas.workspace.v1';
const projectFile = path.join(directory, '布局验收.rcproj');
const report = {
  startedAt: new Date().toISOString(),
  checks: [],
  errors: [],
  realPSD,
  limitations: [
    'Real Electron windows and mouse/keyboard input; native file picker replies are substituted.',
    'Pointer cancellation/lost capture and window blur are explicitly injected; physical display reconnection is not tested.',
  ],
};
let app, page, capture;
const frames = [],
  writes = [];
const frameFolder = path.join(directory, `frames-${Date.now()}`);
if (recording) await fs.mkdir(frameFolder);
const button = (name) => page.getByRole('button', { name, exact: true });
const divider = (name) => page.getByRole('separator', { name, exact: true });
async function check(name, action) {
  try {
    const evidence = await action();
    report.checks.push({ name, passed: true, evidence });
    console.log('PASS ' + name);
  } catch (error) {
    report.checks.push({ name, passed: false, error: String(error) });
    throw error;
  } finally {
    await fs.writeFile(path.join(directory, 'report.json'), JSON.stringify(report, null, 2));
  }
}
async function settled() {
  await page.locator('.editor-shell[aria-busy=false]').waitFor();
}
async function ready() {
  await settled();
  await page.waitForFunction(
    () => document.querySelector('[data-testid=canvas-host]')?.dataset.loading === '0',
  );
  await page.waitForTimeout(200);
}
async function start() {
  app = await electron.launch({ args: [root], cwd: root, env });
  page = await app.firstWindow();
  page.setDefaultTimeout(30000);
  page.on('pageerror', (e) => report.errors.push(String(e)));
  await page.getByTestId('pixi-canvas').waitFor();
  await settled();
}
async function captureStart() {
  if (!recording) return;
  capture = await app.context().newCDPSession(page);
  const cdp = capture;
  cdp.on('Page.screencastFrame', (event) => {
    const file = `frame-${String(frames.length).padStart(6, '0')}.jpg`;
    frames.push({ file, time: event.metadata.timestamp });
    writes.push(fs.writeFile(path.join(frameFolder, file), Buffer.from(event.data, 'base64')));
    void cdp.send('Page.screencastFrameAck', { sessionId: event.sessionId }).catch(() => {});
  });
  await capture.send('Page.startScreencast', {
    format: 'jpeg',
    quality: 82,
    maxWidth: 1440,
    maxHeight: 960,
    everyNthFrame: 1,
  });
}
async function captureStop() {
  await capture?.send('Page.stopScreencast').catch(() => {});
  capture = null;
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
async function save() {
  await choose(projectFile, true);
  await button('保存').click();
  await settled();
  await page.waitForFunction(
    () => document.querySelector('.save-state')?.textContent.trim() === '已保存',
  );
  return JSON.parse(await fs.readFile(projectFile, 'utf8'));
}
async function prefs() {
  await page.waitForTimeout(220);
  return page.evaluate((k) => JSON.parse(localStorage.getItem(k)), key);
}
async function rect(selector) {
  return page.locator(selector).boundingBox();
}
async function drag(name, dx, dy, finish = true) {
  const box = await divider(name).boundingBox();
  assert.ok(box);
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + dx, box.y + box.height / 2 + dy, { steps: 16 });
  if (finish) await page.mouse.up();
  await page.waitForTimeout(120);
}
async function idle() {
  await ready();
  const count = () =>
    page.getByTestId('canvas-host').getAttribute('data-render-count').then(Number);
  const before = await count();
  await page.waitForTimeout(400);
  assert.equal(await count(), before, 'Canvas must return to idle after layout changes');
  return before;
}
async function selection() {
  return page.evaluate(() => ({
    tool: document.querySelector('.canvas-host').dataset.tool,
    layer: document.querySelector('.layer-row.active')?.getAttribute('data-layer-id'),
    notes: [...document.querySelectorAll('[data-note-id].selected')].map((el) =>
      el.getAttribute('data-note-id'),
    ),
    reveal: document.querySelector('.reveal-select.selected')?.getAttribute('data-reveal-id'),
    head: document.querySelector('[data-testid=playhead]').getAttribute('data-time-us'),
  }));
}
async function focused() {
  return page.locator('.editor-shell').getAttribute('data-canvas-focus');
}
function wav() {
  const rate = 16000,
    count = rate * 60,
    bytes = Buffer.alloc(44 + count * 2);
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
  bytes.writeUInt32LE(count * 2, 40);
  for (let i = 0; i < count; i++)
    bytes.writeInt16LE(Math.round(Math.sin((i * Math.PI * 880) / rate) * 800), 44 + i * 2);
  return bytes;
}

try {
  await start();
  await check('布局不会标脏全新工程；三套预设有不同空间分配', async () => {
    const sizes = [];
    for (const name of ['演出', '镜头', '谱面']) {
      await page
        .getByRole('navigation', { name: '工作区布局' })
        .getByRole('button', { name, exact: true })
        .click();
      sizes.push(await prefs());
      assert.equal((await page.locator('.save-state').innerText()).trim(), '新工程');
      assert.equal(await button('撤销').isEnabled(), false);
    }
    assert.ok(sizes[0].left > sizes[2].left && sizes[2].timeline > sizes[0].timeline);
    assert.equal(sizes[1].collapsed.left, true);
    return sizes;
  });
  await check('用 PSD、音乐、音符和图层演出准备独立验收工程', async () => {
    await choose(realPSD ?? fixtures.psd);
    await button('＋ 导入 PSD / PNG').click();
    await page
      .getByRole('dialog', { name: '图片导入进度', exact: true })
      .waitFor({ state: 'hidden', timeout: 180000 });
    if (await button('知道了').isVisible()) await button('知道了').click();
    await ready();
    const music = path.join(directory, '音乐.wav');
    await fs.writeFile(music, wav());
    await choose(music);
    await button('导入音乐').first().click();
    await ready();
    await button('适合窗口').click();
    await button('Circle 工具').click();
    const box = await rect('.canvas-host');
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    await button('添加显现绑定').click();
    await page.getByLabel('显示完整素材', { exact: true }).check();
    const saved = await save();
    assert.ok(
      Object.keys(saved.layers).length &&
        Object.keys(saved.notes).length &&
        Object.keys(saved.reveals).length,
    );
    return {
      layers: Object.keys(saved.layers).length,
      notes: Object.keys(saved.notes).length,
      reveals: Object.keys(saved.reveals).length,
    };
  });
  const savedBefore = JSON.parse(await fs.readFile(projectFile, 'utf8'));
  await captureStart();
  await check('拖动三条主分隔条；不重建画布，选中与播放头不变，结束后静止', async () => {
    const canvas = await page.getByTestId('pixi-canvas').elementHandle();
    const before = await selection();
    const left = await rect('.left-panel'),
      right = await rect('.inspector'),
      timeline = await rect('.timeline-panel');
    await drag('左栏宽度', 65, 0);
    await drag('右栏宽度', -55, 0);
    await drag('时间轴高度', 0, 65);
    assert.ok((await rect('.left-panel')).width > left.width + 55);
    assert.ok((await rect('.inspector')).width > right.width + 45);
    assert.ok((await rect('.timeline-panel')).height < timeline.height - 55);
    assert.equal(await canvas.evaluate((el) => el.isConnected), true);
    assert.deepEqual(await selection(), before);
    return { framesAtRest: await idle(), layout: await prefs() };
  });
  await check('各主面板折叠后可找回；时间轴缩放、滚动与组件保持', async () => {
    const scroll = page.getByTestId('timeline-scroll');
    await page.getByLabel('时间轴缩放', { exact: true }).fill('90');
    await scroll.evaluate((el) => {
      el.scrollLeft = 280;
      el.scrollTop = 35;
    });
    const view = await scroll.evaluate((el) => [el.scrollLeft, el.scrollTop]);
    const timeline = await scroll.elementHandle();
    const before = await prefs();
    for (const name of ['左栏', '右栏', '时间轴']) {
      await button('收起' + name).click();
      assert.ok(await button('展开' + name).isVisible());
      await page.waitForTimeout(recording ? 500 : 180);
      await button('展开' + name).click();
    }
    assert.deepEqual(await prefs(), before);
    assert.deepEqual(await scroll.evaluate((el) => [el.scrollLeft, el.scrollTop]), view);
    assert.equal(await page.getByLabel('时间轴缩放', { exact: true }).inputValue(), '90');
    assert.equal(await timeline.evaluate((el) => el.isConnected), true);
  });
  await check('左侧三个区块可分配高度，折叠后返还空间，重开恢复比例', async () => {
    const before = await rect('[data-section=layers]');
    await drag('图层下方分隔条', 0, 22);
    assert.ok((await rect('[data-section=layers]')).height > before.height + 15);
    await drag('素材下方分隔条', 0, -15);
    const sizes = await page
      .locator('.resource-section')
      .evaluateAll((els) => els.map((el) => el.clientHeight));
    const stored = await prefs();
    for (const name of ['图层', '素材', '音效素材']) await button('收起' + name + '区块').click();
    for (const name of ['图层', '素材', '音效素材'])
      assert.ok(await button('展开' + name + '区块').isVisible());
    for (const name of ['图层', '素材', '音效素材']) await button('展开' + name + '区块').click();
    assert.deepEqual(
      await page
        .locator('.resource-section')
        .evaluateAll((els) => els.map((el) => el.clientHeight)),
      sizes,
    );
    assert.deepEqual(await prefs(), stored);
  });
  await check('专注画布精确返回原布局；Tab 不抢输入框、下拉框、按钮和弹窗', async () => {
    await button('收起左栏').click();
    const original = await prefs(),
      state = await selection();
    await page.getByTestId('pixi-canvas').focus();
    await page.keyboard.press('Tab');
    assert.equal(await focused(), 'true');
    assert.ok(await button('退出专注画布').isVisible());
    if (recording) await page.waitForTimeout(600);
    await page.keyboard.press('Tab');
    assert.equal(await focused(), 'false');
    assert.deepEqual(await prefs(), original);
    assert.deepEqual(await selection(), state);
    await button('专注画布').click();
    await button('退出专注画布').click();
    await button('展开左栏').click();
    for (const locator of [
      page.getByLabel('BPM', { exact: true }),
      page.getByLabel('音符吸附模式'),
      button('重置布局'),
    ]) {
      await locator.focus();
      await page.keyboard.press('Tab');
      assert.equal(await focused(), 'false');
    }
    await button('新建').click();
    await page.getByLabel('新工程名称').fill('输入框保留 Tab');
    await page.keyboard.press('Tab');
    assert.equal(await focused(), 'false');
    assert.equal(await page.getByLabel('新工程名称').inputValue(), '输入框保留 Tab');
    await button('取消').click();
  });
  await check('播放中折叠、拖动、切预设、专注后播放继续，工程保持已保存', async () => {
    await button('播放').click();
    const start = Number((await selection()).head);
    await button('收起时间轴').click();
    await button('收起右栏').click();
    await page
      .getByRole('navigation', { name: '工作区布局' })
      .getByRole('button', { name: '镜头', exact: true })
      .click();
    await drag('时间轴高度', 0, -30);
    await button('专注画布').click();
    await page.waitForTimeout(800);
    await button('退出专注画布').click();
    assert.ok(await button('暂停').isVisible());
    assert.ok(Number((await selection()).head) > start + 500000);
    await button('暂停').click();
    const paused = await selection();
    for (const name of ['演出', '镜头', '谱面']) {
      await page
        .getByRole('navigation', { name: '工作区布局' })
        .getByRole('button', { name, exact: true })
        .click();
      if (recording) await page.waitForTimeout(600);
      assert.deepEqual(await selection(), paused);
    }
    await button('重置布局').click();
    assert.equal((await page.locator('.save-state').innerText()).trim(), '已保存');
    const after = await save();
    for (const field of ['layers', 'notes', 'reveals', 'tracks', 'assets'])
      assert.deepEqual(after[field], savedBefore[field]);
    await page.screenshot({ path: path.join(directory, 'normal.png') });
  });
  await captureStop();
  await check('最小窗口与 125% 页面缩放：画布和所有恢复入口都留在可用范围', async () => {
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1080, 720));
    await drag('左栏宽度', 800, 0);
    await drag('右栏宽度', -800, 0);
    await drag('时间轴高度', 0, -600);
    for (const zoom of [1, 1.25]) {
      await app.evaluate(
        ({ BrowserWindow }, z) => BrowserWindow.getAllWindows()[0].webContents.setZoomFactor(z),
        zoom,
      );
      await page.waitForTimeout(350);
      const usable = await page.evaluate(() => {
        const canvas = document.querySelector('.canvas-host').getBoundingClientRect();
        return {
          width: innerWidth,
          height: innerHeight,
          canvas: { width: canvas.width, height: canvas.height },
          overflow: document.body.scrollWidth - innerWidth,
        };
      });
      assert.ok(usable.canvas.width >= 240 && usable.canvas.height >= 100, JSON.stringify(usable));
      assert.ok(usable.overflow <= 1, JSON.stringify(usable));
      for (const name of ['左栏', '右栏', '时间轴']) await button('收起' + name).click();
      for (const name of ['左栏', '右栏', '时间轴']) {
        const box = await button('展开' + name).boundingBox();
        assert.ok(
          box.x >= 0 &&
            box.y >= 0 &&
            box.x + box.width <= usable.width + 1 &&
            box.y + box.height <= usable.height + 1,
        );
        await button('展开' + name).click();
      }
      await ready();
      // Electron captures the full client area even when page zoom is not 100%.
      const captured = await app.evaluate(async ({ BrowserWindow }) =>
        (await BrowserWindow.getAllWindows()[0].capturePage()).toPNG().toString('base64'),
      );
      await fs.writeFile(
        path.join(directory, `minimum-${zoom}.png`),
        Buffer.from(captured, 'base64'),
      );
    }
    await app.evaluate(({ BrowserWindow }) => {
      const w = BrowserWindow.getAllWindows()[0];
      w.webContents.setZoomFactor(1);
      w.setSize(1440, 960);
    });
    await button('重置布局').click();
  });
  await check('分隔条取消、丢失捕获、窗口失焦后不会残留拖动；支持方向键', async () => {
    for (const mode of ['escape', 'cancel', 'lost', 'blur']) {
      const before = (await rect('.left-panel')).width;
      await drag('左栏宽度', 50, 0, false);
      if (mode === 'escape') await page.keyboard.press('Escape');
      if (mode === 'cancel') await divider('左栏宽度').dispatchEvent('pointercancel');
      if (mode === 'lost')
        await divider('左栏宽度').evaluate((el) => {
          for (let id = 1; id < 10; id++)
            if (el.hasPointerCapture(id)) el.releasePointerCapture(id);
        });
      if (mode === 'blur') await page.evaluate(() => window.dispatchEvent(new Event('blur')));
      await page.mouse.up();
      assert.ok(Math.abs((await rect('.left-panel')).width - before) < 1, mode);
      assert.equal(await page.locator('.panel-divider.active').count(), 0);
    }
    const before = (await rect('.left-panel')).width;
    await divider('左栏宽度').focus();
    await page.keyboard.press('ArrowRight');
    assert.ok((await rect('.left-panel')).width >= before + 9);
  });
  await check('未提交输入在隐藏和切换预设后保留；布局不占用工程撤销', async () => {
    const input = page.getByLabel('工程名称', { exact: true });
    const old = await input.inputValue();
    await input.fill('布局后的编辑');
    // Keyboard activation through the DOM preserves the field's pending draft while hiding it.
    await button('收起右栏').evaluate((el) => el.click());
    await button('展开右栏').evaluate((el) => el.click());
    assert.equal(await input.inputValue(), '布局后的编辑');
    await button('重置布局').click();
    assert.equal(await input.inputValue(), '布局后的编辑');
    await button('撤销').click();
    assert.equal(await input.inputValue(), old);
    assert.equal((await page.locator('.save-state').innerText()).trim(), '已保存');
  });
  await check('缩放及布局变化后，画布点选和拖动仍对应音符坐标', async () => {
    await button('回到开头').click();
    await button('适合窗口').click();
    await button('放大画布').click();
    await drag('左栏宽度', 35, 0);
    await drag('时间轴高度', 0, 20);
    const note = Object.values(savedBefore.notes)[0];
    await button('选择 工具').click();
    const view = await page.getByTestId('canvas-host').evaluate((el) => ({
      x: Number(el.dataset.panX),
      y: Number(el.dataset.panY),
      z: Number(el.dataset.zoom),
    }));
    const box = await rect('.canvas-host');
    const { playfieldRect: r, artworkSize: a, chartSize: c } = savedBefore.stage;
    const left = Math.max(0, r.x),
      top = Math.max(0, r.y);
    const width = Math.min(a.width, r.x + r.width) - left,
      height = Math.min(a.height, r.y + r.height) - top;
    const scale = Math.min(width / c.width, height / c.height);
    const mx = left + (width - c.width * scale) / 2,
      my = top + (height - c.height * scale) / 2;
    const x = box.x + view.x + (mx + note.position.x * scale) * view.z,
      y = box.y + view.y + (my + note.position.y * scale) * view.z;
    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.move(x + 25, y + 16, { steps: 12 });
    await page.mouse.up();
    const moved = await save();
    const changed = moved.notes[note.id];
    assert.ok(Math.abs(changed.position.x - note.position.x - 25 / (view.z * scale)) < 3);
    assert.ok(Math.abs(changed.position.y - note.position.y - 16 / (view.z * scale)) < 3);
    await button('撤销').click();
    await save();
    return { zoom: view.z, framesAtRest: await idle() };
  });
  await check('重启及新建、打开另一工程后保留布局，专注是临时状态', async () => {
    await button('收起素材区块').click();
    await button('收起右栏').click();
    const stored = await prefs();
    await captureStart();
    await button('专注画布').click();
    await page.waitForTimeout(400);
    await captureStop();
    const closed = app.waitForEvent('close');
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close());
    await closed;
    await app.close();
    await start();
    await captureStart();
    assert.deepEqual(await prefs(), stored);
    assert.equal(await focused(), 'false');
    assert.ok(await button('展开右栏').isVisible());
    await choose(projectFile);
    await button('打开').click();
    await ready();
    assert.deepEqual(await prefs(), stored);
    await button('新建').click();
    await page.getByLabel('新工程名称').fill('另一个工程');
    await button('创建工程').click();
    await settled();
    assert.deepEqual(await prefs(), stored);
    await page.screenshot({ path: path.join(directory, 'restart.png') });
    await button('收起时间轴').click();
    await choose(projectFile);
    await button('打开').click();
    await ready();
    await button('展开时间轴').click();
    await page.locator('[data-testid=waveform][data-ready=true]').waitFor();
    assert.ok((await rect('[data-testid=timeline-scroll]')).width > 100);
    assert.deepEqual(await prefs(), stored);
    await captureStop();
  });
  await check('坏偏好安全回退；重置入口恢复可操作布局', async () => {
    // Seed corruption in the next document, after the old document flushes its current layout.
    await page.addInitScript((k) => localStorage.setItem(k, '{invalid'), key);
    await page.reload();
    await page.getByTestId('pixi-canvas').waitFor();
    await settled();
    assert.ok(await button('收起左栏').isVisible());
    assert.ok(await button('收起右栏').isVisible());
    await button('收起时间轴').click();
    await button('重置布局').click();
    const stored = await prefs();
    assert.deepEqual(stored.collapsed, { left: false, right: false, timeline: false });
    return stored;
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
  await captureStop();
  if (app) {
    await app.evaluate(({ app }) => app.exit(0)).catch(() => {});
    await app.close().catch(() => {});
  }
  if (recording && frames.length) {
    await Promise.all(writes);
    const lines = ['ffconcat version 1.0'];
    for (let i = 0; i < frames.length; i++)
      lines.push(
        `file '${frames[i].file}'`,
        `duration ${Math.max(0.02, Math.min(1.5, (frames[i + 1]?.time ?? frames[i].time + 0.3) - frames[i].time))}`,
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
        'scale=1440:960:force_original_aspect_ratio=decrease,pad=1440:960:(ow-iw)/2:(oh-ih)/2',
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
        path.join(directory, 'workspace-acceptance.mp4'),
      ],
      { windowsHide: true },
    );
    if (path.dirname(frameFolder) === directory && path.basename(frameFolder).startsWith('frames-'))
      await fs.rm(frameFolder, { recursive: true });
  }
  report.finishedAt = new Date().toISOString();
  await fs.writeFile(path.join(directory, 'report.json'), JSON.stringify(report, null, 2));
}
