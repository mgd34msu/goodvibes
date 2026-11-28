import { describe, expect, test } from 'bun:test';
import { restartDaemonAfterSuiteUpdate } from '../terminal-shell/src/release-update-preflight.js';
import { createDaemonWorkDelegation } from '../terminal-shell/src/agent-turn/daemon-work-delegation.js';
import { useConnectedHostRefusal } from '../terminal-shell/src/agent-turn/connected-host-client.js';
import { buildRecorderCommand } from '../platform/src/platform/voice/capture/recorder-command.js';
import { fetchOpenAISubscriptionModelIds } from '../platform/src/platform/providers/openai-codex.js';
import type { AgentRecord } from '../platform/src/platform/tools/index.js';
import type { ShellPathService } from '../platform/src/platform/runtime/shell-paths.js';

function fakeJwtWithAccount(accountId: string): string {
  const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({
    'https://api.openai.com/auth': { chatgpt_account_id: accountId },
  })).toString('base64url');
  return `${header}.${payload}.sig`;
}

describe('daemon upgrade, version mismatch, openai subscription discovery, and voice capture fixes', () => {
  test('restartDaemonAfterSuiteUpdate restarts the managed daemon service when goodvibes-daemon was updated', async () => {
    let called = 0;
    const lines = await restartDaemonAfterSuiteUpdate(
      { programs: ['goodvibes', 'goodvibes-daemon'] },
      {
        platform: 'linux',
        configManager: { get: () => undefined },
        attemptRestart: true,
        restartDaemon: () => {
          called += 1;
          return { restarted: true, unitName: 'goodvibes', detail: 'restarted the service "goodvibes" onto it' };
        },
      },
    );
    expect(called).toBe(1);
    expect(lines).toEqual(['Daemon restarted: restarted the service "goodvibes" onto it.']);

    const skipped = await restartDaemonAfterSuiteUpdate(
      { programs: ['goodvibes'] },
      {
        platform: 'linux',
        configManager: { get: () => undefined },
        attemptRestart: true,
        restartDaemon: () => {
          throw new Error('should not be called when goodvibes-daemon was not updated');
        },
      },
    );
    expect(skipped).toEqual([]);
  });

  test('daemon work delegation surfaces incompatible daemon version clearly without auth_required prefix', async () => {
    const unregister = useConnectedHostRefusal(
      () => 'A GoodVibes daemon (version 3.5.0) is running on 127.0.0.1:3421, but this program is version 3.6.1. Restart it with goodvibes-daemon restart-service.',
    );
    try {
      const delegation = createDaemonWorkDelegation({
        shellPaths: { homeDirectory: '/tmp/gv-test-home', workingDirectory: '/tmp/gv-test-work' } as ShellPathService,
        configManager: { get: () => undefined },
        program: 'tui',
      });
      const fakeOwner = {
        id: 'agent-1',
        task: 'review this codebase',
      } as AgentRecord;
      await expect(delegation.delegate(fakeOwner, {
        signal: new AbortController().signal,
        report: () => {},
      })).rejects.toThrow(/version 3\.5\.0.*goodvibes-daemon restart-service/);
      await expect(delegation.delegate(fakeOwner, {
        signal: new AbortController().signal,
        report: () => {},
      })).rejects.not.toThrow(/auth_required/);
    } finally {
      unregister();
    }
  });

  test('parecord and pw-record request 80ms capture latency to avoid 2-second burst drops', () => {
    const parecord = buildRecorderCommand('parecord', { platform: 'linux' });
    expect(parecord.args).toContain('--latency-msec=80');
    const pwRecord = buildRecorderCommand('pw-record', { platform: 'linux' });
    expect(pwRecord.args).toContain('--latency');
    expect(pwRecord.args).toContain('80ms');
  });

  test('fetchOpenAISubscriptionModelIds sends client_version query param and OpenAI-Beta header', async () => {
    const originalFetch = globalThis.fetch;
    let seenUrl = '';
    let seenBeta = '';
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      seenUrl = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      const headers = new Headers(init?.headers);
      seenBeta = headers.get('OpenAI-Beta') ?? '';
      return new Response(JSON.stringify({ models: [{ slug: 'gpt-5.4', visibility: 'list' }, { slug: 'hidden-model', visibility: 'hide' }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as typeof fetch;
    try {
      const models = await fetchOpenAISubscriptionModelIds(fakeJwtWithAccount('acct_test'));
      expect(seenUrl).toContain('/backend-api/codex/models?client_version=');
      expect(seenBeta).toBe('responses=experimental');
      expect(models).toEqual(['gpt-5.4']);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
