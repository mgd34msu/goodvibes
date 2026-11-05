/**
 * Format elapsed time (in milliseconds) as a compact human-readable string.
 *
 * Ranges:
 *   < 1 second  → "0.Xs"   (one decimal, e.g. "0.4s")
 *   1-59s       → "Xs"     (e.g. "3s", "59s")
 *   1m-59m59s   → "Xm YYs" (e.g. "1m04s", "59m59s")
 *   ≥ 1 hour    → "Xh YYm" (e.g. "1h02m")
 *
 * Used by the thinking indicator and live tool timer.
 */
export function formatElapsed(ms: number): string {
  if (ms < 0) ms = 0;
  if (ms < 1000) {
    // Truncate (not round) to one decimal so 999ms stays "0.9s" not "1.0s".
    return `${(Math.floor(ms / 100) / 10).toFixed(1)}s`;
  }
  const totalSecs = Math.floor(ms / 1000);
  if (totalSecs < 60) {
    return `${totalSecs}s`;
  }
  const totalMins = Math.floor(totalSecs / 60);
  if (totalMins < 60) {
    const remSecs = totalSecs % 60;
    return `${totalMins}m${String(remSecs).padStart(2, '0')}s`;
  }
  const hours = Math.floor(totalMins / 60);
  const remMins = totalMins % 60;
  return `${hours}h${String(remMins).padStart(2, '0')}m`;
}

/**
 * Parametrised number abbreviation helper.
 *
 * Each call site can reproduce its exact current output by passing the
 * appropriate options rather than a single "agreed" format being imposed.
 *
 * Ranges (default opts: guard=1_000, decimals=1, rounding='fixed'):
 *   n <  guard          → String(n)            e.g. 999  → '999'
 *   n <  1_000_000      → X.Xk                 e.g. 1500 → '1.5k'
 *   n <  1_000_000_000  → X.XM                 e.g. 1.5M → '1.5M'
 *   (with bSuffix)      → X.XB / X.XT
 *   (with noM)          → always k, never M
 */

export interface AbbreviateCountOpts {
  /**
   * Values strictly below this are returned as-is via String(n).
   * Default: 1_000
   */
  guard?: number;
  /**
   * Decimal places used for the k suffix (and for M when mDecimals is not set).
   * Default: 1
   */
  decimals?: number;
  /**
   * Override decimal places for the M suffix only.
   * Default: same as decimals.
   */
  mDecimals?: number;
  /**
   * 'fixed'  → value.toFixed(decimals)  (default)
   * 'round'  → String(Math.round(value)), always integer, decimals ignored
   */
  rounding?: 'fixed' | 'round';
  /**
   * When true, extend formatting to B (billions) and T (trillions).
   * Default: false
   */
  bSuffix?: boolean;
  /**
   * When true, never produce M/B/T, format as k even for millions.
   * Default: false
   */
  noM?: boolean;
}

/**
 * Format a non-negative integer with k/M/B/T magnitude suffix.
 *
 * Preserves each call site's exact current format by accepting
 * per-site option overrides (guard, decimals, rounding, etc.).
 */
export function abbreviateCount(n: number, opts?: AbbreviateCountOpts): string {
  const guard     = opts?.guard     ?? 1_000;
  const decimals  = opts?.decimals  ?? 1;
  const mDecimals = opts?.mDecimals ?? decimals;
  const rounding  = opts?.rounding  ?? 'fixed';
  const noM       = opts?.noM       ?? false;
  const bSuffix   = opts?.bSuffix   ?? false;

  /** Render a scaled value according to the configured rounding mode. */
  const fmt = (val: number, d: number): string =>
    rounding === 'round' ? String(Math.round(val)) : val.toFixed(d);

  if (n < guard)                      return String(n);
  if (noM || n < 1_000_000)           return fmt(n / 1_000, decimals)          + 'k';
  if (!bSuffix || n < 1_000_000_000)  return fmt(n / 1_000_000, mDecimals)     + 'M';
  if (n < 1_000_000_000_000)          return fmt(n / 1_000_000_000, decimals)  + 'B';
  return                                     fmt(n / 1_000_000_000_000, decimals) + 'T';
}
