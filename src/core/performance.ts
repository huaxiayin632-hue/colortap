export class FrameRecorder {
  private readonly samples: number[] = [];
  private previous: number | undefined;
  private cursor = 0;
  constructor(private readonly capacity = 1200) {}
  frame(timestampMs: number): void {
    if (this.previous !== undefined) {
      const elapsed = timestampMs - this.previous;
      if (elapsed > 0 && elapsed < 10000) {
        if (this.samples.length < this.capacity) this.samples.push(elapsed);
        else this.samples[this.cursor++ % this.capacity] = elapsed;
      }
    }
    this.previous = timestampMs;
  }
  resume(): void {
    this.previous = undefined;
  }
  snapshot() {
    const values = [...this.samples].sort((a, b) => a - b);
    const mean = values.length ? values.reduce((sum, n) => sum + n, 0) / values.length : 0;
    const percentile = (p: number) =>
      values.length ? values[Math.min(values.length - 1, Math.ceil(p * values.length) - 1)] : 0;
    return {
      samples: values.length,
      fps: mean ? 1000 / mean : 0,
      meanMs: mean,
      p95Ms: percentile(0.95),
      p99Ms: percentile(0.99),
      maxMs: values.at(-1) ?? 0,
    };
  }
}
