/**
 * Where the time went inside one operation, step by step.
 *
 * A total says an operation is slow; only a breakdown says which of its awaits
 * to fix. Session setup is the typical case: opening an EiN
 * shell is a dozen sequential VFS round trips and under a crawl each of them
 * waits its turn on a lagging event loop, so the whole is slow while every
 * piece looks innocent. `mark()` after each step and `report()` at the end
 * gives the per-step milliseconds in one log line.
 */
export class StepTimer {
  private readonly steps: Record<string, number> = {};
  private readonly startedAt = performance.now();
  private lastAt = this.startedAt;

  /** Close the step that ran since the previous mark (or since construction). */
  mark(step: string): void {
    const now = performance.now();
    this.steps[step] = Math.round((this.steps[step] ?? 0) + (now - this.lastAt));
    this.lastAt = now;
  }

  /** Total elapsed and every step so far, in whole milliseconds. */
  report(): { totalMs: number; steps: Record<string, number> } {
    return {
      totalMs: Math.round(performance.now() - this.startedAt),
      steps: { ...this.steps },
    };
  }
}
