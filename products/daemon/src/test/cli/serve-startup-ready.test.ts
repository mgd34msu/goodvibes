import { afterEach, expect, test } from 'bun:test';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import { createDaemonCliConfiguration } from '../../cli/configuration.js';
import { parseDaemonCli } from '../../cli/parser.js';
import { runConfiguredDaemonCli } from '../../cli/serve.js';
import type { createDaemonHost } from '../../runtime/daemon-host.js';
import { makeOwnedTempDir } from '../helpers/owned-temp.js';

class ProcessTarget extends EventEmitter { readonly exits: number[] = []; exit(code: 0 | 1): void { this.exits.push(code); } }
const cleanups: Array<() => void> = [];
afterEach(() => { for (const cleanup of cleanups.splice(0).reverse()) cleanup(); });

function fixture(env: Record<string, string>) {
  const root = makeOwnedTempDir('serve-startup-ready');
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const home = join(root, 'home');
  mkdirSync(home, { recursive: true });
  const fullEnv = { HOME: home, ...env };
  const configuration = createDaemonCliConfiguration(parseDaemonCli(['serve']).flags, fullEnv, root, { readOnly: true, diagnosticMode: 'structural' });
  const tokens: string[] = [];
  const events: string[] = [];
  const createHost = ((options: { daemon: { token: string } }) => {
    tokens.push(options.daemon.token);
    return {
      services: undefined, httpListener: undefined,
      daemon: { isRunning: true, boundHost: '127.0.0.1', boundPort: 4321, boundScheme: 'http' as const, waitForRestart: async () => {} },
      start: async () => ({ state: 'ready' as const }),
      close: async () => { events.push('host closed'); },
      snapshot: () => ({ state: 'ready' as const }),
    };
  }) as unknown as typeof createDaemonHost;
  return { configuration, fullEnv, tokens, events, createHost };
}

test('close waits for the background worktree sweep instead of cutting it off', async () => {
  const f = fixture({});
  let finishSweep!: () => void;
  let sweepStarted!: () => void;
  const started = new Promise<void>((resolve) => { sweepStarted = resolve; });
  const sweep = () => new Promise<string | null>((resolve) => { sweepStarted(); finishSweep = () => { f.events.push('sweep finished'); resolve(null); }; });
  const target = new ProcessTarget();
  const handle = runConfiguredDaemonCli(f.configuration, { inboxFactory() { throw new Error('Graph must not start'); } }, f.fullEnv,
    { process: target, shutdownTimeoutMs: 5_000 }, () => {}, () => {}, undefined, undefined, f.createHost, sweep);
  await started;
  const shutdown = handle.shutdown();
  // setImmediate runs after every pending microtask, so a drain that did not wait for the sweep would have settled first.
  const first = await Promise.race([shutdown.then(() => 'drained' as const), new Promise<'blocked'>((resolve) => { setImmediate(() => resolve('blocked')); })]);
  expect(first).toBe('blocked');
  expect(target.exits).toEqual([]);
  finishSweep();
  await shutdown; await handle.finished;
  expect(f.events).toContain('sweep finished');
  expect(target.exits).toEqual([0]);
});

test('a set-but-empty GOODVIBES_DAEMON_TOKEN falls back to the stored companion token', async () => {
  const f = fixture({ GOODVIBES_DAEMON_TOKEN: '  ' });
  const target = new ProcessTarget();
  const handle = runConfiguredDaemonCli(f.configuration, { inboxFactory() { throw new Error('Graph must not start'); } }, f.fullEnv,
    { process: target, shutdownTimeoutMs: 5_000 }, () => {}, () => {}, undefined, undefined, f.createHost, async () => null);
  await handle.ready;
  expect(f.tokens).toHaveLength(1);
  expect(f.tokens[0]!.trim().length).toBeGreaterThan(0);
  await handle.shutdown(); await handle.finished;
});

test('a non-empty GOODVIBES_DAEMON_TOKEN is the token the host serves', async () => {
  const f = fixture({ GOODVIBES_DAEMON_TOKEN: 'explicit-token' });
  const target = new ProcessTarget();
  const handle = runConfiguredDaemonCli(f.configuration, { inboxFactory() { throw new Error('Graph must not start'); } }, f.fullEnv,
    { process: target, shutdownTimeoutMs: 5_000 }, () => {}, () => {}, undefined, undefined, f.createHost, async () => null);
  await handle.ready;
  expect(f.tokens).toEqual(['explicit-token']);
  await handle.shutdown(); await handle.finished;
});
