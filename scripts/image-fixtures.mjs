// Generated, valid PSD files: the editor must decode the files through its normal importer.
// These are not Photoshop-authored production illustrations.
import { writePsdBuffer } from 'ag-psd';
import { PNG } from 'pngjs';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';

function solid(width, height, color) {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < data.length; i += 4) data.set(color, i);
  return { width, height, data };
}
export async function smallFixtures(directory) {
  await fs.mkdir(directory, { recursive: true });
  const psd = path.join(directory, '位置与叠放.psd');
  await fs.writeFile(
    psd,
    writePsdBuffer(
      {
        width: 640,
        height: 480,
        children: [
          { name: '底色', left: 50, top: 50, imageData: solid(300, 250, [20, 180, 80, 255]) },
          {
            name: '半透明组',
            opacity: 0.5,
            blendMode: 'normal',
            children: [
              { name: '红色', left: 120, top: 100, imageData: solid(200, 200, [240, 30, 20, 255]) },
              {
                name: '嵌套组',
                blendMode: 'pass through',
                opened: true,
                children: [
                  {
                    name: '蓝色',
                    left: 180,
                    top: 140,
                    imageData: solid(200, 200, [20, 60, 240, 255]),
                  },
                ],
              },
            ],
          },
          {
            name: '隐藏图层',
            left: 5,
            top: 5,
            hidden: true,
            imageData: solid(30, 30, [255, 255, 255, 255]),
          },
        ],
      },
      { noBackground: true },
    ),
  );
  const png = path.join(directory, '透明边缘.png'),
    p = solid(240, 180, [0, 0, 0, 0]);
  for (let y = 20; y < 160; y++)
    for (let x = 30; x < 210; x++) p.data.set([240, 190, 40, 255], (y * p.width + x) * 4);
  await fs.writeFile(png, PNG.sync.write({ ...p, data: Buffer.from(p.data) }));
  const warning = path.join(directory, '混合模式提示.psd');
  await fs.writeFile(
    warning,
    writePsdBuffer({
      width: 20,
      height: 20,
      children: [
        { name: '滤色图层', blendMode: 'screen', imageData: solid(20, 20, [90, 120, 240, 255]) },
      ],
    }),
  );
  const bad = path.join(directory, '损坏.psd');
  await fs.writeFile(bad, 'broken psd');
  const hdr = Buffer.from(await fs.readFile(psd));
  hdr.writeUInt16BE(16, 22);
  const highBit = path.join(directory, '16位不兼容.psd');
  await fs.writeFile(highBit, hdr);
  return { psd, png, warning, bad, highBit };
}
export async function largeFixture(directory) {
  await fs.mkdir(directory, { recursive: true });
  const psd = path.join(directory, '6000x6000-100层-典型裁剪.psd');
  const background = solid(6000, 6000, [32, 40, 53, 255]);
  const children = [{ name: '背景 · 原尺寸 6000', left: 0, top: 0, imageData: background }];
  let i = 0;
  for (let row = 0; row < 9; row++) {
    const items = [];
    for (let column = 0; column < 11; column++, i++) {
      const size = 420,
        p = solid(size, size, [0, 0, 0, 0]);
      const colors = [
        [103, 192, 206],
        [233, 183, 111],
        [172, 153, 204],
        [131, 185, 151],
      ];
      const color = colors[(column + row) % colors.length];
      for (let y = 16; y < size - 16; y++)
        for (let x = 16; x < size - 16; x++) {
          const dx = x - size / 2,
            dy = y - size / 2,
            r = Math.hypot(dx, dy),
            angle = Math.atan2(dy, dx);
          if (
            (r < 179 && r > 147 && angle < 2.1 - i * 0.017) ||
            (Math.abs(dx) < 20 && Math.abs(dy) < 82) ||
            Math.hypot(dx - 68, dy + 68) < 23
          ) {
            p.data.set([...color, 255], (y * size + x) * 4);
          }
        }
      items.push({
        name: `色环 ${String(i + 1).padStart(3, '0')}`,
        left: 100 + column * 535,
        top: 130 + row * 650,
        opacity: 1,
        imageData: p,
      });
    }
    children.push({
      name: `第 ${row + 1} 行`,
      blendMode: 'pass through',
      opened: true,
      children: row === 4 ? [{ name: '嵌套素材组', blendMode: 'normal', children: items }] : items,
    });
  }
  const start = performance.now();
  await fs.writeFile(
    psd,
    writePsdBuffer({ width: 6000, height: 6000, children }, { noBackground: true }),
  );
  const metadata = {
    generated: true,
    photoshopAuthored: false,
    width: 6000,
    height: 6000,
    rasterLayers: 100,
    groups: 10,
    case: '1 full-size background plus 99 alpha-trimmed shapes, 10 groups including nesting',
    generationMs: Math.round(performance.now() - start),
    bytes: (await fs.stat(psd)).size,
  };
  await fs.writeFile(
    path.join(directory, 'fixture-description.json'),
    JSON.stringify(metadata, null, 2),
  );
  return { psd, metadata };
}
export async function denseFixture(directory) {
  await fs.mkdir(directory, { recursive: true });
  const psd = path.join(directory, '6000x6000-100层-全尺寸压力.psd');
  const start = performance.now(),
    channelCache = new Map();
  function channel(value) {
    if (!channelCache.has(value))
      channelCache.set(value, deflateSync(Buffer.alloc(6000 * 6000, value), { level: 6 }));
    return channelCache.get(value);
  }
  const palette = [
    [60, 120, 180],
    [180, 120, 60],
    [120, 180, 60],
    [60, 180, 120],
  ];
  const layers = Array.from({ length: 100 }, (_, i) => {
    const rgb = palette[i % palette.length];
    return {
      name: `全尺寸 ${String(i + 1).padStart(3, '0')}`,
      left: 0,
      top: 0,
      right: 6000,
      bottom: 6000,
      opacity: 0.65,
      rawData: {
        colorMode: 3,
        bitsPerChannel: 8,
        large: false,
        channels: [
          { id: -1, compression: 2, data: channel(200) },
          ...rgb.map((v, id) => ({ id, compression: 2, data: channel(v) })),
        ],
      },
    };
  });
  await fs.writeFile(
    psd,
    writePsdBuffer(
      {
        width: 6000,
        height: 6000,
        children: [
          {
            name: '全尺寸压力组',
            blendMode: 'pass through',
            children: [{ name: '嵌套压力组', blendMode: 'normal', children: layers }],
          },
        ],
      },
      { noBackground: true },
    ),
  );
  const metadata = {
    generated: true,
    photoshopAuthored: false,
    width: 6000,
    height: 6000,
    rasterLayers: 100,
    groups: 2,
    case: '100 full-size nonzero-alpha, overlapping solid-color layers; ZIP-compressed low-entropy stress case, not a noisy/complex production illustration',
    uncompressedLayerRgbaBytes: 100 * 6000 * 6000 * 4,
    bytes: (await fs.stat(psd)).size,
    generationMs: Math.round(performance.now() - start),
  };
  await fs.writeFile(
    path.join(directory, 'dense-fixture-description.json'),
    JSON.stringify(metadata, null, 2),
  );
  return { psd, metadata };
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const directory = path.resolve(process.argv[2] ?? 'test-results/stage2/fixtures');
  if (process.argv.includes('--dense')) console.log(await denseFixture(directory));
  else {
    console.log(await smallFixtures(directory));
    console.log(await largeFixture(directory));
  }
}
