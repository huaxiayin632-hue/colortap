import { _electron as electron } from 'playwright';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createProject } from '../src/shared/models.ts';
import { beatTimes, synthesize } from '../tests/fixtures/audio-analysis.ts';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const directory = path.join(root, 'test-results', 'audio-assist'),
  fixtures = path.join(directory, 'fixtures');
const profile = path.join(directory, `profile-${Date.now()}`),
  file = path.join(fixtures, 'project.rcproj');
await fs.mkdir(path.join(fixtures, 'assets'), { recursive: true });
function wav(seconds, bpm) {
  const audio = synthesize(48000, seconds * 1e6, beatTimes(bpm, 137321, seconds * 1e6));
  const samples = audio.channels[0],
    bytes = Buffer.alloc(44 + samples.length * 2);
  bytes.write('RIFF');
  bytes.writeUInt32LE(bytes.length - 8, 4);
  bytes.write('WAVEfmt ', 8);
  bytes.writeUInt32LE(16, 16);
  bytes.writeUInt16LE(1, 20);
  bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(48000, 24);
  bytes.writeUInt32LE(96000, 28);
  bytes.writeUInt16LE(2, 32);
  bytes.writeUInt16LE(16, 34);
  bytes.write('data', 36);
  bytes.writeUInt32LE(samples.length * 2, 40);
  for (let i = 0; i < samples.length; i++)
    bytes.writeInt16LE(Math.round(Math.max(-1, Math.min(1, samples[i])) * 32767), 44 + i * 2);
  return bytes;
}
const original = createProject('音乐卡点编辑验收'),
  musicId = crypto.randomUUID(),
  bytes = wav(180, 120);
original.assets[musicId] = {
  id: musicId,
  kind: 'audio',
  audioRole: 'music',
  relativePath: 'assets/known.wav',
  originalName: '120BPM-Offset137.321ms.wav',
  byteLength: bytes.length,
  sha256: createHash('sha256').update(bytes).digest('hex'),
  audio: { sampleRate: 48000, channels: 1, durationUs: 180e6 },
};
original.music = { assetId: musicId, gain: 0.1 };
function circle(timeUs, x = 100) {
  return {
    id: crypto.randomUUID(),
    kind: 'circle',
    at: { basis: 'time', timeUs },
    position: { x, y: 120 },
    radius: 24,
  };
}
const notes = [
  circle(1_150_123),
  circle(1_670_123, 160),
  { ...circle(2_150_123, 220), kind: 'hold', duration: { basis: 'beat', ticks: 1920 } },
  circle(1_400_123, 280),
  { ...circle(0, 340), at: { basis: 'beat', tick: 5760 } },
];
const pathId = crypto.randomUUID();
original.paths[pathId] = {
  id: pathId,
  name: '曲线',
  closed: false,
  defaultWidth: 48,
  interpolation: 'bezier',
  nodes: [
    {
      id: crypto.randomUUID(),
      point: { x: 80, y: 240 },
      handleIn: { x: 0, y: 0 },
      handleOut: { x: 80, y: -70 },
      mode: 'corner',
    },
    {
      id: crypto.randomUUID(),
      point: { x: 400, y: 240 },
      handleIn: { x: -80, y: 70 },
      handleOut: { x: 0, y: 0 },
      mode: 'corner',
    },
  ],
};
const slider = {
  id: crypto.randomUUID(),
  kind: 'slider',
  at: { basis: 'time', timeUs: 3_150_123 },
  duration: { basis: 'time', durationUs: 900001 },
  headRadius: 24,
  followRadius: 48,
  path: {
    pathId,
    transform: {
      position: { x: 0, y: 0 },
      scale: { x: 1, y: 1 },
      rotationRad: 0,
      skewRad: { x: 0, y: 0 },
      pivot: { x: 0, y: 0 },
    },
  },
};
notes.push(slider);
original.notes = Object.fromEntries(notes.map((n) => [n.id, n]));
await fs.writeFile(path.join(fixtures, 'assets', 'known.wav'), bytes);
await fs.writeFile(file, JSON.stringify(original));
const replacement = path.join(fixtures, '90BPM.wav');
await fs.writeFile(replacement, wav(16, 90));
const env = { ...process.env, RHYTHM_USER_DATA: profile };
delete env.ELECTRON_RUN_AS_NODE;
delete env.ELECTRON_RENDERER_URL;
const report = {
  checks: [],
  pageErrors: [],
  limitations: [
    '真实 Electron 编辑器、Worker、音乐时钟、输入和工程保存；仅替代系统文件选择器答案。',
    '合成 WAV，未验证真实歌曲精度或物理输出/输入延迟。',
  ],
};
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
  await page.evaluate(
    () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
  );
}
async function property(label, value) {
  const el = page.getByLabel(label, { exact: true });
  await el.fill(String(value));
  await el.press('Tab');
  await settled();
}
async function save(target = file, as = false) {
  await choose(target, true);
  await page.getByRole('button', { name: as ? '另存为' : '保存', exact: true }).click();
  await settled();
  await page.waitForFunction(
    () => document.querySelector('.save-state')?.textContent?.trim() === '已保存',
  );
  return JSON.parse(await fs.readFile(target, 'utf8'));
}
async function undo(redo = false) {
  await page.getByRole('button', { name: redo ? '重做' : '撤销', exact: true }).click();
  await settled();
}
async function card() {
  await page.getByRole('button', { name: '音乐卡点', exact: true }).click();
}
function track(id) {
  return page.locator(`.timeline-note[data-note-id="${id}"]`);
}
async function noteTime(id) {
  return Number(await track(id).getAttribute('data-time-us'));
}
async function selectAll() {
  await page.getByRole('button', { name: '选择 工具', exact: true }).click();
  await track(notes[0].id).click();
  await page.keyboard.press('Control+a');
  await card();
}
function nearest(onsets, t, limit = 40_000) {
  return onsets
    .filter((o) => Math.abs(o.timeUs - t) <= limit)
    .sort(
      (a, b) =>
        Math.abs(a.timeUs - t) - Math.abs(b.timeUs - t) ||
        b.strength - a.strength ||
        a.timeUs - b.timeUs,
    )[0];
}
async function drag(id, pixels, alt = false) {
  const b = await track(id).boundingBox();
  assert.ok(b);
  if (alt) await page.keyboard.down('Alt');
  await page.mouse.move(b.x + 5, b.y + b.height / 2);
  await page.mouse.down();
  await page.mouse.move(b.x + 5 + pixels, b.y + b.height / 2, { steps: 8 });
  await page.mouse.up();
  if (alt) await page.keyboard.up('Alt');
  await settled();
}
try {
  app = await electron.launch({ args: [root], cwd: root, env });
  page = await app.firstWindow();
  page.setDefaultTimeout(30000);
  page.on('pageerror', (error) => report.pageErrors.push(String(error)));
  await page.getByTestId('pixi-canvas').waitFor();
  await settled();
  await app.evaluate(({ BrowserWindow }) => {
    const w = BrowserWindow.getAllWindows()[0];
    w.setSize(1600, 1000);
    w.show();
    w.focus();
  });
  await choose(file);
  await page.getByRole('button', { name: '打开', exact: true }).click();
  await settled();
  await card();
  await check('正式编辑器分析中继续播放、切换模式和编辑网格，结果不改谱面', async () => {
    await page.getByRole('button', { name: '分析音乐', exact: true }).click();
    await page.getByTestId('analysis-progress').waitFor();
    await page.getByRole('button', { name: '预览', exact: true }).click();
    await page.getByRole('button', { name: '播放', exact: true }).click();
    await page.getByLabel('节拍细分', { exact: true }).selectOption('8');
    await page.waitForFunction(
      () =>
        Number(document.querySelector('[data-testid=playhead]')?.getAttribute('data-time-us')) >
        200000,
    );
    const playingDuringAnalysis = (await page.getByTestId('analysis-progress').count()) > 0;
    await page.getByRole('button', { name: '暂停', exact: true }).click();
    await page.getByTestId('analysis-summary').waitFor();
    await page.getByTestId('analysis-progress').waitFor({ state: 'detached' });
    await page.getByRole('button', { name: '编辑', exact: true }).click();
    const p = await save();
    assert.deepEqual(p.notes, original.notes);
    assert.deepEqual(p.timing, original.timing);
    assert.equal(p.music.analysis.sourceSha256, original.assets[musicId].sha256);
    assert.equal(p.music.analysis.result.onsets.length, 360);
    assert.equal(playingDuringAnalysis, true);
    return {
      onsets: p.music.analysis.result.onsets.length,
      playingDuringAnalysis,
      notesPreserved: true,
      timingPreserved: true,
    };
  });
  await check('波形、细分网格与起音按同一坐标显示，选择起音只定位', async () => {
    await page.getByLabel('时间轴缩放', { exact: true }).press('End');
    await page.getByRole('button', { name: '定位播放头', exact: true }).click();
    await settled();
    await page.waitForFunction(
      () => document.querySelector('[data-testid=waveform]')?.getAttribute('data-ready') === 'true',
    );
    assert.ok(await page.locator('.beat-grid i.subdivision[data-tick="120"]').count());
    const mark = page.locator('.onset-marker').first(),
      time = Number(await mark.getAttribute('data-time-us'));
    await mark.click();
    assert.equal(Number(await page.getByTestId('playhead').getAttribute('data-time-us')), time);
    const p = await save();
    assert.deepEqual(p.notes, original.notes);
    await page.screenshot({ path: path.join(directory, '音乐卡点.png') });
    return {
      firstOnsetUs: time,
      visibleMarkers: await page.locator('.onset-marker').count(),
      subdivisions: await page.locator('.beat-grid i.subdivision').count(),
      notesPreserved: true,
    };
  });
  await check('BPM 半倍速、Offset 采用为一条历史，按拍联动且按秒保持', async () => {
    await card();
    await property('建议 BPM', 120);
    await property('建议 Offset', 137.321);
    await page.getByRole('button', { name: '半速', exact: true }).click();
    assert.equal(Number(await page.getByLabel('建议 BPM', { exact: true }).inputValue()), 60);
    await page.getByRole('button', { name: '倍速', exact: true }).click();
    await page.getByRole('button', { name: '采用 BPM/Offset', exact: true }).click();
    assert.equal(await noteTime(notes[4].id), 3_137_321);
    assert.equal(await noteTime(notes[0].id), 1_150_123);
    await undo();
    let p = await save();
    assert.deepEqual(p.timing, original.timing);
    await undo(true);
    p = await save();
    assert.equal(p.timing.beatZeroUs, 137321);
    assert.deepEqual(p.notes, original.notes);
    await property('定位到秒', 8.137321);
    await page.getByRole('button', { name: '在播放头添加变速点', exact: true }).click();
    await property('节奏点 2 BPM', 150);
    p = await save();
    assert.equal(p.timing.points[1].bpm, 150);
    await page.getByRole('button', { name: '删除节奏点 2', exact: true }).click();
    await undo();
    p = await save();
    assert.equal(p.timing.points[1].bpm, 150);
    return {
      beatNoteUs: await noteTime(notes[4].id),
      fixedNoteUs: await noteTime(notes[0].id),
      offsetUs: p.timing.beatZeroUs,
      tempoPoints: p.timing.points.length,
    };
  });
  await check('批量头部对齐预览、未匹配保留、长音符时长及一次撤销重做', async () => {
    await selectAll();
    const before = await save(),
      onsets = before.music.analysis.result.onsets;
    await page.getByRole('button', { name: '对齐所选（一次撤销）', exact: true }).click();
    const aligned = await save();
    let changed = 0,
      missed = 0;
    for (const [id, n] of Object.entries(before.notes)) {
      const t = Number(await track(id).getAttribute('data-time-us'));
      const raw = n.at.basis === 'time' ? n.at.timeUs : 137321 + (n.at.tick / 960) * 500000;
      const match = nearest(onsets, raw);
      if (match) {
        assert.deepEqual(aligned.notes[id].at, { basis: 'time', timeUs: match.timeUs });
        assert.equal(t, match.timeUs);
        changed += match.timeUs !== raw ? 1 : 0;
      } else {
        assert.deepEqual(aligned.notes[id], n);
        missed++;
      }
      if (n.kind !== 'circle') assert.deepEqual(aligned.notes[id].duration, n.duration);
    }
    assert.ok(changed >= 4);
    assert.equal(missed, 1);
    await undo();
    assert.deepEqual((await save()).notes, before.notes);
    await undo(true);
    assert.deepEqual((await save()).notes, aligned.notes);
    await page.screenshot({ path: path.join(directory, '批量对齐.png') });
    return {
      changed,
      unmatched: missed,
      exactMicroseconds: true,
      durationsPreserved: true,
      oneUndo: true,
    };
  });
  await check('智能起音组拖动保留间距、范围外不吸附、Alt 暂停吸附', async () => {
    await page.getByLabel('音符吸附模式', { exact: true }).selectOption('onset');
    const before = await save(),
      first = before.notes[notes[0].id].at.timeUs;
    await drag(notes[0].id, 102);
    const moved = await save(),
      shift = moved.notes[notes[0].id].at.timeUs - first;
    assert.ok(Math.abs(shift - 500000) < 1000);
    for (const id of Object.keys(before.notes))
      assert.equal(moved.notes[id].at.timeUs - before.notes[id].at.timeUs, shift);
    await undo();
    await drag(notes[0].id, 20);
    const outside = await save();
    assert.equal(outside.notes[notes[0].id].at.timeUs - first, 100000);
    await undo();
    await drag(notes[0].id, 98, true);
    const bypass = await save();
    assert.equal(bypass.notes[notes[0].id].at.timeUs - first, 490000);
    await undo();
    return { groupShiftUs: shift, outsideRawShiftUs: 100000, altRawShiftUs: 490000 };
  });
  await check('显式尾端对齐、精确人工校正与重新分析保留人工结果', async () => {
    await card();
    await property('起音吸附范围', 110);
    await page.getByLabel('对齐位置', { exact: true }).selectOption('tail');
    const before = await save();
    await page.getByRole('button', { name: '对齐所选（一次撤销）', exact: true }).click();
    const tail = await save();
    assert.deepEqual(tail.notes[slider.id].at, before.notes[slider.id].at);
    assert.equal(tail.notes[slider.id].duration.basis, 'time');
    assert.notDeepEqual(tail.notes[slider.id].duration, before.notes[slider.id].duration);
    await undo();
    assert.deepEqual((await save()).notes, before.notes);
    await page.getByLabel('音符吸附模式', { exact: true }).selectOption('off');
    await page.getByRole('button', { name: '图层 / 谱面', exact: true }).click();
    await track(notes[0].id).click({ modifiers: ['Shift'] });
    await track(notes[0].id).click();
    await property('音符时间', 1.234567);
    const manual = await save();
    assert.equal(manual.notes[notes[0].id].at.timeUs, 1_234_567);
    await card();
    await page.getByRole('button', { name: '重新分析音乐', exact: true }).click();
    await page.getByTestId('analysis-progress').waitFor();
    await page.getByRole('button', { name: '取消分析', exact: true }).click();
    await page.getByTestId('analysis-progress').waitFor({ state: 'detached' });
    await page.getByRole('button', { name: '重新分析音乐', exact: true }).click();
    await page.getByTestId('analysis-progress').waitFor();
    await page.getByTestId('analysis-progress').waitFor({ state: 'detached' });
    const reanalyzed = await save();
    assert.deepEqual(reanalyzed.notes, manual.notes);
    assert.deepEqual(reanalyzed.timing, manual.timing);
    return {
      manualTimeUs: 1_234_567,
      cancelKeptSuggestions: true,
      reanalysisPreservedNotes: true,
      tailUndoPreservedDurationBasis: true,
    };
  });
  await check('分析中换音乐不串结果，撤销恢复旧建议，另存重开恢复全部数据', async () => {
    await card();
    const before = await save();
    await page.getByRole('button', { name: '重新分析音乐', exact: true }).click();
    await page.getByTestId('analysis-progress').waitFor();
    await choose(replacement);
    await page.getByRole('button', { name: '导入音乐', exact: true }).first().click();
    await settled();
    let p = await save();
    assert.equal(p.music.analysis, undefined);
    assert.notEqual(p.music.assetId, before.music.assetId);
    assert.deepEqual(p.notes, before.notes);
    await undo();
    p = await save();
    assert.deepEqual(p.music, before.music);
    const portable = path.join(fixtures, 'portable', 'copy.rcproj');
    const saved = await save(portable, true);
    await choose(portable);
    await page.getByRole('button', { name: '打开', exact: true }).click();
    await settled();
    await card();
    await page.getByTestId('analysis-summary').waitFor();
    const reopened = await save();
    assert.deepEqual(reopened.music, saved.music);
    assert.deepEqual(reopened.notes, saved.notes);
    assert.deepEqual(reopened.timing, saved.timing);
    assert.ok(
      (
        await fs.stat(
          path.join(path.dirname(portable), saved.assets[saved.music.assetId].relativePath),
        )
      ).size > 44,
    );
    await page.screenshot({ path: path.join(directory, '保存恢复.png') });
    return {
      sourceSwitchInvalidated: true,
      undoRestoredSuggestions: true,
      portableAssets: true,
      restored: ['analysis', 'timing', 'notes', 'durationBases'],
    };
  });
  assert.deepEqual(report.pageErrors, []);
  report.passed = true;
} catch (error) {
  report.passed = false;
  report.error = error.stack ?? String(error);
  console.error(report.error);
  process.exitCode = 1;
  if (page) await page.screenshot({ path: path.join(directory, 'failure.png') }).catch(() => {});
} finally {
  await fs.writeFile(path.join(directory, 'editor.json'), JSON.stringify(report, null, 2));
  if (app) {
    await app.evaluate(({ app }) => app.exit(0)).catch(() => {});
    await app.close().catch(() => {});
  }
  for (const temporary of [profile, fixtures]) {
    const target = path.resolve(temporary);
    if (
      path.dirname(target) !== directory ||
      (!path.basename(target).startsWith('profile-') && path.basename(target) !== 'fixtures')
    )
      throw Error('Unexpected test cleanup path');
    await fs.rm(target, { recursive: true, force: true });
  }
}
