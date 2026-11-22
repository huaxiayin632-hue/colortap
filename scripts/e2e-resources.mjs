import { _electron as electron } from 'playwright';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Targeted 2b observation on the same real PSD, with no speed/FPS pass threshold.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const label = process.argv.find((a) => a.startsWith('--label='))?.slice(8) ?? 'candidate-final';
const directory = path.join(root, 'test-results', 'resources', label);
const psd = process.env.RHYTHM_TEST_PSD ?? 'C:/Users/00/Pictures/练习/插画64.psd';
await fs.mkdir(directory, { recursive: true });
const profile = path.join(directory, `profile-${Date.now()}`);
const env = { ...process.env, RHYTHM_USER_DATA: profile };
delete env.ELECTRON_RUN_AS_NODE;
delete env.ELECTRON_RENDERER_URL;
const report = { label, psd, startedAt: new Date().toISOString(), observations: [], errors: [] };
let app, page;
const choose = (file, save = false) =>
  app.evaluate(
    ({ dialog }, { file, save }) => {
      if (save) dialog.showSaveDialog = async () => ({ canceled: false, filePath: file });
      else dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] });
    },
    { file, save },
  );
async function ready() {
  await page.locator('.editor-shell[aria-busy=false]').waitFor();
  await page.waitForFunction(
    () => document.querySelector('[data-testid=canvas-host]')?.dataset.loading === '0',
  );
  await page.waitForTimeout(250);
}
async function metrics(name) {
  const file = path.join(directory, `${name}.json`);
  await choose(file, true);
  await page.getByRole('button', { name: '查看运行记录', exact: true }).click();
  await page.getByRole('button', { name: '保存性能记录', exact: true }).click();
  await ready();
  await page.getByRole('button', { name: '关闭运行记录', exact: true }).click();
  return JSON.parse(await fs.readFile(file, 'utf8'));
}
async function observe(name, action) {
  const before = await app.evaluate(() => ({ ...globalThis.resourceProbe.io }));
  const started = performance.now();
  await action();
  await ready();
  await page.waitForTimeout(250);
  await ready();
  const elapsedMs = performance.now() - started;
  const after = await app.evaluate(() => ({ ...globalThis.resourceProbe.io }));
  const io = Object.fromEntries(Object.entries(after).map(([k, v]) => [k, v - before[k]]));
  const record = await metrics(name);
  report.observations.push({ name, elapsedMs, io, graphics: record.graphics });
  console.log(JSON.stringify({ name, elapsedMs, io, textures: record.graphics.layers }));
  await fs.writeFile(path.join(directory, 'report.json'), JSON.stringify(report, null, 2));
}
try {
  app = await electron.launch({ args: [root], cwd: root, env });
  page = await app.firstWindow();
  page.setDefaultTimeout(180000);
  page.on('pageerror', (e) => report.errors.push(String(e)));
  await page.getByTestId('pixi-canvas').waitFor();
  await app.evaluate(async ({ BrowserWindow, ipcMain }) => {
    BrowserWindow.getAllWindows()[0].setSize(1600, 1000);
    const fs = process.getBuiltinModule('fs');
    const crypto = process.getBuiltinModule('crypto');
    const mod = process.getBuiltinModule('module');
    const io = {
      hashCalls: 0,
      hashBytes: 0,
      hashCpuMs: 0,
      reads: 0,
      readBytes: 0,
      readMs: 0,
      copies: 0,
      copyBytes: 0,
      copyMs: 0,
      realpaths: 0,
    };
    const probe = (globalThis.resourceProbe = { io, operations: [] });
    const createHash = crypto.createHash;
    crypto.createHash = (...args) => {
      io.hashCalls++;
      const hash = createHash(...args),
        update = hash.update.bind(hash),
        digest = hash.digest.bind(hash);
      hash.update = (chunk, ...rest) => {
        io.hashBytes += chunk.length;
        const start = performance.now();
        const value = update(chunk, ...rest);
        io.hashCpuMs += performance.now() - start;
        return value;
      };
      hash.digest = (...args) => {
        const start = performance.now(),
          value = digest(...args);
        io.hashCpuMs += performance.now() - start;
        return value;
      };
      return hash;
    };
    for (const method of ['readFile', 'copyFile', 'realpath']) {
      const original = fs.promises[method].bind(fs.promises);
      fs.promises[method] = async (...args) => {
        const start = performance.now(),
          value = await original(...args);
        if (method === 'readFile') {
          io.reads++;
          io.readBytes += value.length;
          io.readMs += performance.now() - start;
        }
        if (method === 'copyFile') {
          const size = (await fs.promises.stat(args[1])).size;
          io.copies++;
          io.copyBytes += size;
          io.copyMs += performance.now() - start;
        }
        if (method === 'realpath') io.realpaths++;
        return value;
      };
    }
    mod.syncBuiltinESMExports();
    for (const channel of ['project:save', 'recovery:snapshot', 'asset:read']) {
      const original = ipcMain._invokeHandlers.get(channel);
      ipcMain.removeHandler(channel);
      ipcMain.handle(channel, async (...args) => {
        const before = { ...io },
          start = performance.now();
        const result = await original(...args);
        probe.operations.push({
          channel,
          elapsedMs: performance.now() - start,
          io: Object.fromEntries(Object.entries(io).map(([k, v]) => [k, v - before[k]])),
          ok: result.ok,
          value: channel === 'recovery:snapshot' ? result.value : undefined,
        });
        return result;
      });
    }
  });
  await page.evaluate(() => {
    const original = window.createImageBitmap;
    window.resourceDecode = { calls: 0, elapsedMs: 0 };
    window.createImageBitmap = async (...args) => {
      const start = performance.now();
      const result = await original(...args);
      window.resourceDecode.calls++;
      window.resourceDecode.elapsedMs += performance.now() - start;
      return result;
    };
  });
  await page.getByRole('button', { name: '新建', exact: true }).click();
  await page.getByLabel('新工程名称').fill('2b 真实大 PSD 验收');
  await page.getByLabel('新工程宽度').fill('6116');
  await page.getByLabel('新工程高度').fill('5488');
  await page.getByRole('button', { name: '创建工程', exact: true }).click();
  await ready();
  await observe('import-fit', async () => {
    await choose(psd);
    await page.getByRole('button', { name: '＋ 导入 PSD / PNG', exact: true }).click();
    await page
      .getByRole('dialog', { name: '图片导入进度', exact: true })
      .waitFor({ state: 'hidden' });
    const warnings = page.getByRole('dialog', { name: 'PSD 兼容提示', exact: true });
    if (await warnings.isVisible()) {
      report.importWarnings = await warnings.innerText();
      await page.getByRole('button', { name: '关闭兼容提示', exact: true }).click();
    }
  });
  for (let round = 0; round < 2; round++) {
    await observe(`zoom-${round}`, async () => {
      for (let i = 0; i < 5; i++)
        await page.getByRole('button', { name: '放大画布', exact: true }).click();
    });
    await observe(`pan-${round}`, async () => {
      const box = await page.getByTestId('pixi-canvas').boundingBox();
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      await page.mouse.down({ button: 'middle' });
      await page.mouse.move(box.x + box.width / 2 + 250, box.y + box.height / 2 + 100, {
        steps: 15,
      });
      await page.mouse.up({ button: 'middle' });
    });
    await observe(`fit-${round}`, () =>
      page.getByRole('button', { name: '适合窗口', exact: true }).click(),
    );
  }
  for (let round = 0; round < 2; round++) {
    await observe(`actual-${round}`, () =>
      page.getByRole('button', { name: '原尺寸', exact: true }).click(),
    );
    await observe(`return-${round}`, () =>
      page.getByRole('button', { name: '适合窗口', exact: true }).click(),
    );
  }
  await observe('idle-reclaim', () => page.waitForTimeout(2500));
  const file = path.join(directory, 'saved', '大PSD验收.rcproj');
  await observe('save-first', async () => {
    await choose(file, true);
    await page.getByRole('button', { name: '另存为', exact: true }).click();
  });
  await observe('save-repeat', () =>
    page.getByRole('button', { name: '保存', exact: true }).click(),
  );
  await observe('save-warm', () => page.getByRole('button', { name: '保存', exact: true }).click());
  assert.equal((await page.locator('.save-state').innerText()).trim(), '已保存');
  const saved = JSON.parse(await fs.readFile(file, 'utf8'));
  assert.equal(Object.keys(saved.layers).length, 108);
  for (const bpm of [137, 138]) {
    const count = await app.evaluate(
      () =>
        globalThis.resourceProbe.operations.filter((o) => o.channel === 'recovery:snapshot').length,
    );
    await page.getByLabel('BPM', { exact: true }).fill(String(bpm));
    await page.getByLabel('BPM', { exact: true }).press('Tab');
    const until = Date.now() + 60000;
    while (Date.now() < until) {
      const now = await app.evaluate(
        () =>
          globalThis.resourceProbe.operations.filter((o) => o.channel === 'recovery:snapshot')
            .length,
      );
      if (now > count) break;
      await page.waitForTimeout(500);
    }
    const snapshots = await app.evaluate(() =>
      globalThis.resourceProbe.operations.filter((o) => o.channel === 'recovery:snapshot'),
    );
    assert.ok(snapshots.length > count, 'snapshot completed');
    assert.equal(snapshots.at(-1).ok, true, 'snapshot succeeded');
    const entry = snapshots.at(-1).value;
    assert.ok(entry, 'snapshot contains a complete entry');
    const manifest = entry.sharedAssets
      ? path.join(profile, 'recoveries', entry.id, entry.token + '.rcproj')
      : path.join(profile, 'recoveries', entry.id, entry.token, 'project.rcproj');
    const snapshot = JSON.parse(await fs.readFile(manifest, 'utf8'));
    assert.equal(snapshot.timing.points[0].bpm, bpm);
    console.log(JSON.stringify({ snapshot: snapshots.at(-1) }));
  }
  report.probe = await app.evaluate(() => globalThis.resourceProbe);
  assert.ok(
    report.probe.operations.filter((o) => o.channel === 'project:save').every((o) => o.ok),
    'all saves succeeded',
  );
  report.decode = await page.evaluate(() => window.resourceDecode);
  const count = await page.getByTestId('canvas-host').getAttribute('data-render-count');
  await page.waitForTimeout(500);
  assert.equal(await page.getByTestId('canvas-host').getAttribute('data-render-count'), count);
  await page.screenshot({ path: path.join(directory, 'real-psd.png') });
  report.project = file;
  assert.deepEqual(report.errors, []);
  report.passed = true;
} catch (e) {
  report.passed = false;
  report.error = String(e.stack ?? e);
  console.error(report.error);
  process.exitCode = 1;
  await page?.screenshot({ path: path.join(directory, 'failure.png') }).catch(() => {});
} finally {
  await fs.writeFile(path.join(directory, 'report.json'), JSON.stringify(report, null, 2));
  if (app) {
    await app.evaluate(({ app }) => app.exit(0)).catch(() => {});
    await app.close().catch(() => {});
  }
}
