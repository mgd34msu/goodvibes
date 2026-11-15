import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';

// The daemon defines its start phases (NATIVE_STARTUP_PHASES in
// src/runtime/startup-observation.ts) and prints each one once. This observer
// records whichever phase tokens arrive, in arrival order, so it keeps no copy
// of that list. It judges states, never timings: the daemon exited, it reported
// a failed start, or it made a semantic request. How long a start may take is
// the consumer's own deadline.
const MARKER_PREFIX = '[goodvibes-daemon:native-startup-phase] ';
const FAILED_PHASE = 'runtime-base-failed';
const PHASE_TOKEN = /^[a-z][a-z0-9-]{0,63}$/;
const MAX_PHASES = 64;

/** The clock is injectable so a caller can report deterministic delays. */
export function retainNativeStartupProgress(now = () => performance.now()) {
  const started = now(), history = [], seen = new Set();
  let failed = false;
  let line = '', discard = false;
  return {
    append(chunk, requestCount) {
      const current = now();
      for (const character of String(chunk)) {
        if (character !== '\n') {
          if (!discard) { line += character; if (line.length > 128) { line = ''; discard = true; } }
          continue;
        }
        if (!discard && line.startsWith(MARKER_PREFIX)) {
          const phase = line.slice(MARKER_PREFIX.length);
          if (phase === FAILED_PHASE) failed = true;
          if (PHASE_TOKEN.test(phase) && !seen.has(phase) && history.length < MAX_PHASES) {
            seen.add(phase);
            history.push(Object.freeze({ phase, delayMs: current - started, requestCount }));
          }
        }
        line = ''; discard = false;
      }
    },
    snapshot() {
      return Object.freeze({ elapsedMs: now() - started, failed, phases: Object.freeze([...history]) });
    },
  };
}

/** Failure and process lifetime never become progress, even if a ready-looking
 * message was emitted just before the controller observed the exit. */
export function assertNativeStartupActive(progress, { processClosed, requestCount }) {
  assert(!processClosed, 'Native host exited before readiness');
  assert.equal(requestCount, 0, 'Unconfigured native startup made a semantic request');
  assert(!progress.failed, 'Native host reported a failed startup phase');
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
