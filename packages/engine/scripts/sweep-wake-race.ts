/**
 * Sweep every fake-IMAP suite for the lost-wake race, by measurement.
 *
 * ## The race
 *
 * `runIdleRound` records `IDLE` on the fake SERVER one round trip before the
 * client registers the waiter that ends the round (`waitForUntagged`, inside
 * `waitForWake`). A test that reads `mailbox.commands` to decide the watcher is
 * listening, then pushes a one-shot wake edge, `deliver()`, `expunge()`, a
 * bare `push()`, can land that edge in the gap, where only the collector sees
 * it and nothing can act on it. Recovery is the 27-minute IDLE re-issue, which
 * these suites run on a `FakeClock` they never advance, so the wait never
 * completes at all. It is a hard timeout, not slowness, and no deadline fixes
 * it. `nudgeUntil` in `test/_helpers/inbound-watcher-harness.ts` is the remedy.
 *
 * ## Why this is a script and not a lint rule
 *
 * Because the source signature is narrower than the defect, and has already
 * been trusted twice and been wrong twice. Grepping for "pushes an untagged
 * line after reading `commands`" finds neither `deliver()` nor `expunge()`,
 * which announce for themselves, nor a test that reaches IDLE through a helper.
 * The only reliable detector is to widen the window and see what stops passing.
 *
 * `watcherConnectionPort` does the widening from the test side, it delays the
 * one `waitForUntagged` call by `GOODVIBES_WAKE_RACE_PROBE_MS`, so the sweep
 * needs no patch to `idle-watcher.ts`, which is how both previous sweeps were
 * run and why neither was repeatable.
 *
 * ## Usage
 *
 *   bun scripts/sweep-wake-race.ts              # sweep at the default delay
 *   bun scripts/sweep-wake-race.ts --delay 100  # a wider window
 *
 * Exits 0 when every suite passes with the window widened, 1 otherwise. A
 * failure keeps the complete test output. A failure under perturbation is not
 * by itself evidence of a lost wake: setup, assertions, cancellation and the
 * runner can fail too. Diagnose the reported condition before changing a
 * fixture; do not replace a missing wake with a longer deadline.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runBunTest } from './test.ts';

const ENGINE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** Long enough to open the window reliably on a loaded 2-vCPU runner. */
const DEFAULT_DELAY_MS = 50;

/**
 * Every suite that drives the fake IMAP server. Discovered, not listed: a
 * hand-maintained list is how the last sweep missed a file that arrived from
 * another branch after the list was written.
 */
export async function runWakeRaceSweep(engineCheckoutRoot: string, delayMs: number): Promise<number> {
  if (!Number.isFinite(delayMs) || delayMs <= 0) {
    console.error('sweep-wake-race: --delay needs a positive number of milliseconds');
    return 1;
  }
  const testDir = join(engineCheckoutRoot, 'test');
  const suites = readdirSync(testDir)
    .filter((name) => name.endsWith('.test.ts'))
    .filter((name) => readFileSync(join(testDir, name), 'utf8').includes('fake-imap-mailbox'))
    .sort();

  if (suites.length === 0) {
    console.error('sweep-wake-race: found no suites importing fake-imap-mailbox, the discovery is broken, not the suites');
    return 1;
  }

  /**
   * A suite that builds a watcher on the raw port is swept WITHOUT the probe, so
   * it would pass whatever it carried. That is the one failure mode this sweep
   * cannot see by measurement, so it is checked by reading instead.
   *
   * Opening a connection directly, `probe-roundtrip-count.test.ts` counts round
   * trips on one `open()`, and one test in the watcher suite reads
   * `bodyCapability` off a connection it closes immediately, runs no IDLE round
   * and has no window to widen, so only the watcher-building form is required to
   * go through the harness.
   */
  const WATCHER_CONSTRUCTION = /connections:\s*imapMailboxConnectionPort\(/;

  const unprobed = suites.filter((name) =>
    WATCHER_CONSTRUCTION.test(readFileSync(join(testDir, name), 'utf8')));

  if (unprobed.length > 0) {
    console.error('sweep-wake-race: these suites build a watcher on the raw connection port,');
    console.error('so the probe never reaches them and sweeping them proves nothing:');
    for (const name of unprobed) console.error(`  test/${name}`);
    console.error('Build the watcher with watcherConnectionPort() from test/_helpers/inbound-watcher-harness.ts.');
    return 1;
  }

  console.log(`sweep-wake-race: ${String(suites.length)} suites, ${String(delayMs)} ms window\n`);

  const failed: string[] = [];
  for (const name of suites) {
    console.log(`  run   test/${name}`);
    const exitCode = await runBunTest({
      // Keep the original per-test ceiling: a longer one could turn an
      // existing failure green.
      args: ['--timeout=5000', `test/${name}`],
      cwd: engineCheckoutRoot,
      // The isolation allowlist drops this inherited variable. Declare it as
      // fixture input so the sweep cannot become a silent no-op.
      fixtureEnv: { GOODVIBES_WAKE_RACE_PROBE_MS: String(delayMs) },
    });
    if (exitCode === 0) {
      console.log(`  ok    test/${name}`);
      continue;
    }
    failed.push(name);
    console.error(`  FAIL  test/${name}: exited with code ${String(exitCode)}`);
    // 128+ means a signal ended it; do not launch another child.
    if (exitCode > 128) return 1;
  }

  if (failed.length > 0) {
    console.error(`\nsweep-wake-race: ${String(failed.length)} suite(s) failed under the ${String(delayMs)} ms probe.`);
    console.error('Full child output is preserved above; a failure does not by itself establish a lost-wake race.');
    return 1;
  }
  console.log(`\nsweep-wake-race: clean, every suite survives a ${String(delayMs)} ms window.`);
  return 0;
}

if (import.meta.main) {
  const delayArg = process.argv.indexOf('--delay');
  const delayMs = delayArg === -1 ? DEFAULT_DELAY_MS : Number(process.argv[delayArg + 1]);
  process.exitCode = await runWakeRaceSweep(ENGINE_ROOT, delayMs);
}
