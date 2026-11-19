export interface KnownAudio {
  sampleRate: number;
  channels: Float32Array[];
  truthUs: number[];
}

/** Independent truth: each beat is calculated from its index, never from detector output. */
export function beatTimes(
  bpm: number,
  offsetUs: number,
  durationUs: number,
  subdivisions = 1,
): number[] {
  const times: number[] = [];
  for (let index = 0; ; index++) {
    const time = offsetUs + (index * 60e6) / bpm / subdivisions;
    if (time >= durationUs - 30_000) return times;
    times.push(Math.round(time));
  }
}

export function synthesize(
  sampleRate: number,
  durationUs: number,
  timesUs: number[],
  options: { amplitudes?: number[]; antiphase?: boolean; drum?: boolean; tone?: boolean } = {},
): KnownAudio {
  const samples = new Float32Array(Math.round((durationUs * sampleRate) / 1e6)),
    truthUs = timesUs.map((t) =>
      Math.round((Math.round((t * sampleRate) / 1e6) * 1e6) / sampleRate),
    );
  // The sustained background itself begins at sample zero, which is also a real onset.
  if (options.tone && truthUs[0] !== 0) truthUs.unshift(0);
  let random = 0x1278abcd;
  if (options.tone)
    for (let i = 0; i < samples.length; i++)
      samples[i] = 0.035 * Math.sin((2 * Math.PI * 330 * i) / sampleRate);
  for (let hit = 0; hit < timesUs.length; hit++) {
    const start = Math.round((timesUs[hit] * sampleRate) / 1e6),
      length = Math.round(sampleRate * (options.drum ? 0.085 : 0.012)),
      amplitude = options.amplitudes?.[hit] ?? 0.7;
    for (let i = 0; i < length && start + i < samples.length; i++) {
      random = (Math.imul(random, 1664525) + 1013904223) >>> 0;
      const seconds = i / sampleRate,
        noise = random / 0x80000000 - 1;
      const value = options.drum
        ? (Math.sin(2 * Math.PI * (110 * seconds - 200 * seconds * seconds)) *
            Math.exp(-seconds * 50) +
            0.35 * noise * Math.exp(-seconds * 200)) *
          Math.min(1, seconds / 0.001)
        : (0.6 * Math.sin(2 * Math.PI * 1300 * seconds) + 0.4 * noise) * Math.exp(-seconds * 500);
      samples[start + i] += amplitude * value;
    }
  }
  return {
    sampleRate,
    channels: options.antiphase ? [samples, Float32Array.from(samples, (s) => -s)] : [samples],
    truthUs,
  };
}

/** Sorted one-to-one matching; false positives and misses remain separate from time error. */
export function onsetErrors(
  detected: readonly { timeUs: number }[],
  truth: readonly number[],
  toleranceUs = 20_000,
) {
  const errors: number[] = [];
  let actual = 0,
    expected = 0,
    missed = 0,
    falsePositives = 0;
  while (actual < detected.length && expected < truth.length) {
    const error = detected[actual].timeUs - truth[expected];
    if (Math.abs(error) <= toleranceUs) {
      errors.push(error);
      actual++;
      expected++;
    } else if (error < 0) {
      falsePositives++;
      actual++;
    } else {
      missed++;
      expected++;
    }
  }
  missed += truth.length - expected;
  falsePositives += detected.length - actual;
  const absolute = errors.map(Math.abs).sort((a, b) => a - b);
  return {
    expected: truth.length,
    detected: detected.length,
    matched: errors.length,
    missed,
    falsePositives,
    recall: truth.length ? errors.length / truth.length : 1,
    precision: detected.length ? errors.length / detected.length : 1,
    meanAbsoluteUs: absolute.length ? absolute.reduce((a, b) => a + b) / absolute.length : 0,
    p95Us: absolute[Math.max(0, Math.ceil(absolute.length * 0.95) - 1)] ?? 0,
    maxUs: absolute.at(-1) ?? 0,
    meanSignedUs: errors.length ? errors.reduce((a, b) => a + b) / errors.length : 0,
  };
}
