// Serializable analysis values. PCM, Workers and editor state never belong here.
export interface AnalysisParameters {
  fftSize: number;
  hopSize: number;
  minOnsetIntervalUs: number;
  peakThreshold: number;
  minBpm: number;
  maxBpm: number;
  tempoWindowUs: number;
}
export interface DetectedOnset {
  timeUs: number;
  /** Relative spectral novelty, not a probability. */
  strength: number;
}
export interface TempoCandidate {
  bpm: number;
  /** Grid phase modulo one beat; does not identify a musical downbeat. */
  phaseUs: number;
  anchorUs: number;
  /** Grid coverage and timing consistency, not a probability. */
  support: number;
  matchedOnsets: number;
  meanErrorUs: number;
}
export interface AudioAnalysis {
  algorithm: string;
  sampleRate: number;
  sampleCount: number;
  channels: number;
  durationUs: number;
  parameters: AnalysisParameters;
  onsets: DetectedOnset[];
  tempos: TempoCandidate[];
  suggestion: TempoCandidate | null;
  regions: { startUs: number; endUs: number; tempos: TempoCandidate[] }[];
  quietRegions: { startUs: number; endUs: number }[];
  warnings: ('quiet-audio' | 'insufficient-rhythm' | 'tempo-change' | 'metrical-ambiguity')[];
}
export interface MusicAnalysis {
  sourceSha256: string;
  result: AudioAnalysis;
}
