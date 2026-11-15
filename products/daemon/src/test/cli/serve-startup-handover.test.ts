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

test('a startup that ends in a handover ends the process instead of idling without a listener', async () => {
  const root = makeOwnedTempDir('serve-startup-handover');
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const home = join(root, 'home');
  mkdirSync(home, { recursive: true });
  const env = { HOME: home };
  const configuration = createDaemonCliConfiguration(parseDaemonCli(['serve']).flags, env, root, { readOnly: true, diagnosticMode: 'structural' });
  let closes = 0;
  // The host's start settled in `handover`: a rollback or promotion stopped the
  // runtime and handed it to a managed replacement. Nothing serves here now.
  const createHost = (() => ({
    services: undefined, daemon: undefined, httpListener: undefined,
    start: async () => ({ state: 'handover' as const }),
    close: async () => { closes++; },
    snapshot: () => ({ state: 'handover' as const }),
  })) as unknown as typeof createDaemonHost;
  const target = new ProcessTarget();
  const handle = runConfiguredDaemonCli(configuration, { inboxFactory() { throw new Error('Graph must not start'); } }, env,
    { process: target, shutdownTimeoutMs: 5_000 }, () => {}, () => {}, undefined, undefined, createHost);
  const settled = await Promise.race([handle.finished, Bun.sleep(3_000).then(() => 'still running' as const)]);
  expect(settled).toBe(0);
  expect(target.exits).toEqual([0]);
  expect(closes).toBe(1);
});

test('a handover that could not complete after the runtime stopped ends the process with status 1', async () => {
  const root = makeOwnedTempDir('serve-incomplete-handover');
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const home = join(root, 'home');
  mkdirSync(home, { recursive: true });
  const env = { HOME: home };
  const configuration = createDaemonCliConfiguration(parseDaemonCli(['serve']).flags, env, root, { readOnly: true, diagnosticMode: 'structural' });
  let closes = 0;
  // The lifecycle reports, from inside the host's startup drain, that the
  // runtime stopped and its replacement was never accepted.
  const createHost = ((options: { onIncompleteHandover?: () => void }) => ({
    services: undefined, daemon: undefined, httpListener: undefined,
    start: async () => { options.onIncompleteHandover?.(); return { state: 'handover' as const }; },
    close: async () => { closes++; },
    snapshot: () => ({ state: 'handover' as const }),
  })) as unknown as typeof createDaemonHost;
  const target = new ProcessTarget();
  const handle = runConfiguredDaemonCli(configuration, { inboxFactory() { throw new Error('Graph must not start'); } }, env,
    { process: target, shutdownTimeoutMs: 5_000 }, () => {}, () => {}, undefined, undefined, createHost);
  const settled = await Promise.race([handle.finished, Bun.sleep(3_000).then(() => 'still running' as const)]);
  expect(settled).toBe(1);
  expect(target.exits).toEqual([1]);
  expect(closes).toBe(1);
});
