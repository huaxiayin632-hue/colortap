import { _electron as electron } from 'playwright';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { smallFixtures } from './image-fixtures.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const directory = path.join(root, 'test-results', 'timeline');
const fixtures = await smallFixtures(path.join(directory, 'fixtures'));
const profile = path.join(directory, `profile-${Date.now()}`);
const env = { ...process.env, RHYTHM_USER_DATA: profile };
delete env.ELECTRON_RUN_AS_NODE;
delete env.ELECTRON_RENDERER_URL;
const realPSD = process.argv.find((a) => a.startsWith('--psd='))?.slice(6);
const recording = process.argv.includes('--record');
const key = 'rhythm-canvas.workspace.v1';
const projectFile = path.join(directory, '导航验收.rcproj');
let activeFile = projectFile;
const report = {
  startedAt: new Date().toISOString(),
  checks: [],
  errors: [],
  realPSD,
  limitations: [
    'Real Electron windows and mouse/keyboard input; native file picker replies are substituted.',
    'IME composition and lost pointer capture are injected; physical display changes and OS candidate selection are not automated.',
  ],
};
let app, page, capture;
const frames = [],
  writes = [];
const frameFolder = path.join(directory, `frames-${Date.now()}`);
if (recording) await fs.mkdir(frameFolder);
const button = (name) => page.getByRole('button', { name, exact: true });
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
  await choose(activeFile, true);
  await button('保存').click();
  await settled();
  await page.waitForFunction(
    () => document.querySelector('.save-state')?.textContent.trim() === '已保存',
  );
  return JSON.parse(await fs.readFile(activeFile, 'utf8'));
}
async function prefs() {
  await page.waitForTimeout(220);
  return page.evaluate((k) => JSON.parse(localStorage.getItem(k)), key);
}
async function rect(selector) {
  return page.locator(selector).boundingBox();
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

const menu = () => page.getByRole('menu', { name: '对象操作' });
const tab = (name) => page.locator('.production-tabs').getByRole('button', { name, exact: true });
const note = (id) => page.locator(`.timeline-note[data-note-id="${id}"]`);
async function right(locator) {
  const head = (await selection()).head;
  await locator.click({ button: 'right' });
  await menu().waitFor();
  assert.equal((await selection()).head, head, 'Right click must not seek');
  if (recording) await page.waitForTimeout(500);
}
async function undo() {
  await button('撤销').click();
  await settled();
}
const scroll = () => page.getByTestId('timeline-scroll');
const headTime = () => page.getByTestId('playhead').getAttribute('data-time-us').then(Number);
const view = () =>
  scroll().evaluate((el) => ({
    left: el.scrollLeft,
    top: el.scrollTop,
    width: el.clientWidth,
    max: el.scrollWidth - el.clientWidth,
    zoom: Number(el.dataset.zoom),
  }));
async function zoom(value) {
  await page.getByLabel('时间轴缩放', { exact: true }).evaluate((el, value) => {
    el.value = String(value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  }, value);
  await page.waitForTimeout(80);
}
async function seek(seconds) {
  await tab('图层 / 谱面').click();
  const field = page.getByLabel('定位到秒', { exact: true });
  await field.fill(String(seconds));
  await field.press('Tab');
}
async function wheel(dx, dy, modifier) {
  const b = await scroll().boundingBox();
  await page.mouse.move(b.x + Math.min(220, b.width / 2), b.y + 12);
  if (modifier) await page.keyboard.down(modifier);
  await page.mouse.wheel(dx, dy);
  if (modifier) await page.keyboard.up(modifier);
  await page.waitForTimeout(100);
}
async function press(key) {
  await scroll().focus();
  await page.keyboard.press(key);
}
let baseline;
try {
  await start();
  await check('真实 PSD 和音乐准备；时间轴偏好与浏览不标脏', async () => {
    await choose(realPSD ?? fixtures.psd);
    await button('＋ 导入 PSD / PNG').click();
    await page
      .getByRole('dialog', { name: '图片导入进度' })
      .waitFor({ state: 'hidden', timeout: 180000 });
    await ready();
    const music = path.join(directory, '音乐.wav');
    await fs.writeFile(music, wav());
    await choose(music);
    await button('导入音乐').first().click();
    await ready();
    await tab('图层 / 谱面').click();
    await page.getByLabel('工程名称', { exact: true }).fill('时间轴导航验收');
    await page.getByLabel('工程名称', { exact: true }).press('Tab');
    baseline = await save();
    assert.equal(await button('播放头跟随').getAttribute('data-follow-state'), 'on');
    await page.getByLabel('时间标尺', { exact: true }).selectOption('bars');
    await zoom(100);
    assert.equal(await page.locator('.save-state').innerText(), '已保存');
    return { layers: Object.keys(baseline.layers).length };
  });
  await captureStart();
  await check('Ctrl+滚轮保留鼠标时间；Shift+滚轮与中键只移动视口，普通滚轮纵向滚动', async () => {
    await wheel(0, 500, 'Shift');
    let a = await view();
    const b = await scroll().boundingBox(),
      x = Math.min(220, b.width / 2);
    const anchor = (a.left + x) / a.zoom,
      time = await headTime();
    await wheel(0, -180, 'Control');
    let v = await view();
    assert.ok(Math.abs((v.left + x) / v.zoom - anchor) < 1.5 / v.zoom);
    assert.ok(v.zoom > a.zoom);
    await wheel(0, 180, 'Control');
    v = await view();
    assert.ok(Math.abs((v.left + x) / v.zoom - anchor) < 2 / v.zoom);
    a = await view();
    await page.mouse.move(b.x + 300, b.y + 70);
    await page.mouse.down({ button: 'middle' });
    await page.mouse.move(b.x + 180, b.y + 70, { steps: 8 });
    await page.mouse.up({ button: 'middle' });
    v = await view();
    assert.ok(Math.abs(v.left - a.left - 120) < 2);
    await wheel(0, 120);
    assert.ok((await view()).top > 0);
    assert.equal(await headTime(), time);
    assert.equal(await page.locator('.save-state').innerText(), '已保存');
    await wheel(0, -500);
    await wheel(0, -50000, 'Shift');
    await wheel(0, 10000, 'Control');
    v = await view();
    assert.equal(v.zoom, 8);
    assert.ok(v.left >= 0 && v.left <= v.max);
    await zoom(200);
  });
  await check('翻页跟随、手动浏览暂停及恢复；关闭、暂停和折叠期间不滚动', async () => {
    await seek(0);
    await button('定位播放头').click();
    await button('播放').click();
    const boundary = ((await view()).width / (await view()).zoom) * 1e6 + 100000;
    await page.waitForFunction(
      (boundary) =>
        Number(document.querySelector('[data-testid=playhead]').dataset.timeUs) > boundary,
      boundary,
    );
    assert.ok((await view()).left > 0);
    assert.equal(await button('播放头跟随').getAttribute('data-follow-state'), 'on');
    await wheel(0, 600, 'Shift');
    const browsing = (await view()).left;
    assert.equal(await button('播放头跟随').getAttribute('data-follow-state'), 'paused');
    await page.waitForTimeout(550);
    assert.equal((await view()).left, browsing);
    await button('定位播放头').click();
    assert.equal(await button('播放头跟随').getAttribute('data-follow-state'), 'on');
    await button('播放头跟随').click();
    const off = (await view()).left;
    await seek(30);
    await button('播放').click();
    await page.waitForTimeout(200);
    assert.equal((await view()).left, off);
    await button('播放头跟随').click();
    assert.equal(await button('播放头跟随').getAttribute('data-follow-state'), 'on');
    const beforeFold = (await view()).left;
    await button('收起时间轴').click();
    await page.waitForTimeout(300);
    assert.equal(Number(await scroll().getAttribute('data-scroll-left')), beforeFold);
    await button('展开时间轴').click();
    await button('暂停').click();
    const paused = (await view()).left;
    await seek(2);
    await page.waitForTimeout(200);
    assert.equal((await view()).left, paused);
    assert.equal(await page.locator('.save-state').innerText(), '已保存');
  });
  await check('三连音创建和时间轴拖动共用精确 tick；网格、撤销和重做一致', async () => {
    await button('Circle 工具').click();
    const b = await rect('.canvas-host');
    for (const [division, seconds, tick] of [
      [3, 1.72, 3200],
      [6, 2.12, 4000],
      [12, 2.31, 4400],
    ]) {
      await page.getByLabel('节拍细分', { exact: true }).selectOption(String(division));
      await seek(seconds);
      await button('定位播放头').click();
      await page.mouse.click(b.x + b.width / 2 + (division - 6) * 10, b.y + b.height / 2);
      const project = await save();
      const added = Object.values(project.notes).find((n) => !baseline.notes[n.id]);
      assert.deepEqual(added.at, { basis: 'beat', tick });
      assert.ok(await page.locator(`.beat-grid [data-tick="${tick}"]`).count());
      const item = note(added.id);
      await item.scrollIntoViewIfNeeded();
      const r = await item.boundingBox(),
        delta = 100 / division;
      await page.mouse.move(r.x + 5, r.y + r.height / 2);
      await page.mouse.down();
      await page.mouse.move(r.x + 5 + delta, r.y + r.height / 2, { steps: 5 });
      await page.mouse.up();
      assert.equal((await save()).notes[added.id].at.tick, tick + 960 / division);
      await undo();
      assert.equal((await save()).notes[added.id].at.tick, tick);
      await button('重做').click();
      baseline = await save();
    }
  });
  await check('对象右键不导航；中键取消不改音符，数值拖动期间方向键不定位', async () => {
    await button('选择 工具').click();
    const id = Object.keys(baseline.notes)[0];
    await note(id).scrollIntoViewIfNeeded();
    const time = await headTime();
    await right(note(id));
    assert.equal(await headTime(), time);
    await page.keyboard.press('ArrowRight');
    assert.equal(await headTime(), time);
    await page.keyboard.press('Escape');
    const b = await note(id).boundingBox();
    await page.mouse.move(b.x + 5, b.y + 5);
    await page.mouse.down({ button: 'middle' });
    await page.mouse.move(b.x + 75, b.y + 5, { steps: 4 });
    await scroll().dispatchEvent('lostpointercapture', { pointerId: 1, bubbles: true });
    const stopped = (await view()).left;
    await page.mouse.move(b.x + 120, b.y + 5);
    await page.mouse.up({ button: 'middle' });
    assert.equal((await view()).left, stopped);
    assert.deepEqual((await save()).notes, baseline.notes);
    await scroll().focus();
    const bpm = await page.getByLabel('BPM', { exact: true }).boundingBox();
    await page.mouse.move(bpm.x + 10, bpm.y + bpm.height / 2);
    await page.mouse.down();
    await page.mouse.move(bpm.x + 25, bpm.y + bpm.height / 2, { steps: 4 });
    const before = await headTime();
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('Control+ArrowLeft');
    assert.equal(await headTime(), before);
    await page.keyboard.press('Escape');
    await page.mouse.up();
    assert.deepEqual((await save()).timing, baseline.timing);
  });
  await check('正负首拍偏移、BPM 与拍号变化、网格内外及曲首曲尾的精确定位', async () => {
    const fixture = structuredClone(baseline);
    fixture.id = crypto.randomUUID();
    fixture.name = '节拍边界验收';
    fixture.timing = {
      ppq: 960,
      beatZeroUs: 250000,
      points: [
        { id: crypto.randomUUID(), tick: 0, bpm: 120, meter: [4, 4] },
        { id: crypto.randomUUID(), tick: 960, bpm: 240, meter: [4, 4] },
        { id: crypto.randomUUID(), tick: 4800, bpm: 240, meter: [6, 8] },
        { id: crypto.randomUUID(), tick: 5760, bpm: 120, meter: [6, 8] },
      ],
    };
    const file = path.join(directory, '节拍边界.rcproj');
    await fs.writeFile(file, JSON.stringify(fixture));
    await choose(file);
    activeFile = file;
    await button('打开').click();
    await ready();
    assert.equal(await page.getByTestId('project-name').innerText(), fixture.name);
    await seek(0);
    await page.getByLabel('节拍细分', { exact: true }).selectOption('3');
    assert.equal((await page.locator('.beat-readout').innerText()).replaceAll(' ', ''), '0:4');
    await press('ArrowLeft');
    assert.equal(await headTime(), 0);
    await press('ArrowRight');
    assert.equal(await headTime(), 83333);
    await press('ArrowRight');
    assert.equal(await headTime(), 250000);
    await press('ArrowLeft');
    assert.equal(await headTime(), 83333);
    await seek(0.09);
    await press('ArrowLeft');
    assert.equal(await headTime(), 83333);
    await seek(0);
    for (const [time, label] of [
      [250000, '1:1'],
      [1500000, '2:1'],
      [1750000, '3:1'],
      [3000000, '4:1'],
    ]) {
      await press('Control+ArrowRight');
      assert.equal(await headTime(), time);
      assert.equal((await page.locator('.beat-readout').innerText()).replaceAll(' ', ''), label);
    }
    await press('Control+ArrowLeft');
    assert.equal(await headTime(), 1750000);
    await press('Control+ArrowLeft');
    assert.equal(await headTime(), 1500000);
    await seek(59.99);
    await press('ArrowRight');
    assert.equal(await headTime(), 60e6);
    await press('Control+ArrowRight');
    assert.equal(await headTime(), 60e6);
    await page.getByLabel('时间标尺', { exact: true }).selectOption('time');
    await page.getByLabel('时间标尺', { exact: true }).selectOption('bars');
    const saved = await save();
    assert.deepEqual(saved.notes, baseline.notes);
    assert.deepEqual(saved.timing, fixture.timing);
    const negative = structuredClone(saved);
    negative.id = crypto.randomUUID();
    negative.timing.beatZeroUs = -250000;
    const negativeFile = path.join(directory, '负偏移验收.rcproj');
    await fs.writeFile(negativeFile, JSON.stringify(negative));
    activeFile = negativeFile;
    await choose(activeFile);
    await button('打开').click();
    await ready();
    await seek(0);
    await press('ArrowRight');
    assert.equal(await headTime(), 83333);
    await press('Control+ArrowRight');
    assert.equal(await headTime(), 1000000);
    baseline = await save();
    assert.deepEqual(baseline.timing, negative.timing);
    assert.deepEqual(baseline.notes, saved.notes);
  });
  await check('时间轴焦点规则、输入法、输入框、菜单与帮助弹窗不误定位', async () => {
    await seek(1);
    const time = await headTime();
    await page.getByTestId('pixi-canvas').focus();
    await page.keyboard.press('ArrowRight');
    assert.equal(await headTime(), time);
    const name = page.getByLabel('工程名称', { exact: true });
    await name.focus();
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('Control+ArrowLeft');
    assert.equal(await headTime(), time);
    await scroll().focus();
    await scroll().dispatchEvent('compositionstart', { data: '中' });
    await page.keyboard.press('ArrowRight');
    await scroll().dispatchEvent('compositionend', { data: '中文' });
    await scroll().dispatchEvent('keydown', {
      key: 'ArrowRight',
      isComposing: true,
      bubbles: true,
    });
    await scroll().dispatchEvent('keydown', { key: 'ArrowRight', keyCode: 229, bubbles: true });
    assert.equal(await headTime(), time);
    await button('快捷键一览').click();
    await page.getByRole('dialog', { name: '快捷键一览' }).waitFor();
    assert.equal(await page.locator('[data-command^="timeline.grid."]').count(), 2);
    assert.equal(await page.locator('[data-command^="timeline.bar."]').count(), 2);
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('Control+ArrowLeft');
    assert.equal(await headTime(), time);
    await page.keyboard.press('Escape');
    await button('新建').click();
    await page.getByLabel('新工程名称').press('ArrowRight');
    await button('取消').focus();
    await page.keyboard.press('Control+ArrowRight');
    assert.equal(await headTime(), time);
    await button('取消').click();
    await button('试玩').click();
    await button('播放').click();
    await page.waitForTimeout(120);
    await press('Control+ArrowRight');
    assert.ok(await button('暂停').isVisible());
    await button('暂停').click();
    await button('编辑').click();
    assert.deepEqual((await save()).notes, baseline.notes);
  });
  await captureStop();
  await check('最小窗口可操作，重开保持视图偏好、清除临时暂停；保存内容与布局不变', async () => {
    const saved = await save(),
      layout = await prefs();
    await page.getByLabel('时间标尺', { exact: true }).selectOption('bars');
    await zoom(120);
    await wheel(0, 200, 'Shift');
    assert.equal(await button('播放头跟随').getAttribute('data-follow-state'), 'paused');
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1080, 720));
    await page.waitForTimeout(200);
    for (const label of ['播放头跟随', '定位播放头']) {
      const b = await button(label).boundingBox();
      assert.ok(b.x >= 0 && b.x + b.width <= 1080);
    }
    await page.screenshot({ path: path.join(directory, 'small-window.png') });
    // Close normally so local preferences flush, then open the same saved project.
    await app.close();
    app = null;
    await start();
    await choose(activeFile);
    await button('打开').click();
    await ready();
    assert.equal(await page.getByLabel('时间标尺', { exact: true }).inputValue(), 'bars');
    assert.equal((await view()).zoom, 120);
    assert.equal(await button('播放头跟随').getAttribute('data-follow-state'), 'on');
    assert.deepEqual(await prefs(), layout);
    const reopened = await save();
    for (const field of ['notes', 'timing', 'layers', 'reveals', 'sounds', 'camera'])
      assert.deepEqual(reopened[field], saved[field]);
    await page.screenshot({ path: path.join(directory, 'editor.png') });
    return { framesAtRest: await idle() };
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
        path.join(directory, 'timeline-acceptance.mp4'),
      ],
      { windowsHide: true },
    );
    if (path.dirname(frameFolder) === directory && path.basename(frameFolder).startsWith('frames-'))
      await fs.rm(frameFolder, { recursive: true });
  }
  report.finishedAt = new Date().toISOString();
  await fs.writeFile(path.join(directory, 'report.json'), JSON.stringify(report, null, 2));
}
