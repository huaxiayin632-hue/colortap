// Recheck high-count filesystem operations without repeating the PSD decoder benchmark.
import { _electron as electron } from 'playwright';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const directory = path.join(root, 'test-results', 'stage2');
const source = path.join(directory, '全尺寸压力工程', '压力工程.rcproj');
const target = path.join(directory, '大工程恢复验证', '验证副本.rcproj');
const profile = path.join(directory, `reopen-profile-${Date.now()}`);
const environment = { ...process.env, RHYTHM_USER_DATA: profile };
delete environment.ELECTRON_RUN_AS_NODE;
delete environment.ELECTRON_RENDERER_URL;
const report = { startedAt: new Date().toISOString(), source, target, checks: [] };
let app, page;
async function idle() {
  await page.waitForFunction(
    () => document.querySelector('.editor-shell')?.getAttribute('aria-busy') === 'false',
    undefined,
    { timeout: 120000 },
  );
}
try {
  const original = JSON.parse(await fs.readFile(source, 'utf8'));
  app = await electron.launch({ args: [root], cwd: root, env: environment });
  page = await app.firstWindow();
  page.setDefaultTimeout(120000);
  await page.getByTestId('pixi-canvas').waitFor();
  await idle();
  await app.evaluate(({ dialog }, file) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] });
  }, source);
  const started = performance.now();
  await page.getByRole('button', { name: '打开', exact: true }).click();
  await idle();
  assert.equal(await page.getByRole('treeitem').count(), 102);
  report.openMs = Math.round(performance.now() - started);
  await page
    .locator('.layer-name')
    .filter({ hasText: /^全尺寸 100$/ })
    .click();
  const opacity = page.getByLabel('图层不透明度', { exact: true });
  await opacity.fill('67');
  await opacity.press('Tab');
  await app.evaluate(({ dialog }, file) => {
    dialog.showSaveDialog = async () => ({ canceled: false, filePath: file });
  }, target);
  const saving = performance.now();
  await page.getByRole('button', { name: '另存为', exact: true }).click();
  await idle();
  assert.equal((await page.locator('.save-state').innerText()).trim(), '已保存');
  const edited = JSON.parse(await fs.readFile(target, 'utf8'));
  assert.equal(Object.values(edited.layers).find((l) => l.name === '全尺寸 100').opacity, 0.67);
  assert.equal(Object.keys(edited.assets).length, 5301);
  report.saveAsMs = Math.round(performance.now() - saving);
  assert.deepEqual(edited.pixelSources, original.pixelSources);
  report.checks.push('打开 5301 素材工程、修改图层、另存为完整复制并实际提交');
  await app.evaluate(({ dialog }, file) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] });
  }, target);
  await page.getByRole('button', { name: '打开', exact: true }).click();
  await idle();
  await page
    .locator('.layer-name')
    .filter({ hasText: /^全尺寸 100$/ })
    .click();
  assert.equal(await opacity.inputValue(), '67');
  assert.equal(await page.getByRole('treeitem').count(), 102);
  report.checks.push('重新读取另存副本后恢复实际图层属性');
  report.passed = true;
  await page.screenshot({ path: path.join(directory, 'dense-reopened.png') });
} catch (error) {
  report.passed = false;
  report.error = String(error);
  process.exitCode = 1;
} finally {
  report.finishedAt = new Date().toISOString();
  await fs.writeFile(
    path.join(directory, 'dense-reopen-report.json'),
    JSON.stringify(report, null, 2),
  );
  if (app) {
    await app.evaluate(({ app }) => app.exit(0)).catch(() => {});
    await app.close().catch(() => {});
  }
  if (
    path.dirname(path.resolve(profile)) !== directory ||
    !/^reopen-profile-\d+$/.test(path.basename(profile))
  )
    throw new Error('Unsafe profile cleanup');
  await fs.rm(profile, { recursive: true, force: true });
}
console.log(JSON.stringify(report, null, 2));
