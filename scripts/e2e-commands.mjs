import { _electron as electron } from 'playwright';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { smallFixtures } from './image-fixtures.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const directory = path.join(root, 'test-results', 'commands');
const fixtures = await smallFixtures(path.join(directory, 'fixtures'));
const profile = path.join(directory, `profile-${Date.now()}`);
const env = { ...process.env, RHYTHM_USER_DATA: profile };
delete env.ELECTRON_RUN_AS_NODE;
delete env.ELECTRON_RENDERER_URL;
const realPSD = process.argv.find((a) => a.startsWith('--psd='))?.slice(6);
const recording = process.argv.includes('--record');
const key = 'rhythm-canvas.workspace.v1';
const projectFile = path.join(directory, '命令验收.rcproj');
const report = {
  startedAt: new Date().toISOString(),
  checks: [],
  errors: [],
  realPSD,
  limitations: [
    'Real Electron windows and mouse/keyboard input; native file picker replies are substituted.',
    'IME composition events and repeating keydown are injected; real OS IME candidate selection is not automated.',
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

const target = () => page.getByTestId('command-target').innerText();
const menu = () => page.getByRole('menu', { name: '对象操作' });
const menuCommand = (id) => menu().locator(`[data-command="${id}"]`);
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
async function pointFor(p, project) {
  const { playfieldRect: r, artworkSize: a, chartSize: c } = project.stage;
  const x = Math.max(0, r.x),
    y = Math.max(0, r.y),
    w = Math.min(a.width, r.x + r.width) - x,
    h = Math.min(a.height, r.y + r.height) - y;
  const scale = Math.min(w / c.width, h / c.height),
    mx = x + (w - c.width * scale) / 2,
    my = y + (h - c.height * scale) / 2;
  const v = await page.getByTestId('canvas-host').evaluate((el) => ({
    x: Number(el.dataset.panX),
    y: Number(el.dataset.panY),
    z: Number(el.dataset.zoom),
  }));
  const box = await rect('.canvas-host');
  return { x: box.x + v.x + (mx + p.x * scale) * v.z, y: box.y + v.y + (my + p.y * scale) * v.z };
}
let baseline, circles, slider, revealId, soundId, cameraId, layerId;
try {
  await start();
  await check('真实 PSD、短谱面、演出、音效与镜头准备', async () => {
    await choose(realPSD ?? fixtures.psd);
    await button('＋ 导入 PSD / PNG').click();
    await page
      .getByRole('dialog', { name: '图片导入进度', exact: true })
      .waitFor({ state: 'hidden', timeout: 180000 });
    await ready();
    const music = path.join(directory, '音乐.wav');
    await fs.writeFile(music, wav());
    await choose(music);
    await button('导入音乐').first().click();
    await ready();
    await choose(music);
    await button('＋ 音效').click();
    await ready();
    await tab('图层 / 谱面').click();
    await button('适合窗口').click();
    const b = await rect('.canvas-host');
    await button('Circle 工具').click();
    for (const [x, time] of [
      [-45, 2],
      [45, 4],
    ]) {
      const seek = page.getByLabel('定位到秒', { exact: true });
      await seek.fill(String(time));
      await seek.press('Tab');
      await page.mouse.click(b.x + b.width / 2 + x, b.y + b.height / 2);
    }
    const seek = page.getByLabel('定位到秒', { exact: true });
    await seek.fill('6');
    await seek.press('Tab');
    await button('Slider 工具').click();
    for (const [x, y] of [
      [-65, 40],
      [0, 70],
      [65, 40],
    ])
      await page.mouse.click(b.x + b.width / 2 + x, b.y + b.height / 2 + y);
    await page.keyboard.press('Enter');
    await button('添加显现绑定').click();
    await page.getByLabel('显示完整素材', { exact: true }).check();
    await tab('音效').click();
    await button('添加时间音效').click();
    await tab('镜头').click();
    await button('添加镜头关键帧').click();
    baseline = await save();
    circles = Object.values(baseline.notes).filter((n) => n.kind === 'circle');
    slider = Object.values(baseline.notes).find((n) => n.kind === 'slider');
    revealId = Object.keys(baseline.reveals)[0];
    soundId = Object.keys(baseline.sounds)[0];
    cameraId = Object.keys(baseline.camera.keys)[0];
    layerId = Object.values(baseline.layers).find((l) => l.kind === 'raster' && !l.locked).id;
    assert.equal(circles.length, 2);
    assert.ok(slider && revealId && soundId && cameraId);
    return {
      layers: Object.keys(baseline.layers).length,
      notes: Object.keys(baseline.notes).length,
    };
  });
  await captureStart();
  await check('图层右键命中与锁定；切换右栏后 Delete 只删除图层，一次撤销还原', async () => {
    const row = page.locator(`.layer-row[data-layer-id="${layerId}"]`);
    await right(row);
    assert.match(await target(), /图层/);
    await menuCommand('layer.lock').click();
    await right(row);
    assert.equal(await menuCommand('object.delete').isEnabled(), false);
    await menuCommand('layer.lock').click();
    await row.click();
    await tab('镜头').click();
    await page.keyboard.press('Delete');
    const after = await save();
    assert.equal(after.layers[layerId], undefined);
    assert.deepEqual(after.notes, baseline.notes);
    assert.deepEqual(after.camera, baseline.camera);
    await undo();
    assert.deepEqual((await save()).layers, baseline.layers);
    await page.keyboard.press('Delete');
    assert.deepEqual((await save()).layers, baseline.layers);
  });
  await check('音符右键保留多选；复制与删除共用入口，一次按键只执行一次', async () => {
    await button('选择 工具').click();
    await note(circles[0].id).click();
    await note(circles[1].id).click({ modifiers: ['Shift'] });
    await right(note(circles[0].id));
    assert.equal(await page.locator('.timeline-note.selected').count(), 2);
    await menuCommand('object.duplicate').click();
    assert.equal(Object.keys((await save()).notes).length, 5);
    await undo();
    await page.getByTestId('pixi-canvas').focus();
    await page.keyboard.press('Escape');
    await note(circles[0].id).click();
    await tab('镜头').click();
    await page.keyboard.down('Control');
    await page.keyboard.down('d');
    await page.keyboard.down('d');
    await page.keyboard.up('d');
    await page.keyboard.up('Control');
    assert.equal(Object.keys((await save()).notes).length, 4);
    await undo();
    assert.equal(Object.keys((await save()).notes).length, 3);
    await note(circles[1].id).click();
    await tab('音效').click();
    await page.keyboard.press('Delete');
    const after = await save();
    assert.equal(after.notes[circles[1].id], undefined);
    assert.deepEqual(after.sounds, baseline.sounds);
    await undo();
  });
  await check('演出、音效与镜头片段右键不定位；跨属性页 Delete 不串对象', async () => {
    for (const [selector, id, field, label] of [
      ['.timeline-reveal[data-reveal-id=', revealId, 'reveals', '演出'],
      ['.timeline-sound[data-sound-id=', soundId, 'sounds', '音效'],
      ['.timeline-camera-key[data-camera-id=', cameraId, 'camera', '镜头'],
    ]) {
      await right(page.locator(selector + '"' + id + '"]'));
      assert.match(await target(), new RegExp(label));
      await page.keyboard.press('Escape');
      await tab('图层 / 谱面').click();
      await page.keyboard.press('Delete');
      const after = await save();
      assert.equal(field === 'camera' ? after.camera.keys[id] : after[field][id], undefined);
      assert.deepEqual(after.notes, baseline.notes);
      await undo();
    }
  });
  await check('键盘编辑属性会明确操作对象，Tab 与菜单恢复焦点不改目标', async () => {
    await page.locator(`.timeline-camera-key[data-camera-id="${cameraId}"]`).click();
    await note(circles[0].id).click();
    await tab('镜头').click();
    await page.getByLabel('镜头关键帧时间', { exact: true }).focus();
    await page.keyboard.press('Tab');
    assert.equal(await page.locator(':focus').getAttribute('aria-label'), '镜头X');
    assert.match(await target(), /音符/);
    await page.keyboard.press('ArrowUp');
    assert.match(await target(), /镜头关键帧/);
    await page.getByTestId('pixi-canvas').focus();
    await page.keyboard.press('Delete');
    assert.equal((await save()).camera.keys[cameraId], undefined);
    await undo();
    await undo();
    assert.deepEqual((await save()).camera, baseline.camera);
    await tab('镜头').click();
    await page.locator(`.camera-key-list [data-camera-id="${cameraId}"]`).click();
    await page.getByLabel('镜头X', { exact: true }).focus();
    await right(note(circles[0].id));
    await page.keyboard.press('Control+z');
    assert.equal(await menu().evaluate((el) => el.contains(document.activeElement)), true);
    await page.keyboard.press('Escape');
    assert.match(await target(), /音符/);
    assert.deepEqual((await save()).camera, baseline.camera);
  });
  await check('画布右键按已有命中规则选择，不创建音符；空白菜单没有删除', async () => {
    await note(circles[0].id).click();
    await button('Circle 工具').click();
    await ready();
    const at = await pointFor(circles[0].position, baseline);
    await page.mouse.click(at.x, at.y, { button: 'right' });
    await menu().waitFor();
    assert.match(await target(), /音符/);
    assert.ok(await menuCommand('object.delete').isVisible());
    await page.keyboard.press('Escape');
    assert.equal(await page.getByTestId('note-count').innerText(), '3 音符');
    await page.locator('.workspace-toolbar').click({ button: 'right', position: { x: 5, y: 10 } });
    assert.equal(await menuCommand('object.delete').count(), 0);
    await page.keyboard.press('Escape');
    assert.deepEqual((await save()).notes, baseline.notes);
  });
  await check('路径节点右键及 Delete 仅删除节点，最少两个节点时不能删整条 Slider', async () => {
    await note(slider.id).click();
    const beforeRender = Number(
      await page.getByTestId('canvas-host').getAttribute('data-render-count'),
    );
    await button('路径 工具').click();
    // Path handle hit regions are published by the next demand-rendered canvas frame.
    await page.waitForFunction(
      (before) =>
        Number(document.querySelector('[data-testid=canvas-host]').dataset.renderCount) > before,
      beforeRender,
    );
    const p = baseline.paths[slider.path.pathId],
      node = p.nodes[1];
    // Newly drawn path uses the identity path transform.
    const at = await pointFor(node.point, baseline);
    await page.mouse.click(at.x, at.y, { button: 'right' });
    await menu().waitFor();
    assert.match(await target(), /节点/);
    await menuCommand('object.delete').click();
    let after = await save();
    assert.equal(after.paths[p.id].nodes.length, 2);
    assert.ok(after.notes[slider.id]);
    await page.getByTestId('pixi-canvas').focus();
    await page.keyboard.press('Delete');
    after = await save();
    assert.equal(after.paths[p.id].nodes.length, 2);
    assert.ok(after.notes[slider.id]);
    await undo();
    assert.equal((await save()).paths[p.id].nodes.length, 3);
  });
  await check('输入框文字操作、中文组合输入、下拉框与弹窗不触发对象命令', async () => {
    await note(circles[0].id).click();
    await button('选择 工具').click();
    await tab('图层 / 谱面').click();
    const name = page.getByLabel('工程名称', { exact: true });
    await name.fill('输入草稿');
    await name.press('Control+a');
    await name.press('Control+c');
    await name.press('Delete');
    await name.press('Control+v');
    assert.equal(await name.inputValue(), '输入草稿');
    await name.click({ button: 'right' });
    assert.equal(await menu().count(), 0);
    await page.keyboard.press('Escape');
    await name.fill(baseline.name);
    await name.press('Tab');
    const canvas = page.getByTestId('pixi-canvas');
    await canvas.focus();
    await canvas.dispatchEvent('compositionstart', { data: '中' });
    for (const k of ['Delete', 'd', '?']) await page.keyboard.press(k);
    await canvas.dispatchEvent('compositionend', { data: '中文' });
    await canvas.dispatchEvent('keydown', { key: 'Delete', isComposing: true, bubbles: true });
    await canvas.dispatchEvent('keydown', { key: 'Delete', keyCode: 229, bubbles: true });
    await page
      .locator(`.layer-row[data-layer-id="${layerId}"]`)
      .dispatchEvent('keydown', { key: 'Enter', keyCode: 229, bubbles: true });
    assert.match(await target(), /音符/);
    await page.getByLabel('音符吸附模式').focus();
    await page.keyboard.press('Delete');
    await button('新建').click();
    await page.getByLabel('新工程名称').press('Control+s');
    await page.keyboard.press('Delete');
    const newDialog = page.getByRole('dialog', { name: '新建工程' });
    assert.ok(await newDialog.isVisible());
    await button('取消').focus();
    for (const key of ['Control+z', 'Control+y', 'Delete', 'Control+d', 'Tab', 'Shift+Tab']) {
      await page.keyboard.press(key);
      assert.equal(await newDialog.evaluate((el) => el.contains(document.activeElement)), true);
    }
    await button('取消').click();
    assert.equal((await save()).name, baseline.name);
    assert.deepEqual((await save()).notes, baseline.notes);
    assert.equal(await page.getByRole('dialog').count(), 0);
  });
  await check('快捷键一览与注册绑定一致；按钮及 ? 打开，弹窗按键隔离和关闭后输入正常', async () => {
    await button('快捷键一览').click();
    const dialog = page.getByRole('dialog', { name: '快捷键一览' });
    await dialog.waitFor();
    const helpRows = await dialog
      .locator('tbody tr')
      .evaluateAll((rows) => rows.map((r) => ({ id: r.dataset.command, text: r.textContent })));
    assert.ok(helpRows.some((row) => row.id === 'object.delete' && row.text.includes('Delete')));
    assert.ok(helpRows.some((row) => row.id === 'workspace.focus' && row.text.includes('Tab')));
    for (const key of ['Delete', 'Control+d', 'Control+z', 'Control+s', 'z', 'x', '?']) {
      await page.keyboard.press(key);
      assert.equal(
        await dialog.evaluate((el) => el.contains(document.activeElement)),
        true,
        `Dialog keeps focus after ${key}`,
      );
    }
    assert.ok(await dialog.isVisible());
    await page.screenshot({ path: path.join(directory, 'shortcuts.png') });
    if (recording) await page.waitForTimeout(1400);
    await page.keyboard.press('Escape');
    await page.getByTestId('pixi-canvas').focus();
    await page.keyboard.press('?');
    await dialog.waitFor();
    await button('关闭快捷键一览').click();
    assert.deepEqual((await save()).notes, baseline.notes);
    assert.equal((await save()).name, baseline.name);
    return { rows: helpRows.length };
  });
  await captureStop();
  await check('试玩按住 Z 时打开菜单或帮助会释放追踪，关闭后没有残留按住状态', async () => {
    for (const overlay of ['help', 'menu']) {
      await button('编辑').click();
      const seek = page.getByLabel('定位到秒', { exact: true });
      await seek.fill('5.75');
      await seek.press('Tab');
      await button('试玩').click();
      await button('播放').click();
      const start = await pointFor(baseline.paths[slider.path.pathId].nodes[0].point, baseline);
      await page.mouse.move(start.x, start.y);
      await page.getByTestId('pixi-canvas').focus();
      await page.waitForFunction(
        () => Number(document.querySelector('[data-testid=playhead]').dataset.timeUs) >= 5990000,
        null,
        { polling: 'raf' },
      );
      await page.keyboard.down('z');
      const result = page.locator(`.result-item[data-note-id="${slider.id}"]`);
      await page.waitForFunction(
        (id) =>
          document
            .querySelector(`.result-item[data-note-id="${id}"]`)
            ?.getAttribute('data-result') === 'active',
        slider.id,
      );
      if (overlay === 'help') await button('快捷键一览').evaluate((el) => el.click());
      else await page.mouse.click(start.x, start.y, { button: 'right' });
      await page.waitForTimeout(180);
      assert.ok(
        await result.locator('[data-reason=released]').count(),
        'Overlay must release the held input',
      );
      if (overlay === 'help') await button('关闭快捷键一览').evaluate((el) => el.click());
      else await page.keyboard.press('Escape');
      await page.keyboard.up('z');
      await page.waitForTimeout(100);
      assert.equal(await page.getByTestId('tracking-status').getAttribute('data-valid'), 'false');
      await button('暂停').click();
    }
    await button('编辑').click();
  });
  await check('菜单键盘导航与最小窗口边缘；模式变化及删掉对象后菜单失效', async () => {
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1080, 720));
    await page.waitForTimeout(250);
    const box = await page.locator('.status-bar').boundingBox();
    await page.mouse.click(box.x + box.width - 6, box.y + box.height - 6, { button: 'right' });
    const m = await menu().boundingBox(),
      size = await page.evaluate(() => ({ w: innerWidth, h: innerHeight }));
    assert.ok(m.x >= 0 && m.y >= 0 && m.x + m.width <= size.w && m.y + m.height <= size.h);
    await page.keyboard.press('End');
    assert.equal(await page.locator(':focus').getAttribute('data-command'), 'help');
    await page.keyboard.press('ArrowUp');
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('Enter');
    await page.getByRole('dialog', { name: '快捷键一览' }).waitFor();
    await page.keyboard.press('Escape');
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1440, 960));
    await right(note(circles[0].id));
    await button('预览').evaluate((el) => el.click());
    assert.equal(await menu().count(), 0);
    await right(note(circles[0].id));
    assert.equal(await menuCommand('object.delete').isEnabled(), false);
    await page.keyboard.press('Escape');
    await button('编辑').click();
    await right(note(circles[0].id));
    await button('删除音符').evaluate((el) => el.click());
    assert.equal(await menu().count(), 0);
    await undo();
  });
  await check('切工程后旧菜单清除，保存重开与布局、按需静止保持', async () => {
    const saved = await save(),
      layout = await prefs();
    await right(note(circles[0].id));
    await button('新建').evaluate((el) => el.click());
    await page.getByRole('dialog').waitFor();
    assert.equal(await menu().count(), 0);
    await page.getByLabel('新工程名称').fill('命令目标隔离');
    await button('创建工程').click();
    await settled();
    await page.getByTestId('pixi-canvas').focus();
    await page.keyboard.press('Delete');
    assert.equal(await target(), '无操作对象');
    await choose(projectFile);
    await button('打开').click();
    await ready();
    assert.equal(await target(), '无操作对象');
    assert.deepEqual(await prefs(), layout);
    const reopened = await save();
    for (const field of ['notes', 'layers', 'sounds', 'reveals', 'camera'])
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
        path.join(directory, 'commands-acceptance.mp4'),
      ],
      { windowsHide: true },
    );
    if (path.dirname(frameFolder) === directory && path.basename(frameFolder).startsWith('frames-'))
      await fs.rm(frameFolder, { recursive: true });
  }
  report.finishedAt = new Date().toISOString();
  await fs.writeFile(path.join(directory, 'report.json'), JSON.stringify(report, null, 2));
}
