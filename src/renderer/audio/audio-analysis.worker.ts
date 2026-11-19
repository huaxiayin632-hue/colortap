import { analyzeAudio, type AnalysisParameters, type PcmAudio } from '../../core/audio-analysis';
import type { AnalysisRequest, AnalysisResponse } from './audio-analysis-task';

const scope = self as unknown as Pick<Worker, 'postMessage' | 'onmessage'>;
let audio: PcmAudio | null = null,
  options: Partial<AnalysisParameters> = {};
const post = (message: AnalysisResponse) => scope.postMessage(message);
scope.onmessage = (event: MessageEvent<AnalysisRequest>) => {
  const message = event.data;
  try {
    if (message.type === 'start') {
      options = message.options;
      audio = {
        sampleRate: message.sampleRate,
        channels: Array.from({ length: message.channels }, () => new Float32Array(message.length)),
      };
    } else {
      if (!audio) throw Error('音频 PCM 尚未准备好');
      if (message.type === 'chunk')
        audio.channels[message.channel].set(message.samples, message.offset);
      else {
        let last = -Infinity,
          phase = '';
        const analysis = analyzeAudio(audio, options, (value) => {
          const now = performance.now();
          if (value.phase !== phase || value.fraction === 1 || now - last >= 50) {
            last = now;
            phase = value.phase;
            post({ type: 'progress', value });
          }
        });
        audio = null;
        post({ type: 'done', analysis });
      }
    }
  } catch (error) {
    audio = null;
    post({
      type: 'error',
      message: error instanceof Error ? error.message : '音频分析失败',
    });
  }
};
