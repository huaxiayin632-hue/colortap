import { _electron as electron } from 'playwright';
import { build } from 'vite';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const directory = path.join(root, 'test-results', 'audio-analysis');
const harness = path.join(directory, 'harness');
const builtHarness = path.join(root, 'out', 'renderer', '__analysis-test');
const profile = path.join(directory, `profile-${Date.now()}`);
await fs.mkdir(harness, { recursive: true });
await fs.writeFile(
  path.join(harness, 'index.html'),
  `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'self'; worker-src 'self'; style-src 'self' 'unsafe-inline'"><title>Audio analysis worker verification</title></head><body><button id="probe">Respond: 0</button><input id="input" aria-label="Main thread input"><output id="state">ready</output><script type="module" src="./main.ts"></script></body></html>`,
);
const modulePath = (file) => path.relative(harness, path.join(root, file)).replaceAll('\\', '/');
await fs.writeFile(
  path.join(harness, 'main.ts'),
  `
import { AudioAnalysisTask } from '${modulePath('src/renderer/audio/audio-analysis-task.ts')}';
import { beatTimes, synthesize, onsetErrors } from '${modulePath('tests/fixtures/audio-analysis.ts')}';
const task = new AudioAnalysisTask();
const api = { jobs: [], current: null, probes: 0 };
document.querySelector('#probe').onclick = () => { api.probes++; document.querySelector('#probe').textContent = 'Respond: ' + api.probes; };
api.start = (seconds, bpm = 120) => {
  const data = synthesize(48000, seconds * 1e6, beatTimes(bpm, 213321, seconds * 1e6), { antiphase: true });
  const buffer = new AudioBuffer({ sampleRate: data.sampleRate, length: data.channels[0].length, numberOfChannels: 2 });
  data.channels.forEach((channel, i) => buffer.copyToChannel(channel, i));
  const at = Math.round(0.215 * data.sampleRate), original = buffer.getChannelData(0)[at];
  const job = { id: api.jobs.length + 1, state: 'running', progress: [], frames: 0, frameGaps: [], started: performance.now(), expected: data.truthUs.length, bpm, source: { assetId: 'fixture-' + api.jobs.length, sha256: 'known-PCM-' + seconds + '-' + bpm } };
  api.jobs.push(job); api.current = job;
  let lastFrame = performance.now();
  const frame = (now) => {
    if (job.state !== 'running') return;
    job.frames++; job.frameGaps.push(now - lastFrame); lastFrame = now;
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
  document.querySelector('#state').textContent = 'analyzing';
  task.analyze(buffer, job.source, {}, (progress) => job.progress.push(progress)).then((result) => {
    job.state = 'done'; job.sourceReturned = result.source; job.tempos = result.analysis.tempos;
    job.errors = onsetErrors(result.analysis.onsets, data.truthUs);
    job.elapsedMs = performance.now() - job.started;
    job.inputPreserved = buffer.getChannelData(0).byteLength === buffer.length * 4 && buffer.getChannelData(0)[at] === original && original !== 0;
    job.runningAfter = task.running;
    document.querySelector('#state').textContent = 'done';
  }).catch((error) => { job.state = error.name; job.message = error.message; job.runningAfter = task.running; });
  return job.id;
};
api.cancel = () => task.cancel();
window.analysisHarness = api;
`,
);
await build({
  configFile: false,
  root: harness,
  base: './',
  logLevel: 'warn',
  build: {
    outDir: builtHarness,
    emptyOutDir: false,
    rollupOptions: {
      output: {
        entryFileNames: 'harness.js',
        assetFileNames: '[name][extname]',
        chunkFileNames: '[name].js',
      },
    },
  },
  worker: { rollupOptions: { output: { entryFileNames: 'audio-analysis.worker.js' } } },
});
const environment = { ...process.env, RHYTHM_USER_DATA: profile };
delete environment.ELECTRON_RUN_AS_NODE;
delete environment.ELECTRON_RENDERER_URL;
const report = {
  checks: [],
  errors: [],
  limitations: [
    'Runs the built analysis modules and actual Web Worker under the existing Electron protocol/CSP. This is a core test harness, not an editor panel or chart integration test.',
    'Synthetic PCM is constructed as an AudioBuffer. No physical output latency, compressed-file decoder delay, or real-song accuracy is measured.',
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
async function job(id) {
  return page.evaluate((id) => window.analysisHarness.jobs.find((j) => j.id === id), id);
}
async function start(seconds, bpm = 120) {
  return page.evaluate(({ seconds, bpm }) => window.analysisHarness.start(seconds, bpm), {
    seconds,
    bpm,
  });
}
async function spectrum(id) {
  await page.waitForFunction(
    (id) =>
      window.analysisHarness.jobs
        .find((j) => j.id === id)
        ?.progress.some((p) => p.phase === 'spectrum'),
    id,
  );
}
async function finished(id) {
  await page.waitForFunction(
    (id) => window.analysisHarness.jobs.find((j) => j.id === id)?.state !== 'running',
    id,
  );
  return job(id);
}
try {
  app = await electron.launch({ args: [root], cwd: root, env: environment });
  page = await app.firstWindow();
  page.setDefaultTimeout(30000);
  page.on('pageerror', (error) => report.errors.push(String(error)));
  await page.getByTestId('pixi-canvas').waitFor();
  await page.goto('rhythm://app/__analysis-test/index.html');
  await page.waitForFunction(() => Boolean(window.analysisHarness));
  await app.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0];
    window.show();
    window.focus();
  });
  await check('真实 Worker 分析 120 秒反相立体声，主线程仍接受点击和文字输入', async () => {
    const id = await start(120);
    await spectrum(id);
    const before = await job(id),
      at = performance.now();
    assert.equal(before.state, 'running');
    await page.getByRole('button', { name: 'Respond: 0', exact: true }).click();
    await page.getByLabel('Main thread input').fill('input during analysis');
    const inputLatencyMs = performance.now() - at;
    assert.equal(await page.getByLabel('Main thread input').inputValue(), 'input during analysis');
    assert.equal(await page.evaluate(() => window.analysisHarness.probes), 1);
    const result = await finished(id);
    assert.equal(result.state, 'done');
    assert.equal(result.inputPreserved, true);
    assert.equal(result.runningAfter, false);
    assert.deepEqual(result.sourceReturned, result.source);
    assert.equal(result.errors.recall, 1);
    assert.equal(result.errors.precision, 1);
    assert.ok(result.errors.p95Us <= 20000);
    assert.ok(Math.abs(result.tempos[0].bpm / 120 - 1) <= 0.002);
    assert.ok(result.frames >= 5);
    const gaps = result.frameGaps.slice(1).sort((a, b) => a - b),
      p95FrameMs = gaps[Math.ceil(gaps.length * 0.95) - 1];
    assert.ok(p95FrameMs < 100, `P95 UI frame gap: ${p95FrameMs}`);
    assert.ok(inputLatencyMs < 1000, `input latency: ${inputLatencyMs}`);
    return {
      durationUs: 120e6,
      channels: 2,
      elapsedMs: Math.round(result.elapsedMs),
      onsets: result.errors,
      bpm: result.tempos[0].bpm,
      frames: result.frames,
      p95FrameMs,
      inputLatencyMs: Math.round(inputLatencyMs),
      inputPreserved: result.inputPreserved,
    };
  });
  await check('复制阶段取消立即终止，之后仍能启动新分析', async () => {
    const id = await start(60);
    await page.evaluate(() => window.analysisHarness.cancel());
    const result = await finished(id);
    assert.equal(result.state, 'AbortError');
    assert.equal(result.runningAfter, false);
    return { state: result.state, running: result.runningAfter };
  });
  await check('计算中换任务：旧任务取消，新音频独立完成且保留来源身份', async () => {
    const old = await start(120);
    await spectrum(old);
    const next = await start(16, 90);
    const result = await finished(next),
      previous = await job(old);
    assert.equal(previous.state, 'AbortError');
    assert.equal(result.state, 'done');
    assert.deepEqual(result.sourceReturned, result.source);
    assert.notDeepEqual(result.sourceReturned, previous.source);
    assert.ok(Math.abs(result.tempos[0].bpm / 90 - 1) <= 0.002);
    assert.equal(result.inputPreserved, true);
    return {
      oldState: previous.state,
      nextState: result.state,
      source: result.sourceReturned,
      bpm: result.tempos[0].bpm,
    };
  });
  assert.deepEqual(report.errors, []);
  report.passed = true;
} catch (error) {
  report.passed = false;
  report.error = error.stack ?? String(error);
  console.error(report.error);
  process.exitCode = 1;
} finally {
  await fs.writeFile(path.join(directory, 'worker.json'), JSON.stringify(report, null, 2));
  if (app) {
    await app.evaluate(({ app }) => app.exit(0)).catch(() => {});
    await app.close().catch(() => {});
  }
  if (
    path.dirname(path.resolve(profile)) !== path.resolve(directory) ||
    !/^profile-\d+$/.test(path.basename(profile))
  )
    throw Error('Unexpected test profile path');
  for (const temporary of [profile, harness, builtHarness]) {
    const target = path.resolve(temporary);
    if (!target.startsWith(`${root}${path.sep}`)) throw Error('Unexpected test cleanup path');
    await fs.rm(target, { recursive: true, force: true });
  }
}
