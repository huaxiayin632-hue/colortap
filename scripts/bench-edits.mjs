// Document-edit benchmark, separate from GPU FPS. Run with node --expose-gc.
import { createServer } from 'vite';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';

const label = process.argv[2] ?? 'current';
assert(/^[\w-]+$/.test(label));
const file = path.resolve(process.argv[3] ?? '示例工程/图层练习/6000像素图层练习.rcproj');
const server = await createServer({ configFile: false, server: { middlewareMode: true } });
try {
  const { EditHistory } = await server.ssrLoadModule('/src/application/history.ts');
  const { validateProject } = await server.ssrLoadModule('/src/shared/schema.ts');
  const project = validateProject(JSON.parse(await fs.readFile(file, 'utf8')));
  const layer = Object.values(project.layers).find((l) => l.kind !== 'group' && !l.locked);
  assert(layer);
  const report = {
    file,
    layers: Object.keys(project.layers).length,
    artwork: project.stage.artworkSize,
    assetCount: Object.keys(project.assets).length,
    gcAvailable: !!global.gc,
    results: [],
  };
  const stats = (values) => {
    const sorted = [...values].sort((a, b) => a - b);
    return {
      meanMs: values.reduce((a, b) => a + b, 0) / values.length,
      p95Ms: sorted[Math.ceil(sorted.length * 0.95) - 1],
    };
  };
  for (const kind of ['rename', 'layer-opacity']) {
    const command = (i) =>
      kind === 'rename'
        ? { type: 'rename', name: `编辑 ${i}` }
        : { type: 'set-layer', id: layer.id, patch: { opacity: i % 2 ? 0.7 : 0.9 } };
    const warmup = new EditHistory(project);
    for (let i = 0; i < 10; i++) warmup.execute(command(i));
    const history = new EditHistory(project),
      assetMaps = new Set([project.assets]),
      pixelMaps = new Set([project.pixelSources]),
      times = [];
    global.gc?.();
    const before = process.memoryUsage().heapUsed;
    for (let i = 0; i < 100; i++) {
      const start = performance.now();
      history.execute(command(i));
      assert(history.dirty);
      times.push(performance.now() - start);
      assetMaps.add(history.current.assets);
      pixelMaps.add(history.current.pixelSources);
    }
    global.gc?.();
    const retainedHeapMiB = (process.memoryUsage().heapUsed - before) / 1024 ** 2;
    const dirtyStart = performance.now();
    for (let i = 0; i < 100; i++) assert(history.dirty);
    const dirtyReadsMs = performance.now() - dirtyStart;
    for (let i = 0; i < 100; i++) history.undo();
    assert.equal(history.current, project);
    assert.equal(history.dirty, false);
    report.results.push({
      kind,
      edits: 100,
      ...stats(times),
      retainedHeapMiB,
      dirtyReadsMs,
      assetCopies: assetMaps.size,
      pixelIndexCopies: pixelMaps.size,
    });
  }
  await fs.mkdir('test-results/architecture', { recursive: true });
  await fs.writeFile(`test-results/architecture/${label}.json`, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
} finally {
  await server.close();
}
