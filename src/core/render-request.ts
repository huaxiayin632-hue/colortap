/** Coalesce visual changes into one frame. An idle view has no scheduled callback. */
export class RenderRequest {
  private frame = 0;
  private disposed = false;
  constructor(private readonly render: (timestamp: number) => void) {}
  request(): void {
    if (this.disposed || this.frame) return;
    this.frame = requestAnimationFrame((timestamp) => {
      this.frame = 0;
      if (!this.disposed) this.render(timestamp);
    });
  }
  get pending(): boolean {
    return this.frame !== 0;
  }
  dispose(): void {
    this.disposed = true;
    cancelAnimationFrame(this.frame);
    this.frame = 0;
  }
}
