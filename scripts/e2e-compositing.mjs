// Independently compare the WebGL compositor with Chromium's native Canvas2D blending.
// Fixtures are generated PSDs, not Photoshop-authored reference exports.
import { _electron as electron } from 'playwright';
import { writePsdBuffer } from 'ag-psd';
import { PNG } from 'pngjs';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const directory = path.join(root, 'test-results', 'compositing');
await fs.mkdir(directory, { recursive: true });
const environment = {
  ...process.env,
  RHYTHM_USER_DATA: path.join(directory, `profile-${Date.now()}`),
};
delete environment.ELECTRON_RUN_AS_NODE;
delete environment.ELECTRON_RENDERER_URL;
const width = 800,
  height = 640,
  background = [64, 92, 120, 255];
const solid = (w, h, rgba) => {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < data.length; i += 4) data.set(rgba, i);
  return { width: w, height: h, data };
};
const modes = [
  'normal',
  'multiply',
  'screen',
  'overlay',
  'darken',
  'lighten',
  'soft light',
  'hard light',
];
const children = [{ name: '背景', imageData: solid(width, height, background) }];
const samples = [];
for (let i = 0; i < modes.length; i++) {
  const x = 20 + (i % 4) * 195,
    y = 20 + Math.floor(i / 4) * 105;
  children.push({
    name: modes[i],
    blendMode: 'normal',
    opacity: 179 / 255,
    children: [
      { name: `${modes[i]} 底`, left: x, top: y, imageData: solid(160, 80, [90, 170, 210, 160]) },
      {
        name: `${modes[i]} 色`,
        left: x + 40,
        top: y + 10,
        opacity: 166 / 255,
        blendMode: modes[i],
        imageData: solid(120, 60, [220, 70, 150, 180]),
      },
    ],
  });
  samples.push({ name: `${modes[i]} on transparent group`, x: x + 90, y: y + 35 });
  samples.push({ name: `${modes[i]} base alpha`, x: x + 15, y: y + 35 });
}
const masks = [
  { name: '黑底蒙版', defaultColor: 0 },
  { name: '白底蒙版', defaultColor: 255 },
  { name: '禁用蒙版', defaultColor: 0, disabled: true },
  { name: '蒙版浓度', defaultColor: 0, userMaskDensity: 102 / 255 },
  { name: '相对坐标', defaultColor: 0, positionRelativeToLayer: true },
  { name: '负向偏移', defaultColor: 255, negative: true },
  { name: '嵌套分组蒙版', defaultColor: 0, group: true },
  { name: '常量蒙版', defaultColor: 0, constant: true },
];
for (let i = 0; i < masks.length; i++) {
  const spec = masks[i],
    x = 20 + (i % 4) * 195,
    y = 235 + Math.floor(i / 4) * 105;
  const offset = spec.negative ? -10 : 20;
  const maskPixels = solid(100, 60, [0, 0, 0, 255]);
  for (let yy = 0; yy < 60; yy++)
    for (let xx = 0; xx < 100; xx++) {
      const v = [0, 64, 128, 255][Math.floor(xx / 25)];
      maskPixels.data.set([v, v, v, 255], (yy * 100 + xx) * 4);
    }
  const { name, negative, group, constant, ...flags } = spec;
  const mask = {
    ...flags,
    ...(!constant
      ? {
          left: spec.positionRelativeToLayer ? offset : x + offset,
          top: spec.positionRelativeToLayer ? 10 : y + 10,
          imageData: maskPixels,
        }
      : {}),
  };
  const layer = {
    name,
    left: x,
    top: y,
    opacity: 204 / 255,
    mask,
    imageData: solid(160, 80, [230, 160, 70, 255]),
  };
  if (group) {
    layer.blendMode = 'normal';
    delete layer.imageData;
    delete layer.left;
    delete layer.top;
    layer.children = [
      {
        name: '嵌套',
        blendMode: 'normal',
        children: [
          { name: '组内底色', left: x, top: y, imageData: solid(160, 80, [230, 160, 70, 255]) },
          {
            name: '组内覆盖',
            left: x + 50,
            top: y,
            imageData: solid(110, 80, [70, 180, 220, 255]),
          },
        ],
      },
    ];
  }
  children.push(layer);
  for (const dx of [5, 30, 55, 80, 110, 145])
    samples.push({ name: `${name} x${dx}`, x: x + dx, y: y + 35 });
}
for (let i = 0; i < 4; i++) {
  const x = 20 + i * 195,
    y = 450;
  children.push({
    name: `剪贴底 ${i}`,
    left: x,
    top: y,
    opacity: 128 / 255,
    blendMode: i === 1 ? 'multiply' : 'normal',
    hidden: i === 3,
    imageData: solid(100, 70, [80, 180, 220, 128]),
    ...(i === 2
      ? {
          mask: {
            left: x + 10,
            top: y,
            defaultColor: 0,
            imageData: solid(60, 70, [128, 128, 128, 255]),
          },
        }
      : {}),
  });
  children.push({
    name: `剪贴一 ${i}`,
    clipping: true,
    left: x - 10,
    top: y + 5,
    opacity: 153 / 255,
    imageData: solid(140, 60, [220, 70, 90, 255]),
  });
  children.push({
    name: `剪贴二 ${i}`,
    clipping: true,
    left: x + 30,
    top: y + 5,
    opacity: 102 / 255,
    imageData: solid(80, 60, [60, 230, 90, 255]),
  });
  for (const dx of [5, 20, 50, 85, 120])
    samples.push({ name: `剪贴组 ${i} x${dx}`, x: x + dx, y: y + 30 });
}
for (let i = 0; i < 2; i++) {
  const x = 20 + i * 195,
    y = 550;
  children.push({
    name: i ? '隔离组' : '穿透组',
    blendMode: i ? 'normal' : 'pass through',
    children: [
      {
        name: '组内正片叠底',
        blendMode: 'multiply',
        left: x,
        top: y,
        imageData: solid(160, 70, [180, 80, 200, 255]),
      },
    ],
  });
  samples.push({ name: i ? 'isolated group' : 'pass through group', x: x + 60, y: y + 30 });
}
const halfMask = (x, y, w = 160, h = 70) => ({
  left: x,
  top: y,
  defaultColor: 0,
  imageData: solid(w, h, [128, 128, 128, 255]),
});
children.push({
  name: '多重蒙版',
  blendMode: 'normal',
  opacity: 153 / 255,
  mask: halfMask(410, 550),
  children: [
    { name: '多重底', left: 410, top: 550, imageData: solid(160, 70, [180, 150, 100, 255]) },
    {
      name: '内蒙版组',
      blendMode: 'normal',
      opacity: 128 / 255,
      mask: halfMask(410, 550),
      children: [
        { name: '内底', left: 410, top: 550, imageData: solid(160, 70, [100, 200, 100, 255]) },
        {
          name: '蒙版正片叠底',
          blendMode: 'multiply',
          left: 410,
          top: 550,
          imageData: solid(160, 70, [200, 100, 240, 255]),
          mask: halfMask(410, 550),
        },
      ],
    },
  ],
});
children.push({
  name: '高级剪贴底',
  left: 605,
  top: 550,
  imageData: solid(160, 70, [90, 170, 210, 128]),
});
children.push({
  name: '蒙版柔光剪贴',
  left: 605,
  top: 550,
  clipping: true,
  blendMode: 'soft light',
  opacity: 179 / 255,
  imageData: solid(160, 70, [220, 70, 150, 180]),
  mask: halfMask(605, 550),
});
samples.push({ name: 'three nested masks + multiply', x: 470, y: 580 });
samples.push({ name: 'masked soft-light clipped to translucent base', x: 665, y: 580 });
const file = path.join(directory, '剪贴与蒙版对照.psd');
await fs.writeFile(file, writePsdBuffer({ width, height, children }, { noBackground: true }));
const report = {
  passed: false,
  checks: [],
  errors: [],
  reference: 'Chromium Canvas2D; generated PSD, not Photoshop exports',
};
let app, page;
try {
  app = await electron.launch({ args: [root], cwd: root, env: environment });
  page = await app.firstWindow();
  page.setDefaultTimeout(30000);
  page.on('pageerror', (e) => report.errors.push(String(e)));
  page.on('console', (m) => {
    if (m.type() === 'error') report.errors.push(m.text());
  });
  await page.getByTestId('pixi-canvas').waitFor();
  const reference = await page.evaluate(
    ({ modes, masks, width, height, background }) => {
      const canvas = (w, h) => {
        const c = document.createElement('canvas');
        c.width = w;
        c.height = h;
        return c;
      };
      const fill = (c, rgba, x = 0, y = 0, w = c.canvas.width, h = c.canvas.height) => {
        c.fillStyle = `rgba(${rgba.slice(0, 3).join(',')},${rgba[3] / 255})`;
        c.fillRect(x, y, w, h);
      };
      const out = canvas(width, height),
        ctx = out.getContext('2d');
      fill(ctx, background);
      modes.forEach((mode, i) => {
        const x = 20 + (i % 4) * 195,
          y = 20 + Math.floor(i / 4) * 105;
        const c = canvas(160, 80),
          s = c.getContext('2d');
        fill(s, [90, 170, 210, 160]);
        s.globalCompositeOperation = mode === 'normal' ? 'source-over' : mode.replace(' ', '-');
        s.globalAlpha = 166 / 255;
        fill(s, [220, 70, 150, 180], 40, 10, 120, 60);
        ctx.globalAlpha = 179 / 255;
        ctx.drawImage(c, x, y);
        ctx.globalAlpha = 1;
      });
      masks.forEach((spec, i) => {
        const x = 20 + (i % 4) * 195,
          y = 235 + Math.floor(i / 4) * 105;
        const c = canvas(160, 80),
          s = c.getContext('2d');
        fill(s, [230, 160, 70, 255]);
        if (spec.group) fill(s, [70, 180, 220, 255], 50, 0, 110, 80);
        if (!spec.disabled) {
          const m = canvas(160, 80),
            mctx = m.getContext('2d'),
            p = mctx.createImageData(160, 80);
          for (let yy = 0; yy < 80; yy++)
            for (let xx = 0; xx < 160; xx++) {
              const mx = xx - (spec.negative ? -10 : 20),
                my = yy - 10;
              const v =
                !spec.constant && mx >= 0 && mx < 100 && my >= 0 && my < 60
                  ? [0, 64, 128, 255][Math.floor(mx / 25)]
                  : spec.defaultColor;
              const a = 255 - (spec.userMaskDensity ?? 1) * (255 - v);
              p.data.set([255, 255, 255, Math.round(a)], (yy * 160 + xx) * 4);
            }
          mctx.putImageData(p, 0, 0);
          s.globalCompositeOperation = 'destination-in';
          s.drawImage(m, 0, 0);
        }
        ctx.globalAlpha = 204 / 255;
        ctx.drawImage(c, x, y);
        ctx.globalAlpha = 1;
      });
      for (let i = 0; i < 4; i++) {
        if (i === 3) continue;
        const x = 20 + i * 195,
          y = 450,
          c = canvas(160, 70),
          s = c.getContext('2d');
        fill(s, [80, 180, 220, 128], 0, 0, 100, 70);
        if (i === 2) {
          const m = canvas(160, 70);
          fill(m.getContext('2d'), [255, 255, 255, 128], 10, 0, 60, 70);
          s.globalCompositeOperation = 'destination-in';
          s.drawImage(m, 0, 0);
        }
        s.globalCompositeOperation = 'source-atop';
        s.globalAlpha = 153 / 255;
        fill(s, [220, 70, 90, 255], -10, 5, 140, 60);
        s.globalAlpha = 102 / 255;
        fill(s, [60, 230, 90, 255], 30, 5, 80, 60);
        ctx.globalAlpha = 128 / 255;
        ctx.globalCompositeOperation = i === 1 ? 'multiply' : 'source-over';
        ctx.drawImage(c, x, y);
        ctx.globalAlpha = 1;
        ctx.globalCompositeOperation = 'source-over';
      }
      ctx.globalCompositeOperation = 'multiply';
      fill(ctx, [180, 80, 200, 255], 20, 550, 160, 70);
      ctx.globalCompositeOperation = 'source-over';
      fill(ctx, [180, 80, 200, 255], 215, 550, 160, 70);
      const outer = canvas(160, 70),
        o = outer.getContext('2d');
      const inner = canvas(160, 70),
        n = inner.getContext('2d');
      fill(o, [180, 150, 100, 255]);
      fill(n, [100, 200, 100, 255]);
      n.globalCompositeOperation = 'multiply';
      n.globalAlpha = 128 / 255;
      fill(n, [200, 100, 240, 255]);
      o.globalAlpha = (128 / 255) ** 2;
      o.drawImage(inner, 0, 0);
      ctx.globalAlpha = (153 / 255) * (128 / 255);
      ctx.drawImage(outer, 410, 550);
      ctx.globalAlpha = 1;
      const clipped = canvas(160, 70),
        c = clipped.getContext('2d');
      fill(c, [90, 170, 210, 255]);
      c.globalCompositeOperation = 'soft-light';
      c.globalAlpha = (179 / 255) * (128 / 255);
      fill(c, [220, 70, 150, 180]);
      ctx.globalAlpha = 128 / 255;
      ctx.drawImage(clipped, 605, 550);
      ctx.globalAlpha = 1;
      return out.toDataURL();
    },
    { modes, masks, width, height, background },
  );
  const expected = PNG.sync.read(Buffer.from(reference.split(',')[1], 'base64'));
  await fs.writeFile(path.join(directory, '参考.png'), PNG.sync.write(expected));
  await app.evaluate(({ dialog }, file) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] });
  }, file);
  await page.getByRole('button', { name: '＋ 导入 PSD / PNG', exact: true }).click();
  await page.waitForFunction(() =>
    document.querySelector('.status-message')?.textContent?.includes('已导入'),
  );
  assert.equal(await page.getByRole('dialog', { name: 'PSD 兼容提示' }).count(), 0);
  await page.waitForFunction(
    () => Number(document.querySelector('[data-testid=canvas-host]')?.dataset.loading ?? 1) === 0,
  );
  await page.waitForTimeout(450);
  const compare = async (label, points = samples, referencePixels = expected) => {
    const actual = PNG.sync.read(await page.getByTestId('pixi-canvas').screenshot());
    const view = await page.getByTestId('canvas-host').evaluate((el) => ({
      zoom: +el.dataset.zoom,
      x: +el.dataset.panX,
      y: +el.dataset.panY,
      w: el.clientWidth,
      h: el.clientHeight,
    }));
    for (const sample of points) {
      const x = Math.round(((sample.x * view.zoom + view.x) * actual.width) / view.w);
      const y = Math.round(((sample.y * view.zoom + view.y) * actual.height) / view.h);
      const a = [...actual.data.slice((y * actual.width + x) * 4, (y * actual.width + x) * 4 + 3)];
      const b = [
        ...referencePixels.data.slice(
          (sample.y * width + sample.x) * 4,
          (sample.y * width + sample.x) * 4 + 3,
        ),
      ];
      const error = Math.max(...a.map((v, i) => Math.abs(v - b[i])));
      report.checks.push({ label, ...sample, actual: a, expected: b, error });
    }
    await fs.writeFile(path.join(directory, `${label}.png`), PNG.sync.write(actual));
    const failures = report.checks.filter((c) => c.error > 3);
    assert.equal(failures.length, 0, JSON.stringify(failures.slice(0, 12), null, 2));
  };
  await compare('导入效果');
  const projectFile = path.join(directory, 'project', '剪贴与蒙版.rcproj');
  await app.evaluate(({ dialog }, file) => {
    dialog.showSaveDialog = async () => ({ canceled: false, filePath: file });
  }, projectFile);
  await page.getByRole('button', { name: '保存', exact: true }).click();
  await page.waitForFunction(
    () => document.querySelector('.save-state')?.textContent?.trim() === '已保存',
  );
  const saved = JSON.parse(await fs.readFile(projectFile, 'utf8'));
  assert.equal(Object.values(saved.layers).filter((l) => l.rasterMask).length, 13);
  assert.equal(Object.values(saved.layers).filter((l) => l.clippingBaseId).length, 9);
  for (const a of Object.values(saved.assets))
    assert.equal(
      (await fs.stat(path.join(path.dirname(projectFile), a.relativePath))).size,
      a.byteLength,
    );
  await app.evaluate(({ dialog }, file) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] });
  }, projectFile);
  await page.getByRole('button', { name: '打开', exact: true }).click();
  await page.waitForFunction(
    () => Number(document.querySelector('[data-testid=canvas-host]')?.dataset.loading ?? 1) === 0,
  );
  await page.waitForTimeout(450);
  await compare('重开效果');
  const transparent = structuredClone(saved);
  const single = Object.values(transparent.layers).find((l) => l.name === '高级剪贴底');
  single.blendMode = 'multiply';
  transparent.layers = { [single.id]: single };
  transparent.rootLayersBottomToTop = [single.id];
  const transparentFile = path.join(path.dirname(projectFile), '透明背景混合.rcproj');
  await fs.writeFile(transparentFile, JSON.stringify(transparent, null, 2));
  await app.evaluate(({ dialog }, file) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] });
  }, transparentFile);
  await page.getByRole('button', { name: '打开', exact: true }).click();
  await page.waitForFunction(() => document.querySelectorAll('.layer-row').length === 1);
  await page.waitForFunction(
    () => Number(document.querySelector('[data-testid=canvas-host]')?.dataset.loading ?? 1) === 0,
  );
  await page.waitForTimeout(250);
  const board = solid(width, height, [45, 49, 54, 255]);
  const rgb = [90, 170, 210].map((v, i) =>
    Math.round((v * 128) / 255 + ([45, 49, 54][i] * 127) / 255),
  );
  board.data.set([...rgb, 255], (583 * width + 665) * 4);
  await compare('透明背景', [{ name: 'multiply ignores editor board', x: 665, y: 583 }], board);
  assert.deepEqual(report.errors, []);
  report.passed = true;
} catch (error) {
  report.error = String(error);
  process.exitCode = 1;
  console.error(error);
  if (page) await page.screenshot({ path: path.join(directory, 'failure.png') }).catch(() => {});
} finally {
  await fs.writeFile(path.join(directory, 'report.json'), JSON.stringify(report, null, 2));
  if (app) {
    await app.evaluate(({ app }) => app.exit(0)).catch(() => {});
    await app.close().catch(() => {});
  }
  const profile = path.resolve(environment.RHYTHM_USER_DATA);
  if (path.dirname(profile) !== directory || !/^profile-\d+$/.test(path.basename(profile)))
    throw new Error('Unsafe cleanup');
  await fs.rm(profile, { recursive: true, force: true });
}
console.log(
  `Compositing: ${report.passed ? 'PASS' : 'FAIL'}, ${report.checks.length} pixel checks`,
);
