/** Keep activity moving when the main model's animation timer is stopped. */
export class ActivityAnimation {
  private timer: ReturnType<typeof setInterval> | undefined;
  private intervalMs: number | undefined;
  private disposed = false;
  frame = 0;

  constructor(private readonly render: () => void) {}

  setActive(active: boolean, reduceMotion = false): void {
    if (this.disposed) return;
    if (!active) {
      clearInterval(this.timer);
      this.timer = undefined;
      this.intervalMs = undefined;
      this.frame = 0;
      return;
    }
    // 250ms (4 Hz) keeps the Braille spinner smooth without burning 40%+ CPU redrawing
    // the full terminal 12.5 times/sec while waiting on daemon work; reduceMotion only
    // needs a 1s tick for the elapsed timer.
    const nextIntervalMs = reduceMotion ? 1_000 : 250;
    if (this.timer !== undefined && this.intervalMs === nextIntervalMs) return;
    clearInterval(this.timer);
    this.intervalMs = nextIntervalMs;
    this.timer = setInterval(() => {
      if (this.timer === undefined || this.disposed) return;
      this.frame++;
      this.render();
    }, nextIntervalMs);
    this.timer.unref();
  }

  dispose(): void {
    this.setActive(false);
    this.disposed = true;
  }
}
