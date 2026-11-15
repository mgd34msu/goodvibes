import type { ForensicsRegistry } from './forensics/index.js';

export interface UiObservabilityReadModelOptions {
  readonly forensicsRegistry?: ForensicsRegistry | undefined;
  /** Clock for retry timing; defaults to `Date.now`. */
  readonly now?: (() => number) | undefined;
}
