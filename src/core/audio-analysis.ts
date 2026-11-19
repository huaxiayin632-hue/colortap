import FFT from 'fft.js';
import type {
  AnalysisParameters,
  AudioAnalysis,
  DetectedOnset,
  TempoCandidate,
} from '../shared/audio-analysis';
export type {
  AnalysisParameters,
  AudioAnalysis,
  DetectedOnset,
  TempoCandidate,
} from '../shared/audio-analysis';

// Spectral flux, adaptive peak picking and onset autocorrelation follow librosa's
// onset.py / feature/rhythm.py. This is a smaller implementation with different
// features and timing refinement, not librosa-equivalent output. See THIRD_PARTY_NOTICES.md.
export const AUDIO_ANALYSIS_VERSION = 'spectral-flux-v1';
export interface PcmAudio {
  sampleRate: number;
  channels: readonly Float32Array[];
}
export const defaultAnalysisParameters: Readonly<AnalysisParameters> = {
  fftSize: 2048,
  hopSize: 128,
  minOnsetIntervalUs: 20_000,
  peakThreshold: 0.06,
  minBpm: 40,
  maxBpm: 260,
  tempoWindowUs: 8_000_000,
};
export interface AnalysisProgress {
  phase: 'copy' | 'spectrum' | 'rhythm';
  fraction: number;
}
const mod = (a: number, b: number) => ((a % b) + b) % b;
const round = (value: number) => Math.round(value * 1e6) / 1e6;
const octaveDifference = (a: number, b: number) => {
  const octaves = Math.log2(a / b);
  return Math.abs(octaves - Math.round(octaves));
};

/** Refine a spectral candidate at the strongest local power rise, in sample coordinates.
 * No empirical frame delay is added to the song's Offset. Channels combine as power. */
function refineOnset(audio: PcmAudio, center: number, radius: number): number {
  const length = audio.channels[0].length,
    width = Math.max(1, Math.round(audio.sampleRate * 0.001)),
    low = Math.max(0, center),
    high = Math.min(length - 1, center + radius);
  const power = (at: number) => {
    if (at < 0 || at >= length) return 0;
    let sum = 0;
    for (const channel of audio.channels) sum += channel[at] ** 2;
    return sum;
  };
  let before = 0,
    after = 0;
  for (let i = 0; i < width; i++) {
    before += power(low - width + i);
    after += power(low + i);
  }
  let best = low,
    bestRise = -Infinity;
  for (let at = low; at <= high; at++) {
    const rise = after - before;
    if (rise >= bestRise) {
      best = at;
      bestRise = rise;
    }
    before += power(at) - power(at - width);
    after += power(at + width) - power(at);
  }
  return best;
}

function detectOnsets(
  audio: PcmAudio,
  p: AnalysisParameters,
  progress?: (value: AnalysisProgress) => void,
) {
  const length = audio.channels[0].length,
    frames = Math.ceil(length / p.hopSize) + 1,
    flux = new Float64Array(frames),
    energy = new Float64Array(frames),
    fft = new FFT(p.fftSize),
    input = new Float64Array(p.fftSize),
    spectrum = fft.createComplexArray(),
    bins = p.fftSize / 2 + 1,
    window = Float64Array.from(
      { length: p.fftSize },
      (_, i) => 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / p.fftSize),
    );
  // One channel at a time retains only its previous spectrum. Never downmix signed samples.
  for (let channelIndex = 0; channelIndex < audio.channels.length; channelIndex++) {
    const channel = audio.channels[channelIndex],
      previous = new Float64Array(bins);
    for (let frame = 0; frame < frames; frame++) {
      const start = frame * p.hopSize - p.fftSize / 2;
      let power = 0;
      for (let i = 0; i < p.fftSize; i++) {
        const at = start + i,
          sample = at >= 0 && at < length ? channel[at] : 0;
        if (!Number.isFinite(sample)) throw Error('音频包含无效 PCM 样本');
        input[i] = sample * window[i];
        power += sample * sample;
      }
      energy[frame] = Math.max(energy[frame], power / p.fftSize);
      fft.realTransform(spectrum, input);
      let novelty = 0;
      for (let bin = 1; bin < bins; bin++) {
        const magnitude = Math.hypot(spectrum[bin * 2], spectrum[bin * 2 + 1]) / p.fftSize,
          log = Math.log1p(1000 * magnitude);
        novelty += Math.max(0, log - previous[bin]);
        previous[bin] = log;
      }
      flux[frame] = Math.max(flux[frame], novelty / bins);
      if (frame % 256 === 0)
        progress?.({
          phase: 'spectrum',
          fraction: (channelIndex + frame / frames) / audio.channels.length,
        });
    }
  }
  let maximum = 0;
  for (const value of flux) maximum = Math.max(maximum, value);
  const onsets: DetectedOnset[] = [],
    frameUs = (p.hopSize * 1e6) / audio.sampleRate;
  if (maximum > 1e-8) {
    const average = new Float64Array(frames + 1),
      maxRadius = Math.max(1, Math.round((0.01 * audio.sampleRate) / p.hopSize)),
      avgRadius = Math.max(1, Math.round((0.1 * audio.sampleRate) / p.hopSize));
    for (let i = 0; i < frames; i++) {
      flux[i] /= maximum;
      average[i + 1] = average[i] + flux[i];
    }
    for (let i = 0; i < frames; i++) {
      const low = Math.max(0, i - avgRadius),
        high = Math.min(frames, i + avgRadius + 1),
        mean = (average[high] - average[low]) / (high - low);
      if (flux[i] < mean + p.peakThreshold || energy[i] < 1e-10) continue;
      let peak = true;
      for (let j = Math.max(0, i - maxRadius); j <= Math.min(frames - 1, i + maxRadius); j++)
        if (flux[j] > flux[i] || (j < i && flux[j] === flux[i])) {
          peak = false;
          break;
        }
      if (!peak) continue;
      onsets.push({
        timeUs: Math.round(
          (refineOnset(audio, i * p.hopSize, p.fftSize / 2) * 1e6) / audio.sampleRate,
        ),
        strength: round(flux[i]),
      });
    }
  }
  onsets.sort((a, b) => a.timeUs - b.timeUs);
  const filtered: DetectedOnset[] = [];
  for (const onset of onsets) {
    const previous = filtered.at(-1);
    if (previous && onset.timeUs - previous.timeUs < p.minOnsetIntervalUs) {
      if (onset.strength > previous.strength) filtered[filtered.length - 1] = onset;
    } else filtered.push(onset);
  }
  const quietRegions: AudioAnalysis['quietRegions'] = [];
  let quietStart = -1;
  for (let i = 0; i <= frames; i++) {
    if (i < frames && energy[i] < 1e-8) {
      if (quietStart < 0) quietStart = i;
    } else if (quietStart >= 0) {
      const startUs = Math.round(quietStart * frameUs),
        endUs = Math.min(Math.round(i * frameUs), Math.round((length * 1e6) / audio.sampleRate));
      if (endUs - startUs >= 2e6) quietRegions.push({ startUs, endUs });
      quietStart = -1;
    }
  }
  progress?.({ phase: 'spectrum', fraction: 1 });
  return { onsets: filtered, quietRegions };
}

function fitTempo(onsets: readonly DetectedOnset[], initialPeriod: number): TempoCandidate | null {
  let period = initialPeriod;
  const binCount = Math.ceil(period / 5000),
    phaseBins = new Float64Array(binCount);
  for (const onset of onsets)
    phaseBins[
      Math.min(binCount - 1, Math.floor((mod(onset.timeUs, period) / period) * binCount))
    ] += Math.sqrt(onset.strength);
  let peak = 0,
    peakValue = 0;
  for (let i = 0; i < binCount; i++) {
    const value =
      phaseBins[mod(i - 1, binCount)] + 2 * phaseBins[i] + phaseBins[(i + 1) % binCount];
    if (value > peakValue) {
      peak = i;
      peakValue = value;
    }
  }
  let phase = ((peak + 0.5) * period) / binCount;
  const matches = () =>
    onsets
      .map((onset) => ({ onset, beat: Math.round((onset.timeUs - phase) / period) }))
      .filter(
        ({ onset, beat }) =>
          Math.abs(onset.timeUs - phase - beat * period) <= Math.max(15_000, period * 0.06),
      );
  for (let pass = 0; pass < 3; pass++) {
    const selected = matches();
    if (selected.length < 4) return null;
    let weight = 0,
      meanBeat = 0,
      meanTime = 0;
    for (const { onset, beat } of selected) {
      const w = Math.sqrt(onset.strength);
      weight += w;
      meanBeat += beat * w;
      meanTime += onset.timeUs * w;
    }
    meanBeat /= weight;
    meanTime /= weight;
    let covariance = 0,
      variance = 0;
    for (const { onset, beat } of selected) {
      const w = Math.sqrt(onset.strength);
      covariance += w * (beat - meanBeat) * (onset.timeUs - meanTime);
      variance += w * (beat - meanBeat) ** 2;
    }
    const refined = covariance / variance;
    if (!(refined > 0) || Math.abs(refined / initialPeriod - 1) > 0.03) return null;
    period = refined;
    phase = mod(meanTime - period * meanBeat, period);
  }
  const selected = matches(),
    beats = new Set(selected.map((m) => m.beat)),
    expected = Math.max(
      1,
      Math.floor((onsets.at(-1)!.timeUs - phase) / period) -
        Math.ceil((onsets[0].timeUs - phase) / period) +
        1,
    ),
    meanErrorUs =
      selected.reduce(
        (sum, { onset, beat }) => sum + Math.abs(onset.timeUs - phase - beat * period),
        0,
      ) / selected.length,
    coverage = Math.sqrt((selected.length / onsets.length) * Math.min(1, beats.size / expected));
  return {
    bpm: round(60e6 / period),
    phaseUs: Math.round(phase),
    anchorUs: selected[0].onset.timeUs,
    support: round(coverage * Math.exp(-meanErrorUs / 15_000)),
    matchedOnsets: selected.length,
    meanErrorUs: Math.round(meanErrorUs),
  };
}

/** Sparse autocorrelation of detected onset impulses. Pair lags are bounded by minBpm;
 * unlike a full tempogram this stores neither a song-sized spectrum nor a frame matrix. */
function tempoCandidates(
  onsets: readonly DetectedOnset[],
  p: AnalysisParameters,
  frameUs: number,
): TempoCandidate[] {
  if (onsets.length < 4) return [];
  const minimum = 60e6 / p.maxBpm,
    maximum = 60e6 / p.minBpm,
    size = Math.ceil(maximum / frameUs) + 2,
    weights = new Float64Array(size),
    moments = new Float64Array(size);
  for (let i = 0; i < onsets.length; i++)
    for (let j = i + 1; j < onsets.length; j++) {
      const delta = onsets[j].timeUs - onsets[i].timeUs;
      if (delta > maximum + frameUs) break;
      if (delta < minimum - frameUs) continue;
      const bin = delta / frameUs,
        low = Math.floor(bin),
        fraction = bin - low,
        weight = Math.sqrt(onsets[i].strength * onsets[j].strength);
      for (const [at, part] of [
        [low, 1 - fraction],
        [low + 1, fraction],
      ]) {
        if (at >= size) continue;
        weights[at] += weight * part;
        moments[at] += delta * weight * part;
      }
    }
  const peaks: { period: number; weight: number }[] = [];
  for (let i = 1; i < size - 1; i++) {
    if (weights[i] <= weights[i - 1] || weights[i] < weights[i + 1]) continue;
    const weight = weights[i - 1] + weights[i] + weights[i + 1];
    if (weight < 2) continue;
    const period = (moments[i - 1] + moments[i] + moments[i + 1]) / weight;
    if (period >= minimum && period <= maximum) peaks.push({ period, weight });
  }
  peaks.sort((a, b) => b.weight - a.weight);
  const candidates: TempoCandidate[] = [];
  const add = (period: number) => {
    if (
      period < minimum ||
      period > maximum ||
      candidates.some((c) => Math.abs(60e6 / c.bpm / period - 1) < 0.01)
    )
      return;
    const candidate = fitTempo(onsets, period);
    if (candidate && candidate.bpm >= p.minBpm && candidate.bpm <= p.maxBpm)
      candidates.push(candidate);
  };
  for (const peak of peaks.slice(0, 12)) add(peak.period);
  for (const candidate of candidates.slice(0, 3)) {
    add(120e6 / candidate.bpm);
    add(30e6 / candidate.bpm);
  }
  return candidates
    .sort((a, b) => b.support - a.support || a.meanErrorUs - b.meanErrorUs || a.bpm - b.bpm)
    .slice(0, 5);
}

/** Pure PCM analysis. It never reads or modifies a project, clock or chart. Run in a Worker. */
export function analyzeAudio(
  audio: PcmAudio,
  options: Partial<AnalysisParameters> = {},
  progress?: (value: AnalysisProgress) => void,
): AudioAnalysis {
  const p = { ...defaultAnalysisParameters, ...options },
    length = audio.channels[0]?.length ?? 0;
  if (
    !(audio.sampleRate > 0) ||
    !Number.isFinite(audio.sampleRate) ||
    !audio.channels.length ||
    audio.channels.some((channel) => channel.length !== length)
  )
    throw Error('音频采样率或声道长度无效');
  if (
    !Number.isInteger(p.fftSize) ||
    p.fftSize < 128 ||
    p.fftSize > 8192 ||
    p.fftSize & (p.fftSize - 1) ||
    !Number.isInteger(p.hopSize) ||
    p.hopSize < 1 ||
    p.hopSize > p.fftSize / 2 ||
    !(p.minBpm >= 20 && p.maxBpm > p.minBpm && p.maxBpm <= 1000) ||
    !(p.peakThreshold >= 0 && p.peakThreshold <= 1) ||
    !(p.minOnsetIntervalUs >= 0) ||
    !(p.tempoWindowUs >= 2e6)
  )
    throw Error('音频分析参数无效');
  const durationUs = Math.round((length * 1e6) / audio.sampleRate),
    { onsets, quietRegions } = detectOnsets(audio, p, progress),
    frameUs = (p.hopSize * 1e6) / audio.sampleRate,
    tempos = tempoCandidates(onsets, p, frameUs),
    regions: AudioAnalysis['regions'] = [];
  let cursor = 0;
  for (let startUs = 0; startUs < durationUs; startUs += p.tempoWindowUs) {
    const endUs = Math.min(durationUs, startUs + p.tempoWindowUs),
      first = cursor;
    while (cursor < onsets.length && onsets[cursor].timeUs < endUs) cursor++;
    regions.push({
      startUs,
      endUs,
      tempos: tempoCandidates(onsets.slice(first, cursor), p, frameUs).slice(0, 3),
    });
    progress?.({ phase: 'rhythm', fraction: endUs / durationUs });
  }
  const stable = regions.map((r) => r.tempos[0]).filter((t) => t && t.support >= 0.65),
    changed = stable.some((t) => octaveDifference(t.bpm, stable[0].bpm) > Math.log2(1.03)),
    suggestion = !changed && tempos[0]?.support >= 0.55 ? tempos[0] : null,
    warnings: AudioAnalysis['warnings'] = [];
  if (quietRegions.length) warnings.push('quiet-audio');
  if (!tempos.length || tempos[0].support < 0.55) warnings.push('insufficient-rhythm');
  if (changed) warnings.push('tempo-change');
  if (
    tempos.some(
      (t, i) =>
        i > 0 &&
        octaveDifference(t.bpm, tempos[0].bpm) < 0.02 &&
        t.support >= tempos[0].support * 0.8,
    )
  )
    warnings.push('metrical-ambiguity');
  progress?.({ phase: 'rhythm', fraction: 1 });
  return {
    algorithm: AUDIO_ANALYSIS_VERSION,
    sampleRate: audio.sampleRate,
    sampleCount: length,
    channels: audio.channels.length,
    durationUs,
    parameters: p,
    onsets,
    tempos,
    suggestion,
    regions,
    quietRegions,
    warnings,
  };
}
