import type { Rect } from '../../shared/models';

export interface Pixels {
  width: number;
  height: number;
  data: Uint8Array | Uint8ClampedArray;
}
export function alphaBounds(p: Pixels): Rect | null {
  const count = p.width * p.height;
  let first = 0,
    last = count - 1;
  while (first < count && !p.data[first * 4 + 3]) first++;
  if (first === count) return null;
  while (last > first && !p.data[last * 4 + 3]) last--;
  const top = Math.floor(first / p.width),
    bottom = Math.floor(last / p.width);
  let left = first % p.width,
    right = last % p.width;
  for (let y = top; y <= bottom && (left > 0 || right < p.width - 1); y++) {
    const row = y * p.width;
    for (let x = 0; x < left; x++)
      if (p.data[(row + x) * 4 + 3]) {
        left = x;
        break;
      }
    for (let x = p.width - 1; x > right; x--)
      if (p.data[(row + x) * 4 + 3]) {
        right = x;
        break;
      }
  }
  return { x: left, y: top, width: right - left + 1, height: bottom - top + 1 };
}
export function extract(p: Pixels, r: Rect): Pixels {
  const data = new Uint8Array(r.width * r.height * 4);
  for (let y = 0; y < r.height; y++)
    data.set(
      p.data.subarray(((r.y + y) * p.width + r.x) * 4, ((r.y + y) * p.width + r.x + r.width) * 4),
      y * r.width * 4,
    );
  return { width: r.width, height: r.height, data };
}
/** Alpha-weighted box reduction prevents transparent RGB from making dark preview fringes. */
export function half(p: Pixels): Pixels {
  const width = Math.ceil(p.width / 2),
    height = Math.ceil(p.height / 2),
    data = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      if (x * 2 + 1 < p.width && y * 2 + 1 < p.height) {
        const i = (y * 2 * p.width + x * 2) * 4,
          k = i + p.width * 4,
          j = (y * width + x) * 4,
          d = p.data;
        const a0 = d[i + 3],
          a1 = d[i + 7],
          a2 = d[k + 3],
          a3 = d[k + 7],
          sum = a0 + a1 + a2 + a3;
        data[j + 3] = Math.round(sum / 4);
        if (a0 === a1 && a0 === a2 && a0 === a3) {
          for (let c = 0; c < 3; c++)
            data[j + c] = sum
              ? Math.round((d[i + c] + d[i + c + 4] + d[k + c] + d[k + c + 4]) / 4)
              : 0;
        } else
          for (let c = 0; c < 3; c++)
            data[j + c] = sum
              ? Math.round(
                  (d[i + c] * a0 + d[i + c + 4] * a1 + d[k + c] * a2 + d[k + c + 4] * a3) / sum,
                )
              : 0;
        continue;
      }
      let a = 0,
        r = 0,
        g = 0,
        b = 0,
        n = 0;
      for (let yy = y * 2; yy < Math.min(p.height, y * 2 + 2); yy++)
        for (let xx = x * 2; xx < Math.min(p.width, x * 2 + 2); xx++) {
          const i = (yy * p.width + xx) * 4,
            alpha = p.data[i + 3];
          a += alpha;
          r += p.data[i] * alpha;
          g += p.data[i + 1] * alpha;
          b += p.data[i + 2] * alpha;
          n++;
        }
      const j = (y * width + x) * 4;
      data[j] = a ? Math.round(r / a) : 0;
      data[j + 1] = a ? Math.round(g / a) : 0;
      data[j + 2] = a ? Math.round(b / a) : 0;
      data[j + 3] = Math.round(a / n);
    }
  return { width, height, data };
}
