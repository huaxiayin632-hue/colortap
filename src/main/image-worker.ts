import { importImage } from './images/importer';
import type { ImageWorkerRequest } from '../shared/images';

process.parentPort?.once('message', (event: { data: ImageWorkerRequest }) => {
  void importImage(event.data, (phase, completed, total) => {
    process.parentPort?.postMessage({ type: 'progress', phase, completed, total });
  }).then(
    (value) => process.parentPort?.postMessage({ type: 'done', value }),
    (error) =>
      process.parentPort?.postMessage({
        type: 'error',
        error: error instanceof Error ? error.message : String(error),
      }),
  );
});
