import { _electron as electron } from 'playwright';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const results = path.join(root, 'test-results', 'e2e');
const fixtureDir = path.join(results, '输入素材');
await fs.mkdir(fixtureDir, { recursive: true });

function makeWav(seconds = 18) {
  const sampleRate = 48000,
    channels = 2,
    frames = sampleRate * seconds;
  const bytes = Buffer.alloc(44 + frames * channels * 2);
  bytes.write('RIFF', 0);
  bytes.writeUInt32LE(bytes.length - 8, 4);
  bytes.write('WAVEfmt ', 8);
  bytes.writeUInt32LE(16, 16);
  bytes.writeUInt16LE(1, 20);
  bytes.writeUInt16LE(channels, 22);
  bytes.writeUInt32LE(sampleRate, 24);
  bytes.writeUInt32LE(sampleRate * channels * 2, 28);
  bytes.writeUInt16LE(channels * 2, 32);
  bytes.writeUInt16LE(16, 34);
  bytes.write('data', 36);
  bytes.writeUInt32LE(bytes.length - 44, 40);
  for (let frame = 0; frame < frames; frame++) {
    const time = frame / sampleRate,
      beatAge = time % 0.5;
    const tone = Math.sin(time * Math.PI * 2 * 220) * 0.04;
    const click = Math.sin(beatAge * Math.PI * 2 * 880) * Math.exp(-beatAge * 65) * 0.17;
    const value = Math.round((tone + click) * 32767);
    for (let channel = 0; channel < channels; channel++)
      bytes.writeInt16LE(value, 44 + (frame * channels + channel) * 2);
  }
  return bytes;
}
const wav = path.join(fixtureDir, '示例节拍 120BPM.wav');
await fs.writeFile(wav, makeWav());
const ffmpeg = process.env.FFMPEG_PATH || 'ffmpeg';
const mp3 = path.join(fixtureDir, '格式测试.mp3'),
  ogg = path.join(fixtureDir, '格式测试.ogg');
execFileSync(ffmpeg, ['-y', '-v', 'error', '-i', wav, '-t', '4', '-c:a', 'libmp3lame', mp3], {
  windowsHide: true,
});
execFileSync(ffmpeg, ['-y', '-v', 'error', '-i', wav, '-t', '4', '-c:a', 'libvorbis', ogg], {
  windowsHide: true,
});
const badMusic = path.join(fixtureDir, '损坏音乐.wav');
await fs.writeFile(badMusic, 'not a wave file');
const badProject = path.join(fixtureDir, '不支持的工程.rcproj');
await fs.writeFile(badProject, JSON.stringify({ format: 'rhythm-canvas', schemaVersion: 999 }));
const projectFile = path.join(results, '工程 中文 空格', '阶段1验收.rcproj');
const report = {
  stage: 1,
  startedAt: new Date().toISOString(),
  platform: process.platform,
  checks: [],
  consoleErrors: [],
  warnings: [],
  measurements: {},
};
const environment = {
  ...process.env,
  RHYTHM_USER_DATA: path.join(results, `profile-${Date.now()}`),
};
delete environment.ELECTRON_RUN_AS_NODE;
delete environment.ELECTRON_RENDERER_URL;
let application, page;
const importedMusic = new Map();

async function check(name, operation) {
  const start = performance.now();
  try {
    const evidence = await operation();
    report.checks.push({
      name,
      passed: true,
      elapsedMs: Math.round(performance.now() - start),
      evidence,
    });
    console.log(`PASS ${name}`);
  } catch (error) {
    report.checks.push({ name, passed: false, error: String(error) });
    throw error;
  }
}
async function chooseOpen(file) {
  await application.evaluate(({ dialog }, selected) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [selected] });
  }, file);
}
async function chooseSave(file) {
  await application.evaluate(({ dialog }, selected) => {
    dialog.showSaveDialog = async () => ({ canceled: false, filePath: selected });
  }, file);
}
async function timeUs() {
  return Number(await page.getByTestId('playhead').getAttribute('data-time-us'));
}
async function jump(seconds) {
  const input = page.getByLabel('定位到秒', { exact: true });
  await input.fill(String(seconds));
  await input.press('Tab');
}
async function waitTime(minimum) {
  await page.waitForFunction(
    (min) =>
      Number(document.querySelector('[data-testid=playhead]')?.getAttribute('data-time-us')) >= min,
    minimum,
  );
}
async function createDocument(name) {
  await page.getByRole('button', { name: '新建', exact: true }).click();
  await page.getByLabel('新工程名称', { exact: true }).fill(name);
  await page.getByRole('button', { name: '创建工程', exact: true }).click();
  await page.getByRole('dialog', { name: '新建工程', exact: true }).waitFor({ state: 'hidden' });
  assert.equal(await page.getByTestId('project-name').innerText(), name);
}
async function installAudioObserver() {
  await page.evaluate(
    (sampleRate) => {
      const Base = window.AudioContext;
      window.__audioContexts = [];
      window.__audioAnalysers = [];
      window.__audioStarts = [];
      window.AudioContext = class extends Base {
        constructor(...args) {
          super({ ...args[0], ...(sampleRate ? { sampleRate } : {}) });
          window.__audioContexts.push(this);
        }
        async decodeAudioData(...args) {
          const buffer = await super.decodeAudioData(...args);
          window.__decodedAudio = {
            frames: buffer.length,
            sampleRate: buffer.sampleRate,
            durationUs: Math.round(buffer.duration * 1_000_000),
          };
          return buffer;
        }
        createGain() {
          const node = super.createGain(),
            context = this,
            connect = node.connect.bind(node);
          node.connect = function (destination, ...args) {
            if (destination === context.destination) {
              const analyser = context.createAnalyser();
              analyser.fftSize = 2048;
              analyser.connect(destination);
              window.__audioAnalysers.push(analyser);
              return connect(analyser, ...args);
            }
            return connect(destination, ...args);
          };
          return node;
        }
        createBufferSource() {
          const source = super.createBufferSource(),
            start = source.start.bind(source),
            context = this;
          source.start = (when = 0, offset = 0, ...args) => {
            window.__audioStarts.push({ when, offset, context });
            return start(when, offset, ...args);
          };
          return source;
        }
      };
    },
    Number(process.env.RHYTHM_TEST_SAMPLE_RATE) || undefined,
  );
}
async function audioEvidence() {
  return page.evaluate(() => {
    const source = window.__audioStarts.at(-1),
      analyser = window.__audioAnalysers[0];
    const samples = new Float32Array(2048);
    analyser?.getFloatTimeDomainData(samples);
    const rms = Math.sqrt(
      samples.reduce((sum, sample) => sum + sample * sample, 0) / samples.length,
    );
    if (!source) return { rms, expectedUs: 0 };
    const stamp = source.context.getOutputTimestamp();
    const seconds =
      stamp.performanceTime > 0
        ? Math.min(
            source.context.currentTime,
            stamp.contextTime + Math.max(0, performance.now() - stamp.performanceTime) / 1000,
          )
        : source.context.currentTime;
    return {
      rms,
      expectedUs: Math.round((source.offset + Math.max(0, seconds - source.when)) * 1000000),
      contextState: source.context.state,
      starts: window.__audioStarts.length,
    };
  });
}

try {
  const start = performance.now();
  application = await electron.launch({
    args: [root],
    cwd: root,
    env: environment,
    timeout: 60000,
  });
  page = await application.firstWindow();
  page.on('pageerror', (error) => report.consoleErrors.push(error.message));
  page.on('console', (entry) => {
    if (entry.type() === 'error') report.consoleErrors.push(entry.text());
    else if (entry.type() === 'warning') report.warnings.push(entry.text());
  });
  await check('Windows 真实 Electron 窗口启动，五区面板和 PixiJS 画布可见', async () => {
    await page.getByTestId('pixi-canvas').waitFor({ state: 'visible', timeout: 30000 });
    for (const label of ['图层与素材', '中央画布', '属性', '时间轴'])
      assert.equal(await page.getByLabel(label, { exact: true }).isVisible(), true);
    await page.getByRole('status').filter({ hasText: '新工程已准备好' }).waitFor();
    const canvas = await page
      .getByTestId('pixi-canvas')
      .evaluate((element) => ({ width: element.width, height: element.height }));
    assert.ok(canvas.width > 0 && canvas.height > 0 && canvas.width < 6000 && canvas.height < 6000);
    const isolation = await page.evaluate(() => ({
      node: typeof window.require,
      process: typeof window.process,
      api: typeof window.desktop,
    }));
    assert.deepEqual(isolation, { node: 'undefined', process: 'undefined', api: 'object' });
    report.measurements.startupMs = Math.round(performance.now() - start);
    return { canvas, isolation };
  });
  await installAudioObserver();
  await check('最小窗口尺寸下各面板仍可操作', async () => {
    await application.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0].setSize(1080, 720),
    );
    await page.waitForFunction(() => innerWidth <= 1080);
    const rectangle = await page.getByTestId('pixi-canvas').boundingBox();
    assert.ok(rectangle && rectangle.width > 200 && rectangle.height > 100);
    assert.equal(
      await page.getByRole('button', { name: '适合窗口', exact: true }).isVisible(),
      true,
    );
    assert.equal(await page.getByLabel('时间轴', { exact: true }).isVisible(), true);
    await application.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0].setSize(1440, 960),
    );
    await page.waitForFunction(() => innerWidth >= 1400);
  });
  await check('画布滚轮缩放和拖动平移', async () => {
    const host = page.getByTestId('canvas-host'),
      rectangle = await host.boundingBox();
    assert.ok(rectangle);
    const before = Number(await host.getAttribute('data-zoom'));
    await page.mouse.move(rectangle.x + rectangle.width / 2, rectangle.y + rectangle.height / 2);
    await page.mouse.wheel(0, -400);
    await page.waitForFunction(
      (value) =>
        Number(document.querySelector('[data-testid=canvas-host]').getAttribute('data-zoom')) >
        value,
      before,
    );
    const oldPan = Number(await host.getAttribute('data-pan-x'));
    await page.mouse.down();
    await page.mouse.move(
      rectangle.x + rectangle.width / 2 + 90,
      rectangle.y + rectangle.height / 2 + 40,
      { steps: 10 },
    );
    await page.mouse.up();
    assert.ok(Math.abs(Number(await host.getAttribute('data-pan-x')) - oldPan - 90) < 3);
    await page.getByRole('button', { name: '适合窗口', exact: true }).click();
    return { beforeZoom: before, fittedZoom: Number(await host.getAttribute('data-zoom')) };
  });
  await check('创建工程、编辑 BPM/画板、撤销重做、输出尺寸独立', async () => {
    await createDocument('阶段1 验收工程');
    const width = page.getByLabel('画板宽度', { exact: true });
    await width.fill('8000');
    await width.press('Tab');
    assert.equal(await width.inputValue(), '8000');
    assert.equal(await page.getByLabel('输出宽度', { exact: true }).inputValue(), '1920');
    await page.getByRole('button', { name: '撤销', exact: true }).click();
    assert.equal(await width.inputValue(), '6000');
    await page.getByRole('button', { name: '重做', exact: true }).click();
    assert.equal(await width.inputValue(), '8000');
    await page.getByRole('button', { name: '撤销', exact: true }).click();
    const bpm = page.getByLabel('BPM', { exact: true });
    await bpm.fill('137');
    await bpm.press('Tab');
    await page.getByRole('button', { name: '撤销', exact: true }).click();
    assert.equal(await bpm.inputValue(), '120');
    await page.getByRole('button', { name: '重做', exact: true }).click();
    assert.equal(await bpm.inputValue(), '137');
  });
  await check('WAV、MP3、OGG 实际解码与波形显示', async () => {
    const decoded = [];
    for (const file of [mp3, ogg, wav]) {
      await chooseOpen(file);
      await page.getByRole('button', { name: '导入音乐', exact: true }).first().click();
      await page
        .getByRole('status')
        .filter({ hasText: `已导入 ${path.basename(file)}` })
        .waitFor();
      await page.locator('[data-testid=waveform][data-ready=true]').waitFor({ timeout: 30000 });
      assert.equal(await page.getByRole('button', { name: '播放', exact: true }).isEnabled(), true);
      const audio = await page.evaluate(() => window.__decodedAudio);
      const expectedSeconds = file === wav ? 18 : 4;
      // Resampling from 48 kHz to the output device rate can truncate one sample.
      assert.ok(
        Math.abs(audio.frames - expectedSeconds * audio.sampleRate) <= 1,
        `${path.basename(file)}: unexpected decoded length ${JSON.stringify(audio)}`,
      );
      const display = (await page.locator('.duration-display').innerText()).trim();
      const parts = /^\/ (\d+):(\d{2})\.(\d{3})$/.exec(display);
      assert.ok(parts, `Invalid duration display: ${display}`);
      const displayedMs = Number(parts[1]) * 60000 + Number(parts[2]) * 1000 + Number(parts[3]);
      assert.equal(displayedMs, Math.floor(audio.durationUs / 1000));
      importedMusic.set(file, { ...audio, display });
      decoded.push({ format: path.extname(file), ...audio, display });
    }
    return { decoded };
  });
  await check('撤销和重做音乐导入会切换实际音频与波形', async () => {
    await page.getByRole('button', { name: '撤销', exact: true }).click();
    await page.locator('.editor-shell[aria-busy=false]').waitFor();
    await page.locator('[data-testid=waveform][data-ready=true]').waitFor();
    assert.equal(
      (await page.locator('.duration-display').innerText()).trim(),
      importedMusic.get(ogg).display,
    );
    await page.getByRole('button', { name: '重做', exact: true }).click();
    await page.locator('.editor-shell[aria-busy=false]').waitFor();
    await page.locator('[data-testid=waveform][data-ready=true]').waitFor();
    assert.equal(
      (await page.locator('.duration-display').innerText()).trim(),
      importedMusic.get(wav).display,
    );
  });
  await check('真实 Web Audio 播放、有声信号及统一时间轴同步', async () => {
    await page.getByRole('button', { name: '播放', exact: true }).click();
    await waitTime(1000000);
    const evidence = await audioEvidence(),
      head = await timeUs();
    assert.ok(evidence.rms > 0.001, `No output signal: ${evidence.rms}`);
    const errorUs = Math.abs(evidence.expectedUs - head);
    assert.ok(errorUs < 100000, `Cursor/audio difference ${errorUs}us`);
    report.measurements.cursorAudioDifferenceUs = errorUs;
    await page.getByRole('button', { name: '暂停', exact: true }).click();
    return { ...evidence, headUs: head, cursorAudioDifferenceUs: errorUs };
  });
  await check('暂停冻结位置并停止音频信号', async () => {
    const held = await timeUs();
    await page.waitForTimeout(450);
    assert.equal(await timeUs(), held);
    const evidence = await audioEvidence();
    assert.ok(evidence.rms < 0.0001, `Signal persists after pause: ${evidence.rms}`);
    return { frozenAtUs: held, rms: evidence.rms };
  });
  await check('定位后从指定音乐位置继续，时间轴节拍吸附可用', async () => {
    await jump(7.25);
    assert.ok(Math.abs((await timeUs()) - 7250000) < 1000);
    await page.getByRole('button', { name: '播放', exact: true }).click();
    await waitTime(7500000);
    const evidence = await audioEvidence();
    assert.ok(evidence.expectedUs > 7500000);
    await page.getByRole('button', { name: '暂停', exact: true }).click();
    const scroller = await page.getByTestId('timeline-scroll').boundingBox();
    assert.ok(scroller);
    await page.mouse.click(scroller.x + 5 * 44, scroller.y + 12);
    const expected = Math.round(Math.round(5 / (60 / 137 / 4)) * (60 / 137 / 4) * 1000000);
    assert.ok(Math.abs((await timeUs()) - expected) <= 1);
    return { snappedUs: await timeUs(), expectedUs: expected };
  });
  await check('保存工程和原始音乐，另存为后可脱离来源打开', async () => {
    await chooseSave(projectFile);
    await page.getByRole('button', { name: '保存', exact: true }).click();
    await page.getByRole('status').filter({ hasText: '工程和素材已保存' }).waitFor();
    const document = JSON.parse(await fs.readFile(projectFile, 'utf8'));
    const asset = document.assets[document.music.assetId];
    const copied = await fs.readFile(path.join(path.dirname(projectFile), asset.relativePath));
    assert.equal(createHash('sha256').update(copied).digest('hex'), asset.sha256);
    assert.equal(document.timing.points[0].bpm, 137);
    assert.equal(document.stage.artworkSize.width, 6000);
    assert.equal(JSON.stringify(document).includes('AudioBuffer'), false);
    const portable = path.join(results, '独立工程目录', 'copy.rcproj');
    await chooseSave(portable);
    await page.getByRole('button', { name: '另存为', exact: true }).click();
    await page.getByRole('status').filter({ hasText: '工程和素材已保存' }).waitFor();
    await fs.rename(wav, wav + '.moved');
    await createDocument('另一份工程');
    await chooseOpen(portable);
    await page.getByRole('button', { name: '打开', exact: true }).click();
    await page.locator('[data-testid=waveform][data-ready=true]').waitFor();
    assert.equal(await page.getByTestId('project-name').innerText(), '阶段1 验收工程');
    assert.equal(await page.getByLabel('BPM', { exact: true }).inputValue(), '137');
    assert.equal(await timeUs(), 0);
    await fs.rename(wav + '.moved', wav);
    return { portableProject: portable, originalMusicBytesPreserved: true };
  });
  await check('损坏音乐与不支持工程格式不会替换当前有效工程', async () => {
    const beforeName = await page.getByTestId('project-name').innerText();
    await chooseOpen(badMusic);
    await page.getByRole('button', { name: '导入音乐', exact: true }).first().click();
    await page.getByRole('status').filter({ hasText: '无法解码' }).waitFor();
    assert.equal(await page.getByRole('button', { name: '播放', exact: true }).isEnabled(), true);
    assert.equal(await page.locator('[data-testid=waveform][data-ready=true]').count(), 1);
    await chooseOpen(badProject);
    await page.getByRole('button', { name: '打开', exact: true }).click();
    await page.getByRole('status').filter({ hasText: '数据格式' }).waitFor();
    assert.equal(await page.getByTestId('project-name').innerText(), beforeName);
  });
  await check('音乐结尾停止，重复播放重新从开头开始', async () => {
    await jump(17.7);
    await page.getByRole('button', { name: '播放', exact: true }).click();
    await page.getByRole('button', { name: '播放', exact: true }).waitFor({ timeout: 5000 });
    assert.ok(Math.abs((await timeUs()) - importedMusic.get(wav).durationUs) <= 1);
    await page.getByRole('button', { name: '播放', exact: true }).click();
    await page.getByRole('button', { name: '暂停', exact: true }).waitFor();
    await page.waitForTimeout(300);
    assert.ok((await timeUs()) < 2000000);
    await page.getByRole('button', { name: '暂停', exact: true }).click();
  });
  await check('取消文件选择与未保存提示保留当前工程', async () => {
    const beforeName = await page.getByTestId('project-name').innerText();
    await application.evaluate(({ dialog }) => {
      dialog.showOpenDialog = async () => ({ canceled: true, filePaths: [] });
      dialog.showSaveDialog = async () => ({ canceled: true, filePath: undefined });
    });
    await page.getByRole('button', { name: '打开', exact: true }).click();
    await page.locator('.editor-shell[aria-busy=false]').waitFor();
    await page.getByRole('button', { name: '另存为', exact: true }).click();
    await page.locator('.editor-shell[aria-busy=false]').waitFor();
    assert.equal(await page.getByTestId('project-name').innerText(), beforeName);
    const name = page.getByLabel('工程名称', { exact: true });
    await name.fill('未保存的临时修改');
    await name.press('Tab');
    await page.getByRole('button', { name: '打开', exact: true }).click();
    const prompt = page.getByRole('dialog', { name: '未保存的修改', exact: true });
    await prompt.getByRole('button', { name: '取消', exact: true }).click();
    await prompt.waitFor({ state: 'hidden' });
    assert.match(await page.getByTestId('project-name').innerText(), /未保存的临时修改/);
    await page.getByRole('button', { name: '撤销', exact: true }).click();
    await page.locator('.editor-shell[aria-busy=false]').waitFor();
    assert.equal(await page.getByTestId('project-name').innerText(), beforeName);
  });
  await check('性能记录包含进程、画布、帧时间和资源核算', async () => {
    const performanceFile = path.join(results, 'performance.json');
    await chooseSave(performanceFile);
    await page.getByRole('button', { name: '查看运行记录', exact: true }).click();
    await page.getByRole('button', { name: '保存性能记录', exact: true }).click();
    await page.getByRole('status').filter({ hasText: '性能记录已保存' }).waitFor();
    const statistics = JSON.parse(await fs.readFile(performanceFile, 'utf8'));
    assert.ok(statistics.frames.samples > 0);
    assert.ok(statistics.processes.length > 0);
    assert.ok(statistics.graphics.capabilities.maxTextureSize > 0);
    assert.ok(statistics.resources.bytes['decoded-audio'] > 0);
    assert.ok(statistics.graphics.screenBuffer.width < 6000);
    report.measurements.performance = statistics;
    await page.getByRole('button', { name: '返回编辑', exact: true }).click();
  });
  await check('生成可重新打开的阶段 1 示例工程及实际窗口截图', async () => {
    const bpm = page.getByLabel('BPM', { exact: true });
    await bpm.fill('120');
    await page.waitForTimeout(350);
    assert.equal(await bpm.inputValue(), '120');
    await bpm.press('Tab');
    const name = page.getByLabel('工程名称', { exact: true });
    await name.fill('阶段 1 节拍练习');
    await name.press('Tab');
    await jump(3.5);
    const example = path.join(results, '示例工程', '节拍练习.rcproj');
    await chooseSave(example);
    await page.getByRole('button', { name: '另存为', exact: true }).click();
    await page.getByRole('status').filter({ hasText: '工程和素材已保存' }).waitFor();
    await page.screenshot({ path: path.join(results, 'editor.png') });
    const project = JSON.parse(await fs.readFile(example, 'utf8'));
    assert.equal(project.name, '阶段 1 节拍练习');
    assert.equal(project.timing.points[0].bpm, 120);
    return { example };
  });
  assert.deepEqual(report.consoleErrors, [], 'Renderer reported errors');
  report.passed = true;
} catch (error) {
  report.passed = false;
  report.error = error?.stack ?? String(error);
  if (page && !page.isClosed())
    await page.screenshot({ path: path.join(results, 'failure.png') }).catch(() => {});
  console.error(report.error);
  process.exitCode = 1;
} finally {
  report.finishedAt = new Date().toISOString();
  await fs.writeFile(path.join(results, 'report.json'), JSON.stringify(report, null, 2));
  if (application) {
    // This profile contains generated test data only. Prevent a native dirty-document prompt from hanging cleanup.
    await application
      .evaluate(({ dialog }) => {
        dialog.showMessageBox = async () => ({ response: 1, checkboxChecked: false });
      })
      .catch(() => {});
    await application.close().catch(() => {});
  }
  if (report.passed) await fs.unlink(path.join(results, 'failure.png')).catch(() => {});
  const profile = path.resolve(environment.RHYTHM_USER_DATA);
  if (
    path.dirname(profile) === path.resolve(results) &&
    /^profile-\d+$/.test(path.basename(profile))
  ) {
    await fs
      .rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
      .catch(() => {});
  }
  console.log(
    `E2E ${report.passed ? 'PASSED' : 'FAILED'}: ${report.checks.filter((item) => item.passed).length}/${report.checks.length}`,
  );
}
