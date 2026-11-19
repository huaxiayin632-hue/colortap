import { afterAll, describe, expect, it } from 'vitest';
import { mkdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { analyzeAudio } from '../src/core/audio-analysis';
import { beatTimes, onsetErrors, synthesize } from './fixtures/audio-analysis';

const measurements: object[] = [];
function verify(
  name: string,
  audio: ReturnType<typeof synthesize>,
  bpm?: number,
  phaseUs?: number,
) {
  const started = performance.now(),
    result = analyzeAudio(audio),
    errors = onsetErrors(result.onsets, audio.truthUs),
    candidate = result.tempos[0],
    bpmErrorPercent = bpm && candidate ? Math.abs(candidate.bpm / bpm - 1) * 100 : null,
    period = bpm ? 60e6 / bpm : 0,
    phaseErrorUs =
      phaseUs !== undefined && candidate
        ? Math.abs(((candidate.phaseUs - phaseUs + period * 1.5) % period) - period / 2)
        : null;
  measurements.push({
    name,
    sampleRate: audio.sampleRate,
    channels: audio.channels.length,
    durationUs: result.durationUs,
    elapsedMs: Math.round(performance.now() - started),
    onsets: errors,
    bpmErrorPercent,
    phaseErrorUs,
    tempos: result.tempos,
    warnings: result.warnings,
  });
  expect(errors.recall, `${name}: recall`).toBeGreaterThanOrEqual(0.97);
  expect(errors.precision, `${name}: precision`).toBeGreaterThanOrEqual(0.97);
  expect(errors.meanAbsoluteUs, `${name}: mean error`).toBeLessThanOrEqual(10_000);
  expect(errors.p95Us, `${name}: P95 error`).toBeLessThanOrEqual(20_000);
  if (bpm !== undefined) {
    expect(candidate, name).toBeDefined();
    expect(bpmErrorPercent, `${name}: BPM error`).toBeLessThanOrEqual(0.2);
  }
  if (phaseUs !== undefined)
    expect(phaseErrorUs, `${name}: phase error`).toBeLessThanOrEqual(20_000);
  return result;
}
afterAll(async () => {
  await mkdir('test-results/audio-analysis', { recursive: true });
  await writeFile(
    'test-results/audio-analysis/accuracy.json',
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        truth:
          'Sample positions from independently generated PCM; no device latency or chart snapping in this measurement.',
        measurements,
      },
      null,
      2,
    ),
  );
});

describe('PCM onset and rhythm analysis', () => {
  it.each(
    [44100, 48000].flatMap((sampleRate) =>
      [60, 90, 120, 137.3, 180, 240].map((bpm) => ({ sampleRate, bpm })),
    ),
  )('measures $bpm BPM and non-grid phase at $sampleRate Hz', ({ sampleRate, bpm }) => {
    const offsetUs = 137_321,
      audio = synthesize(sampleRate, 16e6, beatTimes(bpm, offsetUs, 16e6));
    const result = verify(`${sampleRate}Hz-${bpm}BPM`, audio, bpm, offsetUs);
    expect(result.suggestion).not.toBeNull();
    expect(result.warnings).not.toContain('tempo-change');
  });
  it('keeps fractional-tempo drift small over a longer song', () => {
    const result = verify(
      '90s-fractional',
      synthesize(48000, 90e6, beatTimes(137.3, 173_217, 90e6)),
      137.3,
      173_217,
    );
    const suggestion = result.suggestion!;
    const lastBeat = Math.floor((90e6 - 173_217) / (60e6 / 137.3));
    expect(
      Math.abs(
        suggestion.phaseUs +
          (lastBeat * 60e6) / suggestion.bpm -
          (173_217 + (lastBeat * 60e6) / 137.3),
      ),
    ).toBeLessThanOrEqual(20_000);
  });
  it('retains antiphase stereo evidence without changing the input PCM', () => {
    const audio = synthesize(44100, 16e6, beatTimes(120, 213_317, 16e6), { antiphase: true }),
      hash = () =>
        createHash('sha256').update(new Uint8Array(audio.channels[0].buffer)).digest('hex'),
      before = hash();
    const stereo = verify('antiphase', audio, 120, 213_317),
      mono = analyzeAudio({ sampleRate: audio.sampleRate, channels: [audio.channels[0]] });
    expect(stereo.onsets).toEqual(mono.onsets);
    expect(hash()).toBe(before);
  });
  it('distinguishes stable regions across a 120 to 150 BPM change', () => {
    const times = [...beatTimes(120, 137_000, 16e6), ...beatTimes(150, 16_137_000, 32e6)];
    const result = verify('120-to-150', synthesize(48000, 32e6, times));
    expect(result.warnings).toContain('tempo-change');
    expect(result.suggestion).toBeNull();
    expect(result.regions.slice(0, 2).every((r) => Math.abs(r.tempos[0].bpm - 120) < 0.24)).toBe(
      true,
    );
    expect(result.regions.slice(2).every((r) => Math.abs(r.tempos[0].bpm - 150) < 0.3)).toBe(true);
  });
  it('returns no fictitious BPM for silence or insufficient events, and tolerates empty PCM', () => {
    for (const duration of [0, 0.01e6, 8e6]) {
      const result = verify(`silence-${duration}`, synthesize(48000, duration, []));
      expect(result.onsets).toEqual([]);
      expect(result.tempos).toEqual([]);
      expect(result.suggestion).toBeNull();
    }
    expect(analyzeAudio(synthesize(48000, 5e6, [1e6, 2.31e6, 4.71e6])).suggestion).toBeNull();
  });
  it('preserves the grid through a long quiet region without adding onsets there', () => {
    const times = [...beatTimes(120, 137_321, 6.3e6), ...beatTimes(120, 12_637_321, 21e6)];
    const result = verify('middle-silence', synthesize(44100, 21e6, times), 120, 137_321);
    expect(result.quietRegions.some((q) => q.startUs < 6.3e6 && q.endUs > 12.5e6)).toBe(true);
    expect(result.onsets.some((o) => o.timeUs > 6.3e6 && o.timeUs < 12.5e6)).toBe(false);
  });
  it('keeps a weak pickup and alternating accents, including missing beats', () => {
    const times = beatTimes(120, 137_321, 20e6).filter((_, i) => i % 9 !== 8),
      amplitudes = times.map((_, i) => (i === 0 ? 0.045 : i % 2 ? 0.16 : 0.85));
    const result = verify(
      'pickup-accents-missing',
      synthesize(48000, 20e6, times, { amplitudes }),
      120,
      137_321,
    );
    expect(Math.abs(result.onsets[0].timeUs - times[0])).toBeLessThanOrEqual(20_000);
    expect(result.onsets).toHaveLength(times.length);
    expect(result.tempos.some((c) => Math.abs(c.bpm - 60) < 0.12)).toBe(true);
  });
  it('keeps 1/32 onsets at 240 BPM instead of enforcing a 120 ms gap', () => {
    const result = verify('dense-32nds', synthesize(48000, 10e6, beatTimes(240, 137_321, 10e6, 8)));
    expect(result.tempos.some((c) => Math.abs(c.bpm - 240) < 0.48)).toBe(true);
    expect(result.suggestion).toBeNull(); // A uniform 1920/min pulse train cannot identify musical meter.
    expect(result.warnings).toContain('insufficient-rhythm');
  });
  it('detects drum-like attacks over a sustained tone without repeated tone onsets', () => {
    verify(
      'drums-and-tone',
      synthesize(44100, 16e6, beatTimes(90, 137_321, 16e6), { drum: true, tone: true }),
      90,
      137_321,
    );
    expect(analyzeAudio(synthesize(44100, 8e6, [], { tone: true })).suggestion).toBeNull();
  });
  it('locates both audio boundaries and rejects unusable input rather than emitting NaN times', () => {
    verify('boundary-clicks', synthesize(48000, 2e6, [0, 1_000_000, 1_985_000]));
    expect(() => analyzeAudio({ sampleRate: 0, channels: [new Float32Array(1)] })).toThrow();
    expect(() =>
      analyzeAudio({ sampleRate: 48000, channels: [new Float32Array(1), new Float32Array(2)] }),
    ).toThrow();
    expect(() =>
      analyzeAudio({ sampleRate: 48000, channels: [new Float32Array([NaN])] }),
    ).toThrow();
    expect(() => analyzeAudio(synthesize(48000, 1e6, []), { fftSize: 1000 })).toThrow();
  });
});
