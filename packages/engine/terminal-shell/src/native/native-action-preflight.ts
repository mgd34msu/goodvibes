/** Single flight and host/workspace fencing start before any file or discovery IO. */
export interface NativeActionPreflightOptions<Result> {
  readonly busy: () => Result;
  readonly unavailable: () => Result;
  /** Intake detaches immediately; submission holds its flight until cleanup settles. */
  readonly releaseOnClose: boolean;
}
export class NativeActionPreflight<Result> {
  private active: AbortController | undefined;
  constructor(private readonly identity: () => string, private readonly invalidate: () => void, private readonly options: NativeActionPreflightOptions<Result>) {}
  close(): void {
    const active = this.active;
    if (this.options.releaseOnClose) this.active = undefined;
    active?.abort(); this.invalidate();
  }
  async run(action: (signal: AbortSignal, current: () => boolean) => Promise<Result | undefined>): Promise<Result | undefined> {
    if (this.active) return this.options.busy();
    let identity: string;
    try { identity = this.identity(); } catch { return this.options.unavailable(); }
    const controller = new AbortController(); this.active = controller;
    const current = (): boolean => {
      if (controller.signal.aborted) return false;
      try { if (this.identity() === identity) return true; } catch { /* Unresolvable workspace revokes the operation. */ }
      controller.abort(); this.invalidate(); return false;
    };
    const timer = setInterval(current, 100); timer.unref?.();
    try {
      const result = await action(controller.signal, current);
      return current() ? result : undefined;
    } finally { clearInterval(timer); if (this.active === controller) this.active = undefined; }
  }
}
