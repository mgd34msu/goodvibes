/**
 * config-routing-and-locks-hardening.test.ts
 *
 * Where the operator token is sent while discovering a daemon, what a client
 * says about a key an older daemon does not know, how credential conflicts are
 * reported, how owner locks behave while being taken or after a failed
 * ownership check, and that the provider credential tables cannot drift.
 */

import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveLiveConfigWriteRoute } from '../platform/src/platform/config/daemon-config-route.js';
import { createDaemonIdentityProof, DAEMON_CHALLENGE_HEADER, DAEMON_PROOF_HEADER } from '../platform/src/platform/daemon/identity-proof.js';
import { readDetachedDaemonRuntime, recordDetachedDaemonRuntime } from '../platform/src/platform/runtime/detached-daemon-runtime.js';
import { readConfigValue } from '../platform/src/platform/config/daemon-config-read.js';
import { migrateDaemonNeededCredentials, describeCredentialMigration, type MigratableSecretStore } from '../platform/src/platform/config/daemon-credential-migration.js';
import { createDaemonCredentialStore } from '../platform/src/platform/config/daemon-credential-store.js';
import { daemonSecretKeyFor } from '../platform/src/platform/config/daemon-secret-keys.js';
import { DurablePolicyEpochOwner, reclaimDeadOwnerLock, setOwnerLockWaitForTest } from '../platform/src/platform/config/durable-policy-epoch.js';
import { getConfiguredApiKeys } from '../platform/src/platform/config/api-keys.js';
import { BUILTIN_PROVIDER_ENV_KEYS } from '../platform/src/platform/config/provider-credential-catalog.js';
import { getConfiguredSystemPrompt } from '../platform/src/platform/config/index.js';
import { logger } from '../platform/src/platform/utils/logger.js';
import * as atomic from '../platform/src/platform/utils/atomic-json-store.js';
import type { SecretRecord } from '../platform/src/platform/config/secrets.js';

const dirs: string[] = [];
const restores: (() => void)[] = [];
afterEach(() => {
  for (const restore of restores.splice(0)) restore();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function directory(): string { const dir = mkdtempSync(join(tmpdir(), 'gv-config-routing-')); dirs.push(dir); return dir; }

describe('probing a daemon address found in configuration', () => {
  const binding = { hostMode: 'local', host: '127.0.0.1', port: 3421, tlsMode: 'off' };
  function deps(fetchImpl: typeof fetch) {
    return {
      hostsDaemon: false,
      daemonHomeDir: '/nonexistent-daemon-home',
      token: 'operator-secret-token',
      readRuntimeRecord: () => null,
      readDaemonBinding: () => binding,
      fetchImpl,
    };
  }

  test('an unrelated service that answers 404 is never sent the operator token and the write stays local', async () => {
    const seen: (string | null)[] = [];
    const other = (async (_url: string, init?: RequestInit) => {
      seen.push(new Headers(init?.headers).get('authorization'));
      return new Response('not here', { status: 404 });
    }) as unknown as typeof fetch;
    const route = await resolveLiveConfigWriteRoute('controlPlane.port', deps(other));
    expect(route.mode).toBe('local');
    expect(seen).toEqual([null]);
  });

  test('a catch-all server that answers 200 to the anonymous probe is not a daemon and is never sent the token', async () => {
    const seen: (string | null)[] = [];
    const catchAll = (async (_url: string, init?: RequestInit) => {
      seen.push(new Headers(init?.headers).get('authorization'));
      return new Response('<html>app</html>', { status: 200 });
    }) as unknown as typeof fetch;
    const route = await resolveLiveConfigWriteRoute('controlPlane.port', deps(catchAll));
    expect(route.mode).toBe('local');
    expect(seen).toEqual([null]);
  });

  test('a daemon that proves it holds the token on the anonymous probe is accepted, still without a token on the probe', async () => {
    const seen: (string | null)[] = [];
    const daemon = (async (_url: string, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      seen.push(headers.get('authorization'));
      const proof = createDaemonIdentityProof('operator-secret-token', headers.get(DAEMON_CHALLENGE_HEADER) ?? '');
      return Response.json({ error: 'Authentication required', code: 'AUTH_REQUIRED' }, { status: 401, headers: { [DAEMON_PROOF_HEADER]: proof } });
    }) as unknown as typeof fetch;
    const route = await resolveLiveConfigWriteRoute('controlPlane.port', deps(daemon));
    expect(route.mode).toBe('daemon');
    expect(seen).toEqual([null]);
  });

  test('a listener that answers with the daemon authentication error but no proof is never sent the token', async () => {
    const seen: (string | null)[] = [];
    const impostor = (async (_url: string, init?: RequestInit) => {
      seen.push(new Headers(init?.headers).get('authorization'));
      return Response.json({ error: 'Authentication required', code: 'AUTH_REQUIRED' }, { status: 401 });
    }) as unknown as typeof fetch;
    await expect(resolveLiveConfigWriteRoute('controlPlane.port', deps(impostor))).rejects.toThrow('did not prove it holds the operator token');
    expect(seen).toEqual([null]);
  });
});

describe('reaping a runtime record whose daemon did not answer', () => {
  test('a daemon that wrote its own record at the same address during the probe keeps it', async () => {
    const home = directory();
    const stale = { pid: 111, host: '127.0.0.1', port: 3421, command: 'goodvibes-daemon', startedAt: '2026-01-01T00:00:00.000Z' };
    const replacement = { ...stale, pid: 222, startedAt: '2026-01-01T00:05:00.000Z' };
    recordDetachedDaemonRuntime(home, stale);
    let probes = 0;
    const fetchImpl = (async () => {
      // The new daemon appears while the first probe fails, then answers.
      if (probes++ > 0) return Response.json({ error: 'Authentication required', code: 'AUTH_REQUIRED' }, { status: 401 });
      recordDetachedDaemonRuntime(home, replacement);
      throw new Error('connection refused');
    }) as unknown as typeof fetch;

    await resolveLiveConfigWriteRoute('controlPlane.port', {
      hostsDaemon: false,
      daemonHomeDir: home,
      isProcessAlive: () => true,
      readDaemonBinding: () => null,
      fetchImpl,
    });

    expect(readDetachedDaemonRuntime(home)?.pid).toBe(222);
  });

  test('a record that still describes the unanswering daemon is removed', async () => {
    const home = directory();
    recordDetachedDaemonRuntime(home, { pid: 111, host: '127.0.0.1', port: 3421, command: 'goodvibes-daemon', startedAt: '2026-01-01T00:00:00.000Z' });
    await resolveLiveConfigWriteRoute('controlPlane.port', {
      hostsDaemon: false,
      daemonHomeDir: home,
      isProcessAlive: () => true,
      readDaemonBinding: () => null,
      fetchImpl: (async () => { throw new Error('connection refused'); }) as unknown as typeof fetch,
    });
    expect(readDetachedDaemonRuntime(home)).toBeNull();
  });
});

describe('a daemon-owned key an older daemon does not know', () => {
  test('is reported unavailable, not as a customised empty value', async () => {
    const local = { get: () => 'local-value', getConfigPath: () => '/x/settings.json' };
    const entry = await readConfigValue('surfaces.telegram.botUsername', local, {
      hostsDaemon: false,
      daemonHomeDir: '/nonexistent-daemon-home',
      readRuntimeRecord: () => ({ host: '127.0.0.1', port: 3421 }),
      fetchImpl: (async () => Response.json({ display: { theme: 'nord' } })) as unknown as typeof fetch,
    });
    expect(entry.status).toBe('unavailable');
    expect(entry.source).toBe('daemon');
  });
});

describe('credential migration conflicts', () => {
  function conflictedStore(): MigratableSecretStore {
    const record = { key: 'SLACK_BOT_TOKEN', source: 'user-secure', scope: 'user', secure: true, overriddenByEnv: false } as SecretRecord;
    return {
      async listDetailedForMigration() { return [record]; },
      async get() { return null; },
      async set() { throw new Error('must not write'); },
      async getFromScope(_key, scope) { return scope === 'daemon' ? 'daemon-value' : 'surface-value'; },
      async deleteFromScope() { throw new Error('must not delete'); },
    };
  }

  test('a surface value that differs from the daemon value is counted, logged and described', async () => {
    const warn = spyOn(logger, 'warn').mockImplementation(() => {});
    restores.push(() => warn.mockRestore());
    const report = await migrateDaemonNeededCredentials(conflictedStore());
    expect(report.conflicts).toBe(1);
    expect(report.noop).toBe(false);
    expect(warn).toHaveBeenCalled();
    expect(describeCredentialMigration(report)).toContain('different value');
  });

  test('a surface copy that cannot be read is not reported as already migrated', async () => {
    const store: MigratableSecretStore = {
      ...conflictedStore(),
      async getFromScope() { return null; },
    };
    const report = await migrateDaemonNeededCredentials(store);
    expect(report.entries[0]?.outcome).toBe('source-unreadable');
  });
});

describe('a secret reference held by one config key', () => {
  test('resolves only the key derived from that config key', async () => {
    const values: Record<string, string> = {
      [daemonSecretKeyFor('surfaces.ntfy.token')]: 'ntfy-token',
      ANTHROPIC_API_KEY: 'sk-other-secret',
    };
    const store = createDaemonCredentialStore({ get: async (key: string) => values[key] ?? null, set: async () => {} });
    const own = `goodvibes://secrets/goodvibes/${daemonSecretKeyFor('surfaces.ntfy.token')}`;
    expect(await store.resolveBoundRef?.('surfaces.ntfy.token', own)).toBe('ntfy-token');
    expect(await store.resolveBoundRef?.('surfaces.ntfy.token', 'goodvibes://secrets/goodvibes/ANTHROPIC_API_KEY')).toBeNull();
    expect(await store.resolveBoundRef?.('surfaces.ntfy.token', 'ANTHROPIC_API_KEY')).toBeNull();
  });
});

describe('owner locks', () => {
  function owner() {
    const file = join(directory(), 'settings.json');
    writeFileSync(file, JSON.stringify({ behavior: { autoApprove: false } }));
    const epochs = new DurablePolicyEpochOwner([file], true);
    epochs.capture({});
    return { file, lock: `${file}.policy-epoch.json.owner-lock`, epochs };
  }
  function deadPid(): number {
    const child = spawnSync(process.execPath, ['-e', ''], { encoding: 'utf8' });
    if (typeof child.pid !== 'number') throw new Error('no child pid');
    return child.pid;
  }

  test('a lock being taken (directory present, holder not yet recorded) is waited for, not reported as a crash', () => {
    const { lock, epochs } = owner();
    mkdirSync(lock, { mode: 0o700 });
    let waits = 0;
    restores.push(setOwnerLockWaitForTest(() => { waits += 1; rmSync(lock, { recursive: true }); }));
    expect(() => epochs.advance()).not.toThrow();
    expect(waits).toBe(1);
  });

  test('a failed ownership check still releases the lock, so the next change is not refused', () => {
    const { file, epochs } = owner();
    const parent = join(file, '..');
    const moved = `${parent}.moved`;
    const write = atomic.writeJsonFileAtomic;
    let swapped = false;
    const spy = spyOn(atomic, 'writeJsonFileAtomic').mockImplementation(((...args: Parameters<typeof write>) => {
      if (!swapped) {
        swapped = true;
        // The directory is replaced by a link to itself elsewhere while the change runs.
        renameSync(parent, moved);
        symlinkSync(moved, parent);
      }
      return write(...args);
    }) as typeof write);
    restores.push(() => spy.mockRestore());

    expect(() => epochs.advance()).toThrow();
    expect(swapped).toBe(true);

    spy.mockRestore();
    unlinkSync(parent);
    renameSync(moved, parent);
    const second = new DurablePolicyEpochOwner([file], true);
    expect(() => second.advance()).not.toThrow();
  });

  test('a reclaim ticket left by a reclaimer that died does not block reclaiming a dead holder\'s lock', () => {
    const base = directory();
    const lock = join(base, 'x.owner-lock');
    mkdirSync(lock, { mode: 0o700 });
    writeFileSync(join(lock, 'owner'), JSON.stringify({ pid: deadPid(), start: null }));
    const ticket = `${lock}.reclaim`;
    mkdirSync(ticket, { mode: 0o700 });
    writeFileSync(join(ticket, 'owner'), JSON.stringify({ pid: deadPid(), start: null }));
    expect(reclaimDeadOwnerLock(lock)).toBe(true);
    expect(existsSync(lock)).toBe(false);
    expect(existsSync(ticket)).toBe(false);
  });
});

describe('provider API key tables', () => {
  test('every environment variable the catalog declares for an API-key provider is read', () => {
    const providers = Object.keys(getConfiguredApiKeysProviders());
    expect(providers.length).toBeGreaterThan(20);
    for (const provider of providers) {
      // Bedrock takes only its bearer token as a key; its access key id, secret and profile are credentials of another kind.
      const names = provider.startsWith('amazon-bedrock') ? ['AWS_BEARER_TOKEN_BEDROCK'] : BUILTIN_PROVIDER_ENV_KEYS[provider]!;
      for (const name of names) {
        const saved = withOnly(name, 'value-for-test');
        try {
          expect(getConfiguredApiKeys()[provider]).toBe('value-for-test');
        } finally {
          saved();
        }
      }
    }
  });
});

describe('an unreadable system prompt file', () => {
  test('is said at warn level, once per path', () => {
    const warn = spyOn(logger, 'warn').mockImplementation(() => {});
    restores.push(() => warn.mockRestore());
    const missing = join(directory(), 'no-such-prompt.md');
    const config = { get: () => missing } as unknown as Parameters<typeof getConfiguredSystemPrompt>[0];
    expect(getConfiguredSystemPrompt(config)).toBeUndefined();
    expect(getConfiguredSystemPrompt(config)).toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(1);
  });
});

/** The providers getConfiguredApiKeys covers, found by setting each catalog provider's first name in turn. */
function getConfiguredApiKeysProviders(): Record<string, true> {
  const found: Record<string, true> = {};
  for (const [provider, names] of Object.entries(BUILTIN_PROVIDER_ENV_KEYS)) {
    const first = names[0];
    if (!first) continue;
    const restore = withOnly(first, 'probe');
    try {
      if (getConfiguredApiKeys()[provider] === 'probe') found[provider] = true;
    } finally {
      restore();
    }
  }
  return found;
}

/** Clear every catalog variable, set one, and return a function that restores the environment. */
function withOnly(name: string, value: string): () => void {
  const all = new Set(Object.values(BUILTIN_PROVIDER_ENV_KEYS).flat());
  const saved = new Map<string, string | undefined>();
  for (const key of all) { saved.set(key, process.env[key]); delete process.env[key]; }
  process.env[name] = value;
  return () => {
    for (const [key, previous] of saved) {
      if (previous === undefined) delete process.env[key]; else process.env[key] = previous;
    }
  };
}
