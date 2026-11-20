import { _electron as electron } from 'playwright';
import { PNG } from 'pngjs';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const directory = path.join(root, 'test-results', 'stage3');
await fs.mkdir(directory, { recursive: true });
const environment = {
  ...process.env,
  RHYTHM_USER_DATA: path.join(directory, `profile-${Date.now()}`),
};
delete environment.ELECTRON_RUN_AS_NODE;
delete environment.ELECTRON_RENDERER_URL;
const report = {
  stage: 3,
  startedAt: new Date().toISOString(),
  checks: [],
  consoleErrors: [],
  limitations: [
    'Generated WAV and existing generated PSD fixture; not an external Photoshop production illustration.',
    'Inputs below use actual Electron mouse/keyboard events against the real audio transport; judgement is not mocked.',
  ],
};
let application, page, saved;
function wav() {
  const rate = 24000,
    frames = rate * 16,
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
  for (let i = 0; i < frames; i++) {
    const age = (i / rate) % 0.5;
    bytes.writeInt16LE(
      Math.round(Math.sin(age * Math.PI * 2 * 880) * Math.exp(-age * 50) * 4000),
      44 + i * 2,
    );
  }
  return bytes;
}
const music = path.join(directory, '120BPM.wav');
await fs.writeFile(music, wav());
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
  await page.locator('.editor-shell[aria-busy=false]').waitFor();
}
async function frames() {
  await page.evaluate(
    () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
  );
}
async function property(label, value) {
  const input = page.getByLabel(label, { exact: true });
  await input.fill(String(value));
  await input.press('Tab');
}
async function jump(seconds) {
  await property('定位到秒', seconds);
  await frames();
}
async function history(name = '撤销') {
  await page.getByRole('button', { name, exact: true }).click();
  await settled();
  await frames();
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
function mapping(project) {
  const r = project.stage.playfieldRect,
    s = project.stage.artworkSize,
    c = project.stage.chartSize;
  const x = Math.max(0, r.x),
    y = Math.max(0, r.y),
    width = Math.min(s.width, r.x + r.width) - x,
    height = Math.min(s.height, r.y + r.height) - y;
  const scale = Math.min(width / c.width, height / c.height);
  return { scale, x: x + (width - c.width * scale) / 2, y: y + (height - c.height * scale) / 2 };
}
async function canvasPoint(p, project = saved) {
  const m = mapping(project),
    host = page.getByTestId('canvas-host');
  const v = await host.evaluate((el) => ({
    zoom: Number(el.dataset.zoom),
    x: Number(el.dataset.panX),
    y: Number(el.dataset.panY),
  }));
  const bounds = await page.getByTestId('pixi-canvas').boundingBox();
  return {
    x: bounds.x + v.x + (m.x + p.x * m.scale) * v.zoom,
    y: bounds.y + v.y + (m.y + p.y * m.scale) * v.zoom,
  };
}
async function moveTo(p) {
  const at = await canvasPoint(p);
  await page.mouse.move(at.x, at.y);
}
async function clickAt(p) {
  const at = await canvasPoint(p);
  await page.mouse.click(at.x, at.y);
}
async function drag(from, to) {
  const a = await canvasPoint(from),
    b = await canvasPoint(to);
  await page.mouse.move(a.x, a.y);
  await page.mouse.down();
  await page.mouse.move(b.x, b.y, { steps: 12 });
  await page.mouse.up();
  await frames();
}
async function countNotes(n) {
  await page.waitForFunction((n) => document.querySelectorAll('.timeline-note').length === n, n);
}
async function timeUs() {
  return Number(await page.getByTestId('playhead').getAttribute('data-time-us'));
}
async function until(at) {
  await page.waitForFunction(
    (at) =>
      Number(document.querySelector('[data-testid=playhead]')?.getAttribute('data-time-us')) >= at,
    at,
    { timeout: 20000 },
  );
}
function track(id) {
  return page.locator(`.timeline-note[data-note-id="${id}"]`);
}
function result(id) {
  return page.locator(`.result-item[data-note-id="${id}"]`);
}
async function assertResult(id, status) {
  await page
    .locator(`.result-item[data-note-id="${id}"][data-result="${status}"]`)
    .waitFor({ state: 'attached', timeout: 3000 });
}
// Independent dense cubic sampling drives an actual mouse along the saved path, not along renderer internals.
function samplePath(note, project) {
  const pathData = project.paths[note.path.pathId],
    t = note.path.transform;
  const samples = [];
  let length = 0;
  const transform = (p) => {
    const a = Math.cos(t.rotationRad + t.skewRad.y) * t.scale.x,
      b = Math.sin(t.rotationRad + t.skewRad.y) * t.scale.x;
    const c = -Math.sin(t.rotationRad - t.skewRad.x) * t.scale.y,
      d = Math.cos(t.rotationRad - t.skewRad.x) * t.scale.y;
    return {
      x: (p.x - t.pivot.x) * a + (p.y - t.pivot.y) * c + t.position.x,
      y: (p.x - t.pivot.x) * b + (p.y - t.pivot.y) * d + t.position.y,
    };
  };
  for (let segment = 0; segment < pathData.nodes.length - 1; segment++) {
    const a = pathData.nodes[segment],
      b = pathData.nodes[segment + 1];
    for (let i = segment ? 1 : 0; i <= 2000; i++) {
      const u = i / 2000,
        v = 1 - u;
      const p =
        pathData.interpolation === 'polyline'
          ? { x: a.point.x * v + b.point.x * u, y: a.point.y * v + b.point.y * u }
          : {
              x:
                v ** 3 * a.point.x +
                3 * v * v * u * (a.point.x + a.handleOut.x) +
                3 * v * u * u * (b.point.x + b.handleIn.x) +
                u ** 3 * b.point.x,
              y:
                v ** 3 * a.point.y +
                3 * v * v * u * (a.point.y + a.handleOut.y) +
                3 * v * u * u * (b.point.y + b.handleIn.y) +
                u ** 3 * b.point.y,
            };
      const world = transform(p),
        prev = samples.at(-1);
      if (prev) length += Math.hypot(world.x - prev.x, world.y - prev.y);
      samples.push({ ...world, distance: length });
    }
  }
  return (progress) => {
    const d = Math.max(0, Math.min(1, note.path.reversed ? 1 - progress : progress)) * length;
    let i = 1;
    while (i < samples.length - 1 && samples[i].distance < d) i++;
    const a = samples[i - 1],
      b = samples[i],
      u = b.distance === a.distance ? 0 : (d - a.distance) / (b.distance - a.distance);
    return { x: a.x + (b.x - a.x) * u, y: a.y + (b.y - a.y) * u };
  };
}
async function ballPixel(p) {
  const at = await canvasPoint(p),
    box = await page.getByTestId('pixi-canvas').boundingBox(),
    png = PNG.sync.read(await page.getByTestId('pixi-canvas').screenshot());
  const x = Math.round(((at.x - box.x) * png.width) / box.width),
    y = Math.round(((at.y - box.y) * png.height) / box.height),
    i = (y * png.width + x) * 4;
  const rgb = [...png.data.subarray(i, i + 3)];
  assert.ok(
    rgb.every((c) => c > 210),
    `Slider ball missing at ${JSON.stringify(p)}: ${rgb}`,
  );
  return rgb;
}
let circles, slider, follow;
const projectFile = path.join(directory, '工程', '谱面验收.rcproj');
try {
  application = await electron.launch({ args: [root], cwd: root, env: environment });
  page = await application.firstWindow();
  page.setDefaultTimeout(30000);
  page.on('pageerror', (error) => report.consoleErrors.push(String(error)));
  page.on('console', (message) => {
    if (message.type() === 'error') report.consoleErrors.push(message.text());
  });
  await page.getByTestId('pixi-canvas').waitFor();
  await settled();
  await check('实际窗口创建工程、导入音乐和 1/4、1/8、1/16 节拍放置 Circle', async () => {
    await page.getByRole('button', { name: '新建', exact: true }).click();
    await page.getByLabel('新工程名称').fill('阶段 3 谱面验收');
    await page.getByLabel('新工程宽度').fill('1024');
    await page.getByLabel('新工程高度').fill('768');
    await page.getByRole('button', { name: '创建工程', exact: true }).click();
    await settled();
    await choose(music);
    await page.getByRole('button', { name: '导入音乐', exact: true }).first().click();
    await settled();
    await page.locator('[data-testid=waveform][data-ready=true]').waitFor();
    saved = await save(projectFile);
    const snapTimes = [];
    for (const divisions of [4, 8, 16]) {
      await page.getByLabel('节拍细分').selectOption(String(divisions));
      await jump(0.16);
      await page.getByRole('button', { name: 'Circle 工具', exact: true }).click();
      await clickAt({ x: 80, y: 60 });
      snapTimes.push(
        Number(await page.locator('.timeline-note.selected').getAttribute('data-time-us')),
      );
      await history();
    }
    assert.deepEqual(snapTimes, [125000, 187500, 156250]);
    const locations = [
      { x: 80, y: 100 },
      { x: 200, y: 120 },
      { x: 340, y: 100 },
    ];
    for (let i = 0; i < 3; i++) {
      await page.getByLabel('节拍细分').selectOption(String([4, 8, 16][i]));
      await jump(1.5 + i);
      await page.getByRole('button', { name: 'Circle 工具', exact: true }).click();
      await clickAt(locations[i]);
    }
    await countNotes(3);
    saved = await save(projectFile);
    circles = Object.values(saved.notes).sort((a, b) => a.at.tick - b.at.tick);
    assert.deepEqual(
      circles.map((n) => n.at),
      [2880, 4800, 6720].map((tick) => ({ basis: 'beat', tick })),
    );
    await page.getByLabel('节拍细分').selectOption('4');
    return { noteIds: circles.map((n) => n.id), moments: circles.map((n) => n.at) };
  });
  await check('批量时间偏移拖动只应用一次，撤销恢复原时间', async () => {
    await page.getByRole('button', { name: '全选', exact: true }).click();
    const field = page.getByLabel('批量时间偏移', { exact: true });
    await page.locator('.inspector-scroll').evaluate((el) => (el.scrollTop = 0));
    await field.scrollIntoViewIfNeeded();
    const before = await Promise.all(
      circles.map(async (note) => [
        note.id,
        Number(await track(note.id).getAttribute('data-time-us')),
      ]),
    );
    const bounds = await field.boundingBox();
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
    await page.mouse.move(bounds.x + 18, bounds.y + bounds.height / 2, { steps: 4 });
    await page.mouse.up();
    await settled();
    for (const [id, timeUs] of before)
      assert.equal(Number(await track(id).getAttribute('data-time-us')), timeUs + 1000000);
    await history();
    for (const [id, timeUs] of before)
      assert.equal(Number(await track(id).getAttribute('data-time-us')), timeUs);
    return { offsetUs: 8 * 125000, before };
  });
  await check('钢笔连续曲线：拖出切线、点击锚点、完成/取消和单步撤销重做', async () => {
    await jump(5);
    await page.getByRole('button', { name: 'Slider 工具', exact: true }).click();
    await drag({ x: 100, y: 280 }, { x: 150, y: 160 });
    await clickAt({ x: 250, y: 220 });
    await drag({ x: 400, y: 280 }, { x: 420, y: 340 });
    await countNotes(3);
    await page.screenshot({ path: path.join(directory, 'pen-draft.png') });
    await page.keyboard.press('Enter');
    await countNotes(4);
    const created = await save(projectFile),
      note = Object.values(created.notes).find((n) => n.kind === 'slider'),
      curvePath = created.paths[note.path.pathId];
    assert.equal(curvePath.interpolation, 'bezier');
    assert.equal(curvePath.nodes.length, 3);
    assert.ok(Math.abs(curvePath.nodes[0].handleOut.x - 50) < 1);
    assert.ok(Math.abs(curvePath.nodes[0].handleOut.y + 120) < 1);
    assert.ok(curvePath.nodes.every((n) => n.mode === 'mirrored'));
    await history();
    await countNotes(3);
    await history('重做');
    await countNotes(4);
    assert.deepEqual((await save(projectFile)).paths[curvePath.id], curvePath);
    await history();
    await countNotes(3);
    await page.getByRole('button', { name: 'Slider 工具', exact: true }).click();
    await clickAt({ x: 60, y: 210 });
    await clickAt({ x: 150, y: 250 });
    await page.keyboard.press('Escape');
    await page.keyboard.press('Enter');
    await countNotes(3);
    return {
      nodes: curvePath.nodes,
      interpolation: curvePath.interpolation,
      oneUndo: true,
      cancelled: true,
    };
  });
  await check('创建 Slider，通过鼠标操作节点和控制柄，添加/删除节点及撤销', async () => {
    await jump(5);
    await page.getByRole('button', { name: 'Slider 工具', exact: true }).click();
    await clickAt({ x: 100, y: 280 });
    await clickAt({ x: 400, y: 280 });
    await page.keyboard.press('Enter');
    await countNotes(4);
    await drag({ x: 200, y: 280 }, { x: 160, y: 160 });
    assert.ok(
      Math.abs(Number(await page.getByLabel('出柄 Y', { exact: true }).inputValue()) + 120) < 3,
    );
    await drag({ x: 300, y: 280 }, { x: 340, y: 160 });
    await drag({ x: 400, y: 280 }, { x: 420, y: 260 });
    assert.ok(
      Math.abs(Number(await page.getByLabel('节点 X', { exact: true }).inputValue()) - 420) < 3,
    );
    await history();
    await page.getByRole('button', { name: '添加节点', exact: true }).click();
    assert.equal(await page.getByLabel('路径节点', { exact: true }).locator('option').count(), 3);
    await page.getByRole('button', { name: '删除节点', exact: true }).click();
    assert.equal(await page.getByLabel('路径节点', { exact: true }).locator('option').count(), 2);
    await history();
    assert.equal(await page.getByLabel('路径节点', { exact: true }).locator('option').count(), 3);
    await history();
    assert.equal(await page.getByLabel('路径节点', { exact: true }).locator('option').count(), 2);
    await property('Slider 持续秒数', 2);
    const midpoint = await canvasPoint({ x: 250, y: 190 });
    await page.mouse.dblclick(midpoint.x, midpoint.y);
    assert.equal(await page.getByLabel('路径节点', { exact: true }).locator('option').count(), 3);
    await page.keyboard.press('Delete');
    assert.equal(await page.getByLabel('路径节点', { exact: true }).locator('option').count(), 2);
    await history();
    await history();
    saved = await save(projectFile);
    slider = Object.values(saved.notes).find((n) => n.kind === 'slider');
    follow = samplePath(slider, saved);
    assert.ok(saved.paths[slider.path.pathId].nodes[0].handleOut.y < -100);
    assert.ok(saved.paths[slider.path.pathId].nodes[1].handleIn.y < -100);
    await page.screenshot({ path: path.join(directory, 'path-editor.png') });
    return { sliderId: slider.id, nodes: saved.paths[slider.path.pathId].nodes };
  });
  await check('折线/贝塞尔切换、方向和速度可编辑，预览滑球按弧长位置实际渲染', async () => {
    await page.getByLabel('路径类型', { exact: true }).selectOption('polyline');
    await page.getByLabel('路径类型', { exact: true }).selectOption('bezier');
    await page.getByLabel('滑动方向', { exact: true }).selectOption('reverse');
    assert.ok(
      Math.abs(Number(await page.getByLabel('音符 X', { exact: true }).inputValue()) - 400) < 3,
    );
    await page.getByLabel('滑动方向', { exact: true }).selectOption('forward');
    const oldSpeed = Number(await page.getByLabel('Slider 速度', { exact: true }).inputValue());
    await property('Slider 速度', oldSpeed * 2);
    assert.ok(
      Math.abs(Number(await page.getByLabel('Slider 持续秒数', { exact: true }).inputValue()) - 1) <
        0.01,
    );
    await property('Slider 持续秒数', 2);
    saved = await save(projectFile);
    slider = Object.values(saved.notes).find((n) => n.kind === 'slider');
    follow = samplePath(slider, saved);
    await page.getByRole('button', { name: '预览', exact: true }).click();
    await jump(6);
    await ballPixel(follow(0.5));
    await jump(6.5);
    await ballPixel(follow(0.75));
    await page.screenshot({ path: path.join(directory, 'slider-preview.png') });
    await page.getByRole('button', { name: '编辑', exact: true }).click();
    return { half: follow(0.5), threeQuarters: follow(0.75), speed: oldSpeed };
  });
  await check('框选/批选、复制、独立路径副本、批量拖动和删除支持撤销重做', async () => {
    await page.getByRole('button', { name: '选择 工具', exact: true }).click();
    await jump(1.6);
    await clickAt({ x: 480, y: 360 });
    await drag({ x: 40, y: 60 }, { x: 240, y: 160 });
    assert.equal(await page.locator('.timeline-note.selected').count(), 2);
    await page.keyboard.press('Control+a');
    const cancelledFrom = await canvasPoint(circles[0].position),
      cancelledTo = await canvasPoint({
        x: circles[0].position.x + 30,
        y: circles[0].position.y + 10,
      });
    await page.mouse.move(cancelledFrom.x, cancelledFrom.y);
    await page.mouse.down();
    await page.mouse.move(cancelledTo.x, cancelledTo.y, { steps: 4 });
    await page.keyboard.press('Escape');
    await page.mouse.up();
    const cancelled = await save(path.join(directory, '取消拖动', '取消.rcproj'), true);
    assert.ok(Math.abs(cancelled.notes[circles[0].id].position.x - circles[0].position.x) < 0.01);
    await page.keyboard.press('Control+a');
    assert.equal(await page.locator('.timeline-note.selected').count(), 4);
    await page.keyboard.press('Control+d');
    await countNotes(8);
    const copy = await save(path.join(directory, '副本验证', '复制.rcproj'), true);
    assert.equal(Object.keys(copy.paths).length, 2);
    await history();
    await countNotes(4);
    await history('重做');
    await countNotes(8);
    await history();
    await countNotes(4);
    await page.keyboard.press('Control+a');
    await page.keyboard.press('Control+c');
    await page.keyboard.press('Control+v');
    await countNotes(8);
    await history();
    await countNotes(4);
    await page.keyboard.press('Control+a');
    await drag(circles[0].position, {
      x: circles[0].position.x + 20,
      y: circles[0].position.y + 10,
    });
    const moved = await save(path.join(directory, '拖动验证', '拖动.rcproj'), true);
    assert.ok(Math.abs(moved.notes[circles[0].id].position.x - circles[0].position.x - 20) < 3);
    assert.ok(Math.abs(moved.notes[slider.id].path.transform.position.x - 20) < 3);
    await history();
    await page.keyboard.press('Control+a');
    await page.keyboard.press('Delete');
    await countNotes(0);
    await history();
    await countNotes(4);
    saved = await save(projectFile, true);
  });
  await check('谱面时间轴拖动时间和 Slider 时长，撤销后恢复，项目重新打开完整保留', async () => {
    const first = track(circles[0].id),
      rect = await first.boundingBox();
    await page.mouse.move(rect.x + 7, rect.y + 10);
    await page.mouse.down();
    await page.mouse.move(rect.x + 51, rect.y + 10, { steps: 10 });
    await page.mouse.up();
    assert.equal(Number(await first.getAttribute('data-time-us')), 2500000);
    await history();
    assert.equal(Number(await first.getAttribute('data-time-us')), 1500000);
    const handle = track(slider.id).locator('.duration-handle'),
      h = await handle.boundingBox();
    await page.mouse.move(h.x + 4, h.y + 8);
    await page.mouse.down();
    await page.mouse.move(h.x + 48, h.y + 8, { steps: 10 });
    await page.mouse.up();
    assert.equal(Number(await track(slider.id).getAttribute('data-end-us')), 8000000);
    await history();
    saved = await save(projectFile, true);
    await choose(projectFile);
    await page.getByRole('button', { name: '打开', exact: true }).click();
    await settled();
    await page.locator('[data-testid=waveform][data-ready=true]').waitFor();
    await countNotes(4);
    const reopened = await save(path.join(directory, '恢复验证', '恢复.rcproj'), true);
    assert.deepEqual(reopened.notes, saved.notes);
    assert.deepEqual(reopened.paths, saved.paths);
    saved = reopened;
    await property('Perfect 窗口', 60);
    await property('Good 窗口', 140);
    const configured = await save(path.join(directory, '判定设置', '窗口.rcproj'), true);
    assert.equal(configured.rules.hitWindowsUs.perfect, 60000);
    assert.equal(configured.rules.hitWindowsUs.good, 140000);
    await history();
    await history();
    assert.equal(await page.getByLabel('Perfect 窗口', { exact: true }).inputValue(), '50');
    assert.equal(await page.getByLabel('Good 窗口', { exact: true }).inputValue(), '100');
  });
  await check(
    '真实鼠标/键盘按音乐时间完成 Circle Perfect/Good/Miss 与弯曲 Slider 追踪',
    async () => {
      await jump(0);
      await page.getByRole('button', { name: '试玩', exact: true }).click();
      await page.getByRole('button', { name: '播放', exact: true }).click();
      await moveTo(circles[0].position);
      await until(1485000);
      await page.mouse.down();
      await page.mouse.up();
      await assertResult(circles[0].id, 'perfect');
      await moveTo(circles[1].position);
      await until(2551000);
      await page.keyboard.press('z');
      await assertResult(circles[1].id, 'good');
      await until(3700000);
      await assertResult(circles[2].id, 'miss');
      const earlyEvents = await page
        .getByTestId('gameplay-events')
        .locator('li')
        .evaluateAll((items) =>
          items.map((el) => ({ kind: el.dataset.kind, noteId: el.dataset.noteId })),
        );
      assert.ok(earlyEvents.some((e) => e.kind === 'circle-hit' && e.noteId === circles[0].id));
      assert.ok(earlyEvents.some((e) => e.kind === 'circle-miss' && e.noteId === circles[2].id));
      const runBeforeVolume = await page
        .getByLabel('试玩记录', { exact: true })
        .getAttribute('data-run-id');
      await page.getByLabel('音乐音量', { exact: true }).focus();
      await page.keyboard.press('ArrowLeft');
      assert.equal(
        await page.getByLabel('试玩记录', { exact: true }).getAttribute('data-run-id'),
        runBeforeVolume,
      );
      await assertResult(circles[0].id, 'perfect');
      await moveTo(follow(0));
      await until(4985000);
      await page.mouse.down();
      while ((await timeUs()) < 7040000) {
        const t = await timeUs();
        await moveTo(follow((t - 5000000) / 2000000));
        await page.waitForTimeout(8);
      }
      await page.mouse.up();
      await assertResult(slider.id, 'complete');
      const ratio = Number(await result(slider.id).getAttribute('data-progress'));
      assert.ok(ratio > 0.9);
      const recent = await page
        .getByTestId('gameplay-events')
        .locator('li')
        .evaluateAll((items) => items.map((el) => el.dataset.kind));
      assert.ok(recent.includes('slider-progress'));
      assert.ok(recent.includes('slider-complete'));
      await page.getByRole('button', { name: '暂停', exact: true }).click();
      await page.screenshot({ path: path.join(directory, 'playtest-success.png') });
      return {
        circleResults: ['perfect', 'good', 'miss'],
        windowsUs: saved.rules.hitWindowsUs,
        sliderEffectiveRatio: ratio,
        eventIdsVerified: true,
      };
    },
  );
  await check('Slider 真实松键/偏离区间与失败，暂停冻结，继续与跳转重置一致', async () => {
    await jump(4.5);
    await page.getByRole('button', { name: '播放', exact: true }).click();
    await moveTo(follow(0));
    await until(4985000);
    await page.keyboard.down('x');
    while ((await timeUs()) < 5400000) {
      const t = await timeUs();
      await moveTo(follow((t - 5000000) / 2000000));
      await page.waitForTimeout(8);
    }
    await page.getByRole('button', { name: '暂停', exact: true }).click();
    await page.keyboard.up('x');
    const paused = await timeUs(),
      frozen = Number(await result(slider.id).getAttribute('data-progress'));
    await page.waitForTimeout(100);
    assert.equal(await timeUs(), paused);
    assert.equal(Number(await result(slider.id).getAttribute('data-progress')), frozen);
    await moveTo(follow((paused - 5000000) / 2000000));
    await page.keyboard.press('Space');
    await page.keyboard.down('x');
    let released = false,
      resumed = false;
    while ((await timeUs()) < 7040000) {
      const t = await timeUs();
      if (t >= 5900000 && !released) {
        await page.keyboard.up('x');
        released = true;
      }
      if (t >= 6350000 && !resumed) {
        await page.keyboard.down('x');
        resumed = true;
      }
      const at = follow((t - 5000000) / 2000000);
      if (t >= 6500000 && t < 6900000) at.y += 140;
      await moveTo(at);
      await page.waitForTimeout(8);
    }
    await page.keyboard.up('x');
    await assertResult(slider.id, 'failed');
    const intervals = await result(slider.id)
      .locator('[data-reason]')
      .evaluateAll((items) =>
        items.map((el) => ({
          reason: el.dataset.reason,
          startUs: Number(el.dataset.startUs),
          endUs: Number(el.dataset.endUs),
        })),
      );
    assert.ok(intervals.some((i) => i.reason === 'released' && i.endUs - i.startUs > 200000));
    assert.ok(intervals.some((i) => i.reason === 'outside' && i.endUs - i.startUs > 200000));
    const oldRun = await page.getByLabel('试玩记录', { exact: true }).getAttribute('data-run-id');
    await page.getByRole('button', { name: '暂停', exact: true }).click();
    await page.getByRole('button', { name: '回到开头', exact: true }).click();
    assert.notEqual(
      await page.getByLabel('试玩记录', { exact: true }).getAttribute('data-run-id'),
      oldRun,
    );
    await assertResult(slider.id, 'pending');
    await page.getByRole('button', { name: '从头试玩', exact: true }).click();
    await until(100000);
    assert.ok((await timeUs()) < 600000);
    await assertResult(circles[0].id, 'pending');
    await page.getByRole('button', { name: '暂停', exact: true }).click();
    await page.getByRole('button', { name: '编辑', exact: true }).click();
    const after = await save(path.join(directory, '试玩后', '文档.rcproj'), true);
    assert.deepEqual(after.notes, saved.notes);
    assert.deepEqual(after.paths, saved.paths);
    return { pausedUs: paused, intervals };
  });
  await check('缩放和平移后的逻辑输入判定保持一致', async () => {
    await jump(1.2);
    await page.getByRole('button', { name: '放大画布', exact: true }).click();
    const canvas = await page.getByTestId('pixi-canvas').boundingBox();
    await page.mouse.move(canvas.x + canvas.width / 2, canvas.y + canvas.height / 2);
    await page.mouse.down({ button: 'middle' });
    await page.mouse.move(canvas.x + canvas.width / 2 + 25, canvas.y + canvas.height / 2 + 15, {
      steps: 5,
    });
    await page.mouse.up({ button: 'middle' });
    await page.getByRole('button', { name: '试玩', exact: true }).click();
    await moveTo(circles[0].position);
    const click = await canvasPoint(circles[0].position);
    await page.getByRole('button', { name: '播放', exact: true }).click();
    await until(1485000);
    await page.mouse.click(click.x, click.y);
    await assertResult(circles[0].id, 'perfect');
    await page.getByRole('button', { name: '暂停', exact: true }).click();
    await page.getByRole('button', { name: '编辑', exact: true }).click();
    await page.getByRole('button', { name: '适合窗口', exact: true }).click();
  });
  await check('100 层 PSD 旧工程与谱面并存，排序、保存重开和音乐仍正常', async () => {
    await page.getByRole('button', { name: '选择 工具', exact: true }).click();
    await page.keyboard.press('Control+a');
    await page.keyboard.press('Control+c');
    await choose(path.join(root, '示例工程', '图层练习', '6000像素图层练习.rcproj'));
    await page.getByRole('button', { name: '打开', exact: true }).click();
    await settled();
    await page.locator('[data-testid=waveform][data-ready=true]').waitFor();
    assert.equal(await page.getByRole('treeitem').count(), 110);
    await page.getByRole('button', { name: '选择 工具', exact: true }).click();
    await page.keyboard.press('Control+v');
    await countNotes(4);
    const layer = page
      .locator('.layer-row')
      .filter({ has: page.locator('.layer-name', { hasText: '背景 · 原尺寸 6000' }) });
    await layer.click();
    await page.getByRole('button', { name: '图层上移', exact: true }).click();
    await page.getByRole('button', { name: '撤销', exact: true }).click();
    await property('工程名称', '阶段 3 · Circle 与 Slider 练习');
    const file = path.join(directory, '百图层回归', '谱面与Slider练习.rcproj');
    saved = await save(file, true);
    assert.equal(Object.keys(saved.notes).length, 4);
    assert.equal(Object.values(saved.layers).filter((l) => l.kind !== 'group').length, 100);
    await choose(file);
    await page.getByRole('button', { name: '打开', exact: true }).click();
    await settled();
    await countNotes(4);
    await page.locator('[data-testid=waveform][data-ready=true]').waitFor();
    await page.getByRole('button', { name: '预览', exact: true }).click();
    await jump(6);
    await page.screenshot({ path: path.join(directory, '100-layers-chart.png') });
    await page.getByRole('button', { name: '播放', exact: true }).click();
    const at = await timeUs();
    await until(at + 200000);
    await page.getByRole('button', { name: '暂停', exact: true }).click();
    return {
      example: file,
      layers: Object.keys(saved.layers).length,
      notes: Object.keys(saved.notes).length,
    };
  });
  assert.deepEqual(report.consoleErrors, []);
  report.passed = true;
} catch (error) {
  report.passed = false;
  report.error = error.stack ?? String(error);
  console.error(report.error);
  if (page && !page.isClosed())
    report.lastResults = await page
      .locator('.result-item')
      .evaluateAll((items) =>
        items.map((el) => ({
          id: el.dataset.noteId,
          status: el.dataset.result,
          text: el.textContent,
        })),
      )
      .catch(() => []);
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
console.log(`Stage 3: ${report.checks.filter((c) => c.passed).length}/${report.checks.length}`);
