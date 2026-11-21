import { _electron as electron } from 'playwright';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync, spawn } from 'node:child_process';
import { smallFixtures } from './image-fixtures.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const directory = path.join(root, 'test-results', 'recovery');
const fixtures = await smallFixtures(path.join(directory, 'fixtures'));
const profile = path.join(directory, `profile-${Date.now()}`);
const env = { ...process.env, RHYTHM_USER_DATA: profile };
delete env.ELECTRON_RUN_AS_NODE;
delete env.ELECTRON_RENDERER_URL;
const recording = process.argv.includes('--record');
const realPSD = process.argv.find((arg) => arg.startsWith('--psd='))?.slice(6);
const official = path.join(directory, '正式工程', '恢复验收.rcproj');
const report = {
  startedAt: new Date().toISOString(),
  checks: [],
  errors: [],
  profile,
  realPSD,
  limitations: [
    'Real Electron windows and input; native file-picker replies are substituted.',
    'Forced process termination is tested; hardware power loss is not simulated.',
    'Audio decoding and playback starts are verified, not physical speaker output.',
  ],
};
let app, page, capture;
const frames = [],
  writes = [];
const frameFolder = path.join(directory, `frames-${Date.now()}`);
if (recording) await fs.mkdir(frameFolder);
function wav() {
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
    bytes.writeInt16LE(Math.round(Math.sin((i * Math.PI * 440) / rate) * 3000), 44 + i * 2);
  return bytes;
}
const music = path.join(directory, 'fixtures', '音乐.wav'),
  sound = path.join(directory, 'fixtures', '音效.wav');
await fs.writeFile(music, wav());
await fs.writeFile(sound, wav());
async function check(name, action) {
  const start = Date.now();
  try {
    const evidence = await action();
    report.checks.push({ name, passed: true, elapsedMs: Date.now() - start, evidence });
    console.log('PASS ' + name);
  } catch (error) {
    report.checks.push({ name, passed: false, error: String(error) });
    throw error;
  } finally {
    await fs.writeFile(path.join(directory, 'report.json'), JSON.stringify(report, null, 2));
  }
}
async function start() {
  app = await electron.launch({ args: [root], cwd: root, env });
  page = await app.firstWindow();
  page.on('pageerror', (error) => report.errors.push(String(error)));
  await page.getByTestId('pixi-canvas').waitFor();
  await settled();
  await app.evaluate(({ BrowserWindow }) => {
    const w = BrowserWindow.getAllWindows()[0];
    w.show();
    w.focus();
  });
  await page.bringToFront();
  if (recording) {
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
      everyNthFrame: 2,
    });
  }
}
async function stopCapture() {
  if (capture) await capture.send('Page.stopScreencast').catch(() => {});
  capture = null;
}
async function crash() {
  await stopCapture();
  const pid = app.process().pid;
  const exited = new Promise((resolve) => app.process().once('exit', resolve));
  execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'pipe' });
  await exited;
  await app.close().catch(() => {});
  app = null;
}
async function settled() {
  await page.locator('.editor-shell[aria-busy=false]').waitFor({ timeout: 120000 });
}
async function textures() {
  await settled();
  await page.waitForFunction(
    () => Number(document.querySelector('[data-testid=canvas-host]')?.dataset.loading) === 0,
  );
  await page.waitForTimeout(180);
}
async function choose(file, save = false) {
  await app.evaluate(
    ({ dialog }, { file, save }) => {
      if (save) dialog.showSaveDialog = async () => ({ canceled: !file, filePath: file });
      else dialog.showOpenDialog = async () => ({ canceled: !file, filePaths: file ? [file] : [] });
    },
    { file, save },
  );
}
async function property(label, value) {
  const field = page.getByLabel(label, { exact: true });
  await field.focus();
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => resolve())));
  await field.fill(String(value));
  await field.press('Tab');
  assert.equal(
    Number(await field.inputValue()),
    Number(value),
    `${label} must commit before snapshot checks`,
  );
}
async function importPicture(file) {
  await choose(file);
  await page.getByRole('button', { name: '＋ 导入 PSD / PNG', exact: true }).click();
  await settled();
  const close = page.getByRole('button', { name: '关闭兼容提示', exact: true });
  if (await close.isVisible()) await close.click();
  await textures();
}
async function entries() {
  return page.evaluate(async () => {
    const r = await window.desktop.listRecoveries();
    if (!r.ok) throw Error(r.error);
    return r.value.entries;
  });
}
async function snapshotAfter(version = -1) {
  const until = Date.now() + 45000;
  while (Date.now() < until) {
    const latest = (await entries()).find((e) => e.version > version);
    if (latest) return latest;
    await page.waitForTimeout(300);
  }
  throw Error('No new periodic snapshot');
}
async function restore() {
  const dialog = page.getByRole('dialog', { name: '恢复未保存工程' });
  await dialog.waitFor();
  await dialog.getByRole('button', { name: '恢复工程', exact: true }).first().click();
  await dialog.waitFor({ state: 'hidden', timeout: 120000 });
  const close = page.getByRole('button', { name: '关闭兼容提示', exact: true });
  if (await close.isVisible()) await close.click();
  await textures();
  assert.equal((await page.locator('.save-state').innerText()).trim(), '未保存修改');
}
async function requestClose() {
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close());
  await page.getByRole('dialog', { name: '未保存的修改' }).waitFor();
}
async function save() {
  await choose(official, true);
  await page.getByRole('button', { name: '保存', exact: true }).click();
  await settled();
  assert.equal((await page.locator('.save-state').innerText()).trim(), '已保存');
  return JSON.parse(await fs.readFile(official, 'utf8'));
}
let first, originalProject, savedText;
try {
  await start();
  await check(
    'unnamed PNG, PSD, music and sound edits produce a dated complete recovery snapshot',
    async () => {
      await importPicture(fixtures.png);
      await importPicture(realPSD ?? fixtures.psd);
      await choose(music);
      await page.getByRole('button', { name: '导入音乐', exact: false }).first().click();
      await settled();
      await choose(sound);
      await page.getByRole('button', { name: '＋ 音效', exact: true }).click();
      await settled();
      await property('BPM', 137);
      first = await snapshotAfter();
      // An earlier tick during import may precede the final edit.
      while (true) {
        originalProject = JSON.parse(
          await fs.readFile(
            path.join(profile, 'recoveries', first.id, first.token, 'project.rcproj'),
            'utf8',
          ),
        );
        if (originalProject.timing.points[0].bpm === 137) break;
        first = await snapshotAfter(first.version);
      }
      assert.equal(first.filePath, null);
      const kinds = Object.values(originalProject.assets).map((a) => a.kind);
      assert(
        kinds.includes('psd') &&
          kinds.includes('png') &&
          kinds.filter((k) => k === 'audio').length === 2,
      );
      assert(Object.values(originalProject.pixelSources).length > 0);
      await page.screenshot({ path: path.join(directory, '01-before-crash.png') });
      return {
        savedAt: first.savedAt,
        assets: kinds.length,
        layers: Object.keys(originalProject.layers).length,
      };
    },
  );
  await check(
    'forced process termination, later choice and another restart preserve recovery',
    async () => {
      await crash();
      await start();
      const dialog = page.getByRole('dialog', { name: '恢复未保存工程' });
      await dialog.waitFor();
      await dialog.getByRole('button', { name: '暂不处理' }).focus();
      await page.keyboard.press('Tab');
      assert.equal(await page.locator('.editor-shell').getAttribute('data-canvas-focus'), 'false');
      assert.ok(await dialog.isVisible(), 'Tab must not dismiss or hide the recovery prompt');
      assert(
        (await dialog.innerText()).includes(
          new Date(first.savedAt).toLocaleDateString('zh-CN').slice(0, 4),
        ),
      );
      await page.screenshot({ path: path.join(directory, '02-recovery-prompt.png') });
      await dialog.getByRole('button', { name: '暂不处理' }).click();
      assert.equal((await entries())[0].token, first.token);
      await crash();
      await start();
      await restore();
      assert.equal(await page.getByLabel('BPM', { exact: true }).inputValue(), '137');
    },
  );
  await check(
    'restored assets hash correctly, music and SFX decode/play, and another crash remains recoverable',
    async () => {
      const handles = (await fs.readdir(path.join(profile, 'import-sessions'))).filter((name) =>
        /^[0-9a-f-]{36}$/.test(name),
      );
      assert.equal(handles.length, 1);
      for (const asset of Object.values(originalProject.assets)) {
        const hash = await page.evaluate(
          async ({ handle, assetId }) => {
            const result = await window.desktop.readAsset({ handle, assetId });
            if (!result.ok) throw Error(result.error);
            const digest = await crypto.subtle.digest('SHA-256', result.value);
            return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
          },
          { handle: handles[0], assetId: asset.id },
        );
        assert.equal(hash, asset.sha256);
      }
      await page.locator('[data-testid=waveform][data-ready=true]').waitFor();
      await page.evaluate(() => {
        window.playedBuffers = [];
        const original = AudioBufferSourceNode.prototype.start;
        AudioBufferSourceNode.prototype.start = function (...args) {
          window.playedBuffers.push(this.buffer?.duration);
          return original.apply(this, args);
        };
      });
      await page.getByRole('button', { name: '播放', exact: true }).click();
      await page.waitForTimeout(650);
      await page.getByRole('button', { name: '暂停', exact: true }).click();
      await page.getByRole('button', { name: /^试听音效 / }).click();
      await page.waitForFunction(() => window.playedBuffers.length >= 2);
      assert((await page.evaluate(() => window.playedBuffers)).every((duration) => duration > 5));
      await page.screenshot({ path: path.join(directory, '03-restored-materials.png') });
      await crash();
      await start();
      await restore();
      assert.equal((await entries())[0].token, first.token);
      const project = await save();
      assert.deepEqual(project, originalProject);
      assert.deepEqual(await entries(), []);
      savedText = await fs.readFile(official, 'utf8');
    },
  );
  await check(
    'saved project recovery contains unsaved edits and leaves the official file unchanged',
    async () => {
      await property('BPM', 141);
      first = await snapshotAfter();
      assert.equal(await fs.readFile(official, 'utf8'), savedText);
      await crash();
      await start();
      await restore();
      assert.equal(await page.getByLabel('BPM', { exact: true }).inputValue(), '141');
      assert.equal(await fs.readFile(official, 'utf8'), savedText);
    },
  );
  await check(
    'cancel close and failed save-and-exit keep the same dirty editor and recovery',
    async () => {
      await requestClose();
      await page
        .getByRole('dialog', { name: '未保存的修改' })
        .getByRole('button', { name: '取消', exact: true })
        .click();
      await settled();
      // A genuine filesystem replacement failure, injected at rename instead of faking a save reply.
      await app.evaluate(async () => {
        const fs = process.getBuiltinModule('fs').promises;
        const rename = fs.rename.bind(fs);
        globalThis.restoreRename = () => {
          fs.rename = rename;
        };
        fs.rename = async (from, to) => {
          if (String(to).endsWith('.rcproj')) throw Error('验收：目标文件被占用');
          return rename(from, to);
        };
      });
      await requestClose();
      await page.getByRole('button', { name: '保存并退出', exact: true }).click();
      await settled();
      assert.equal(page.isClosed(), false);
      assert((await page.locator('.status-message').innerText()).includes('目标文件被占用'));
      assert.equal(await fs.readFile(official, 'utf8'), savedText);
      assert.equal((await entries())[0].token, first.token);
      await page.screenshot({ path: path.join(directory, '04-save-failure.png') });
      await app.evaluate(() => globalThis.restoreRename());
    },
  );
  await check(
    'save-and-exit writes edits, closes only after success and reopens with assets',
    async () => {
      await requestClose();
      await page.screenshot({ path: path.join(directory, '05-save-exit.png') });
      await stopCapture();
      const closed = app.waitForEvent('close');
      await page.getByRole('button', { name: '保存并退出', exact: true }).click();
      await closed;
      app = null;
      assert.equal(JSON.parse(await fs.readFile(official, 'utf8')).timing.points[0].bpm, 141);
      await start();
      assert.deepEqual(await entries(), []);
      await choose(official);
      await page.getByRole('button', { name: '打开', exact: true }).click();
      await textures();
      await page.locator('[data-testid=waveform][data-ready=true]').waitFor();
      assert.equal(await page.getByLabel('BPM', { exact: true }).inputValue(), '141');
    },
  );
  await check(
    'switching to a new project and canceling its first save path retain edits and snapshot',
    async () => {
      await page.getByRole('button', { name: '新建', exact: true }).click();
      await page.getByLabel('新工程名称').fill('取消路径验收');
      await page.getByRole('button', { name: '创建工程', exact: true }).click();
      await settled();
      await property('BPM', 149);
      first = await snapshotAfter();
      await choose(null, true);
      await requestClose();
      await page.getByRole('button', { name: '保存并退出', exact: true }).click();
      await settled();
      assert.equal(page.isClosed(), false);
      assert.equal(await page.getByLabel('BPM', { exact: true }).inputValue(), '149');
      assert.equal((await entries())[0].token, first.token);
      await page.screenshot({ path: path.join(directory, '06-cancel-save-path.png') });
    },
  );
  await check(
    'interrupted snapshot write leaves the previous full version recoverable',
    async () => {
      await app.evaluate(async () => {
        const fs = process.getBuiltinModule('fs').promises;
        const rename = fs.rename.bind(fs);
        fs.rename = async (from, to) => {
          if (String(to).endsWith('current.json')) {
            globalThis.snapshotBlocked = true;
            await new Promise(() => {});
          }
          return rename(from, to);
        };
      });
      await property('BPM', 157);
      const until = Date.now() + 45000;
      while (!(await app.evaluate(() => Boolean(globalThis.snapshotBlocked)))) {
        if (Date.now() > until) throw Error('Snapshot never reached pointer commit');
        await page.waitForTimeout(300);
      }
      await crash();
      await start();
      await restore();
      assert.equal(await page.getByLabel('BPM', { exact: true }).inputValue(), '149');
    },
  );
  await check('explicit discard-and-exit removes only that recovery', async () => {
    await requestClose();
    await stopCapture();
    const closed = app.waitForEvent('close');
    await page.getByRole('button', { name: '不保存并退出', exact: true }).click();
    await closed;
    app = null;
    await start();
    assert.deepEqual(await entries(), []);
    assert.equal(await page.getByRole('dialog', { name: '恢复未保存工程' }).count(), 0);
  });
  await check('relaunching the same profile returns to the existing window', async () => {
    const second = spawn(app.process().spawnfile, [root], {
      cwd: root,
      env,
      windowsHide: true,
      stdio: 'ignore',
    });
    const code = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        second.kill();
        reject(Error('Second instance did not exit'));
      }, 10000);
      second.once('exit', (code) => {
        clearTimeout(timer);
        resolve(code);
      });
      second.once('error', reject);
    });
    assert.equal(code, 0);
    assert.equal(
      await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length),
      1,
    );
    assert.equal(page.isClosed(), false);
  });
  await check('snapshot errors are visible and retain the last full snapshot', async () => {
    await property('BPM', 160);
    first = await snapshotAfter();
    await app.evaluate(() => {
      const fs = process.getBuiltinModule('fs').promises,
        rename = fs.rename.bind(fs);
      globalThis.restoreSnapshotIO = () => {
        fs.rename = rename;
      };
      fs.rename = async (from, to) => {
        if (String(to).endsWith('current.json')) throw Error('验收：恢复目录空间不足');
        return rename(from, to);
      };
    });
    await property('BPM', 161);
    await page
      .getByTestId('recovery-state')
      .filter({ hasText: '恢复快照写入失败' })
      .waitFor({ timeout: 45000 });
    assert.equal((await entries())[0].token, first.token);
    await app.evaluate(() => globalThis.restoreSnapshotIO());
  });
  await check(
    'queued image import can be cancelled while snapshot writing is pending',
    async () => {
      await app.evaluate(() => {
        const fs = process.getBuiltinModule('fs').promises,
          rename = fs.rename.bind(fs);
        fs.rename = async (from, to) => {
          if (String(to).endsWith('current.json')) {
            globalThis.snapshotQueued = true;
            await new Promise((resolve) => {
              globalThis.releaseSnapshot = resolve;
            });
            fs.rename = rename;
          }
          return rename(from, to);
        };
      });
      const until = Date.now() + 45000;
      while (!(await app.evaluate(() => Boolean(globalThis.snapshotQueued)))) {
        if (Date.now() > until) throw Error('No queued snapshot');
        await page.waitForTimeout(300);
      }
      await choose(fixtures.psd);
      await page.getByRole('button', { name: '＋ 导入 PSD / PNG', exact: true }).click();
      await page.getByRole('button', { name: '取消导入', exact: true }).click();
      await app.evaluate(() => globalThis.releaseSnapshot());
      await settled();
      assert((await page.locator('.status-message').innerText()).includes('已取消图片导入'));
      assert.equal(await page.locator('.layer-row').count(), 0);
    },
  );
  await check('explicit startup discard removes recovery without opening it', async () => {
    await crash();
    await start();
    await page
      .getByRole('dialog', { name: '恢复未保存工程' })
      .getByRole('button', { name: '丢弃此快照' })
      .click();
    await settled();
    assert.deepEqual(await entries(), []);
    assert.equal((await page.locator('.save-state').innerText()).trim(), '新工程');
  });
  assert.deepEqual(report.errors, []);
} finally {
  await stopCapture();
  if (app) {
    await app.evaluate(({ app }) => app.exit(0)).catch(() => {});
    await app.close().catch(() => {});
  }
  if (recording && frames.length) {
    await Promise.all(writes);
    const lines = ['ffconcat version 1.0'];
    for (let i = 0; i < frames.length; i++) {
      lines.push(
        `file '${frames[i].file}'`,
        `duration ${Math.max(0.001, (frames[i + 1]?.time ?? Date.now() / 1000) - frames[i].time)}`,
      );
    }
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
        path.join(directory, 'recovery-acceptance.mp4'),
      ],
      { windowsHide: true },
    );
    if (path.dirname(frameFolder) === directory && path.basename(frameFolder).startsWith('frames-'))
      await fs.rm(frameFolder, { recursive: true });
  }
  report.finishedAt = new Date().toISOString();
  await fs.writeFile(path.join(directory, 'report.json'), JSON.stringify(report, null, 2));
}
