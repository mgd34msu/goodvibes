/**
 * Test environment preload, loaded by bun:test via bunfig.toml [test].preload.
 *
 * Provides globals that are available in the full runtime but absent in the
 * bare bun:test runner, and removes each test's makeProjectTempDir directories. Add only
 * what is genuinely missing; do NOT mock real platform APIs here.
 */

import { afterEach } from 'bun:test';
import { makeLongLivedProjectTempDir, sweepCreatedProjectTempDirs } from './project-temp.ts';

// Golden fixtures use UTC. Establish it before any test captures/restores TZ:
// Bun 1.3.14 keeps the last zone after deleting process.env.TZ and ignores
// subsequent assignments, so an initially absent TZ can leak a test's zone.
process.env.TZ = 'UTC';

// Ensure fetch is available as a global (bun provides it; this is a no-op in
// most bun versions but guards against environments where it isn't set).
if (typeof globalThis.fetch === 'undefined') {
  // @ts-ignore, bun built-in, not in all type-def bundles
  globalThis.fetch = Bun.fetch;
}

// The real per-test cleanup mechanism for makeProjectTempDir (see that
// function's doc comment in project-temp.ts for why this must be registered
// exactly once, here, rather than lazily inside the helper itself). Preload
// runs before any test file is registered, so this attaches as a true
// global hook, confirmed empirically to fire after every test in every
// file, and to fire AFTER a test file's own local afterEach hooks
// (inner-to-outer, then this one last), which is what makes it safe to run
// the actual directory removal here.
afterEach(async () => {
  await sweepCreatedProjectTempDirs();
});

/**
 * The test suite must never reach a REAL daemon.
 *
 * Config routing discovers a daemon by reading the daemon home: the operator
 * token to present, and the control-plane binding to dial. Left unset, that
 * resolves to `~/.goodvibes/daemon`, the developer's actual daemon, which is
 * usually running. A test run then does not just read the wrong settings, it
 * reaches a live process and can write to it. This is not hypothetical; it has
 * already happened once here.
 *
 * So the suite is pinned to a throwaway daemon home before any test module is
 * imported. The directory is deliberately left EMPTY: discovery finds no token
 * and no binding, concludes there is no daemon, and every daemon-owned path
 * takes its no-daemon branch. A test that genuinely wants a daemon must stand
 * one up itself and point this at it.
 *
 * An explicit value set by the caller still wins, so a harness that has already
 * arranged its own isolation is not overridden.
 */
if (!process.env['GOODVIBES_DAEMON_HOME']?.trim()) {
  // Lands under the run's temp root and goes away with it. Deliberately NOT one of the
  // per-test directories: it must survive every test in every file for the
  // whole run, not just the first test to touch it.
  process.env['GOODVIBES_DAEMON_HOME'] = makeLongLivedProjectTempDir('goodvibes-agent-test-daemon-home');
}
