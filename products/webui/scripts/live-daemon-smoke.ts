/**
 * live-daemon-smoke.ts, exercise the webui's own transport + stream code against a REAL
 * daemon process, not mocks.
 *
 * WHY A SEPARATE LANE: the default `bun test` unit lane is hermetic (happy-dom + in-page
 * mocks) and must stay that way. This lane boots a real daemon from the local engine dev-link
 * (bootDaemon: isolated home, ephemeral loopback port, bearer-token auth), points the
 * webui's actual engine client (src/lib/goodvibes.ts) at it, and drives a minimal session
 * round-trip end to end, proving the real request/response and Server-Sent-Event paths
 * work against a genuine daemon. It is wired as `bun run test:live`, NOT under the default
 * test glob, so the unit lane never spawns a process.
 *
 * It is deliberately model-free: it creates and lists a session and opens the live event
 * stream (all real daemon state), so it needs no provider credential and runs green offline.
 * Sending a message that requires an LLM turn is out of scope here precisely because that
 * WOULD need an external credential.
 *
 * Run: `bun run test:live`
 */
import assert from 'node:assert/strict';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { bootDaemon, type BootedDaemon } from '@goodvibes-jev/engine/platform/daemon';
import { installTestTempRoot, sweepStaleRunRoots } from './test-temp-root';
import { requireSessionCloseReceipt } from './live-daemon-lifecycle';

// The webui token store (createBrowserTokenStore) persists to localStorage. In this headless
// lane there is no browser, so provide a minimal in-memory localStorage BEFORE importing the
// webui client (which constructs the token store at module evaluation).
if (typeof (globalThis as { localStorage?: unknown }).localStorage === 'undefined') {
  const store = new Map<string, string>();
  (globalThis as { localStorage?: unknown }).localStorage = {
    getItem: (key: string) => (store.has(key) ? store.get(key)! : null),
    setItem: (key: string, value: string) => void store.set(key, String(value)),
    removeItem: (key: string) => void store.delete(key),
    clear: () => store.clear(),
    key: (index: number) => Array.from(store.keys())[index] ?? null,
    get length() {
      return store.size;
    },
  };
}

const TOKEN = 'live-smoke-bearer-token';
const SESSION_TITLE = `live-smoke-${Date.now()}`;

function log(step: string): void {
  process.stdout.write(`  • ${step}\n`);
}

// One wire shape, the one the typed client and the generated facade rely on:
// sessions.create -> { session: { id } }, sessions.list -> { sessions: [{ id }] }.
// Accepting alternatives here would let a shape change pass this lane while the
// app's own client broke against the same daemon.
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function createdSessionId(value: unknown): string {
  assert.ok(isRecord(value) && isRecord(value.session), 'sessions.create returns { session: { id } }');
  const id = value.session.id;
  assert.ok(typeof id === 'string' && id !== '', 'sessions.create returns a session with a string id');
  return id;
}

function listedSessionIds(value: unknown): string[] {
  assert.ok(isRecord(value) && Array.isArray(value.sessions), 'sessions.list returns { sessions: [...] }');
  return value.sessions.flatMap((entry) => (isRecord(entry) && typeof entry.id === 'string' ? [entry.id] : []));
}

/**
 * Scratch space for this lane.
 *
 * This lane boots a REAL daemon with its own home directory, so what it creates
 * is not a couple of empty directories, it is a full daemon tree. It used to
 * put both under the system temp directory, cleaned by a `finally` block. That
 * covers a run that finishes (pass or fail) and nothing else: interrupt it with
 * Ctrl-C or let CI time it out and both trees stayed in the system temp with
 * nobody to remove them.
 *
 * Now both live under one parent inside the repo's gitignored `.test-tmp/run-<pid>`.
 * The smoke removes it once, after the daemon has stopped: a stopped daemon ends
 * the activity log it named, so nothing writes under the tree afterwards. A run
 * interrupted by a signal stops the daemon and removes it the same way; a run
 * killed outright is reaped by sweepStaleRunRoots() at the start of the next run.
 * One parent directory instead of two siblings also means a failure BETWEEN the
 * two creations can no longer strand the first one.
 *
 * ROOTING A REAL-DAEMON SCRATCH TREE INSIDE THE CHECKOUT IS NOT FREE, and was
 * checked rather than assumed. goodvibes's own repo hit a real bug from the
 * same move: a tool walked upward from an in-repo test fixture looking for
 * `tsconfig.json`, found the REAL repo's tsconfig sitting above it instead of
 * finding none, and corrupted that test's expectations. Why that cannot happen
 * here:
 *   - ConfigManager (@goodvibes-jev/engine/platform dist/platform/config/manager.js)
 *     builds settings.json paths by joining directly under the given
 *     workingDir/homeDirectory. It never walks upward.
 *   - Nothing in bootDaemon's construction/start path (dist/platform/daemon/
 *     boot.js, facade.js, facade-composition.js) calls `detectProject`
 *     (dist/platform/tools/inspect/project.js, the function that reads
 *     package.json/tsconfig.json). That function is reached only from the
 *     "inspect project" agent tool's executor, and this smoke is deliberately
 *     model-free: it never drives an agent turn, a tool call, or a hook.
 *   - Measured against the real (unlinked, npm) package: the only file the
 *     daemon wrote under the scratch dir was its own
 *     `.goodvibes/logs/activity.md`.
 * The third bullet is what makes the in-repo root safe TODAY. If this smoke
 * ever starts driving real tool or hook invocations, it reaches the
 * upward-walking path and this decision has to be re-made, that is the one
 * change to this file that must not be waved through.
 */
const RUN_ROOT = installTestTempRoot();

function removeRunRoot(): void {
  rmSync(RUN_ROOT, { recursive: true, force: true });
}

async function main(): Promise<void> {
  sweepStaleRunRoots();
  const home = join(RUN_ROOT, 'daemon-home');
  const work = join(RUN_ROOT, 'workdir');
  mkdirSync(home, { recursive: true });
  mkdirSync(work, { recursive: true });
  let daemon: BootedDaemon | null = null;

  // An interrupted run must not strand a daemon tree. Ctrl-C and a CI timeout
  // kill arrive as signals; without a handler the process dies before any
  // `finally` or exit hook gets to remove the tree, which is the interrupt case
  // the original code had no answer for at all.
  const onSignal = (signal: NodeJS.Signals) => {
    void (async () => {
      try {
        if (daemon) await daemon.stop();
      } finally {
        removeRunRoot();
        process.stderr.write(`\nLive-daemon smoke: interrupted by ${signal}; scratch removed\n`);
        process.exit(130);
      }
    })();
  };
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);

  try {
    process.stdout.write('Live-daemon smoke\n');
    // The daemon eagerly constructs its builtin model providers at boot, and some provider
    // SDKs (e.g. OpenAI) refuse to even CONSTRUCT without an api key present. This lane never
    // makes a model call, it only exercises sessions + streaming, so a placeholder key that
    // satisfies construction is honest here: no request is ever sent to any provider.
    for (const key of ['OPENAI_API_KEY', 'OPENAI_ADMIN_KEY', 'ANTHROPIC_API_KEY']) {
      if (!process.env[key]) process.env[key] = 'live-smoke-placeholder-unused';
    }
    log('booting a real daemon (isolated home, ephemeral loopback port)…');
    daemon = await bootDaemon({ homeDirectory: home, workingDir: work, port: 0, token: TOKEN });
    log(`daemon up at ${daemon.url}`);

    // Point the webui's engine client at the real daemon, THEN import it (it reads the base URL
    // at module evaluation). A loopback http origin is a secure context, so the engine transport
    // guard does not fire.
    process.env.VITE_GOODVIBES_BASE_URL = daemon.url;
    const { client: engine } = await import('../src/lib/goodvibes');
    const { SESSION_UPDATE_WIRE_EVENT } = await import('../src/lib/sessions-union');
    await engine.auth.setToken(TOKEN);

    // 1) A real authenticated request/response round-trip through the webui client.
    log('control.status round-trip…');
    const status = await engine.operator.control.status();
    assert.ok(status && typeof status === 'object', 'control.status returned a snapshot object');

    // 2) A real mutating round-trip: create a session, then read it back from the list.
    log('creating a session…');
    const created = await engine.operator.invoke('sessions.create', { title: SESSION_TITLE });
    const createdId = createdSessionId(created);

    log('listing sessions and asserting the new one is present…');
    const listed = await engine.operator.invoke('sessions.list', {});
    const found = listedSessionIds(listed).includes(createdId);
    assert.ok(found, `the created session (${createdId}) appears in the real daemon's session list`);

    // 3) Real streamed state: open the live control-plane SSE against the daemon and assert
    //    the stream genuinely opens (onReady from a real process, over Bun's streaming fetch).
    //    Require the close response AND its matching session-update frame within the window.
    log('opening the live event stream and driving a mutation…');
    await requireSessionCloseReceipt({
      sessionId: createdId,
      eventName: SESSION_UPDATE_WIRE_EVENT,
      close: () => engine.operator.invoke('sessions.close', { sessionId: createdId }),
      open: (handlers) => engine.streams.open(
        '/api/control-plane/events?domains=session',
        handlers,
        { reconnect: { enabled: false, baseDelayMs: 0, maxDelayMs: 0, backoffFactor: 1, maxAttempts: 0 } },
      ),
    });
    log('close acknowledged and matching closed-session frame received over the live stream');

    process.stdout.write('\nLive-daemon smoke: PASS\n');
  } finally {
    process.off('SIGINT', onSignal);
    process.off('SIGTERM', onSignal);
    try {
      if (daemon) await daemon.stop();
    } finally {
      removeRunRoot();
    }
  }
}

main().then(
  () => process.exit(0),
  (error: unknown) => {
    process.stderr.write(`\nLive-daemon smoke: FAIL\n${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);
    process.exit(1);
  },
);
