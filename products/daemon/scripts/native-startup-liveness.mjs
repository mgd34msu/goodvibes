import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';

// This is the CI observer's finite source-defined inventory, not a runtime
// heartbeat protocol or a product cold-start SLA. Optional stages may be absent.
export const nativeStartupPhases = Object.freeze([
  'runtime-base', 'base-project-context', 'base-credentials', 'base-providers', 'base-knowledge',
  'base-native-intake-storage', 'base-native-intake-ready', 'runtime-base-failed',
  'handler-surfaces', 'contract-recovery', 'provider-preload', 'listener-construction',
  'secondary-listener-construction', 'cluster-startup', 'device-recovery', 'device-grant-sweep',
  'device-capture-sweep', 'device-disclosure-read', 'device-disclosure-persist', 'listener-startup',
  'secondary-listener-startup', 'boot-tasks', 'foreground-ready',
]);
const stallMs = 20_000;

/** Only a first strictly forward fixed phase advances this test-owned clock.
 * Once stalled, late output cannot revive the observation. The injected clock
 * permits deterministic boundary controls; the actual consumer uses monotonic
 * controller time, independent of the daemon's wall clock. */
export function retainNativeStartupProgress(now = () => performance.now()) {
  const started = now(), history = [];
  let lastProgress = started, lastPhase = -1, failed = false, stalled = false;
  let line = '', discard = false;
  const observeTime = () => {
    const current = now();
    if (current - lastProgress >= stallMs) stalled = true;
    return current;
  };
  return {
    append(chunk, requestCount) {
      const current = observeTime();
      for (const character of String(chunk)) {
        if (character !== '\n') {
          if (!discard) { line += character; if (line.length > 128) { line = ''; discard = true; } }
          continue;
        }
        if (!discard) {
          const prefix = '[goodvibes-daemon:native-startup-phase] ';
          const phase = line.startsWith(prefix) ? line.slice(prefix.length) : '';
          const index = nativeStartupPhases.indexOf(phase);
          if (phase === 'runtime-base-failed') failed = true;
          if (index > lastPhase && history.length < nativeStartupPhases.length) {
            history.push(Object.freeze({ phase, delayMs: current - started, requestCount }));
            lastPhase = index;
            if (!stalled && !failed) lastProgress = current;
          }
        }
        line = ''; discard = false;
      }
    },
    snapshot() {
      const current = observeTime();
      return Object.freeze({ elapsedMs: current - started, noProgressMs: current - lastProgress,
        failed, stalled, phases: Object.freeze([...history]) });
    },
  };
}

/** Failure and process lifetime never become progress, even if a ready-looking
 * message was emitted just before the controller observed the exit. */
export function assertNativeStartupActive(progress, { processClosed, requestCount }) {
  assert(!processClosed, 'Native host exited before readiness');
  assert.equal(requestCount, 0, 'Unconfigured native startup made a semantic request');
  assert(!progress.failed, 'Native host reported a failed startup phase');
  assert(!progress.stalled, 'Native host startup made no forward phase progress for 20 seconds');
}

/** Phase observations alone never establish readiness or listener ownership.
 * The consumer must still authenticate status and exercise native memory. */
function isReadyBanner(line, version) {
  return line === `goodvibes-daemon ${version} host started (ready)`
    || line === `goodvibes-daemon ${version} host started (degraded)`;
}

export function hasNativeStartupReadyBanner(output, version) {
  return output.split('\n').some(line => isReadyBanner(line, version));
}

export function assertNativeStartupBanners({ pid, output, version, port }) {
  assert(Number.isSafeInteger(pid) && pid > 0, 'Retain the actual spawned daemon PID');
  const lines = output.trim().split('\n');
  assert(lines[0].startsWith(`goodvibes-daemon ${version} starting:`));
  assert(lines[0].includes(`intended-host="127.0.0.1" intended-port=${port}`));
  const bound = `goodvibes-daemon ${version} bound: host="127.0.0.1" port=${port}`;
  const ready = lines.find(line => isReadyBanner(line, version));
  assert(ready, 'Native host readiness banner is missing');
  assert(lines.includes(bound)); assert(output.indexOf(bound) < output.indexOf(ready));
}
