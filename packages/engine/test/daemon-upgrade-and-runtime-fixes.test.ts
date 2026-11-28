import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { restartDaemonAfterSuiteUpdate } from '../terminal-shell/src/release-update-preflight.js';
import { createDaemonWorkDelegation, formatDelegatedWorkProgress } from '../terminal-shell/src/agent-turn/daemon-work-delegation.js';
import { decisionModelSet, registerStoredDecisionKeyProbe } from '../platform/src/platform/config/decision-model-set.js';
import { decisionModelReady } from '../platform/src/platform/gate/presets.js';
import { formatLiveStepProgress, liveContractStatusLine } from '../platform/src/platform/contract/live-progress.js';
import { useConnectedHostRefusal } from '../terminal-shell/src/agent-turn/connected-host-client.js';
import { buildRecorderCommand } from '../platform/src/platform/voice/capture/recorder-command.js';
import { fetchOpenAISubscriptionModelIds } from '../platform/src/platform/providers/openai-codex.js';
import { SubscriptionManager } from '../platform/src/platform/config/subscriptions.js';
import { Secret } from '../platform/src/platform/security/secret.js';
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

  test('SubscriptionManager recovers newer secret tokenRevision when subscriptions.json lagged behind after a restart', () => {
    const dir = mkdtempSync(join(tmpdir(), 'gv-sub-rev-'));
    try {
      const subPath = join(dir, 'subscriptions.json');
      writeFileSync(subPath, JSON.stringify({
        version: 1,
        subscriptions: {
          openai: {
            provider: 'openai',
            tokenType: 'Bearer',
            expiresAt: Date.now() + 3_600_000,
            scopes: ['openid'],
            authMode: 'oauth',
            overrideAmbientApiKeys: false,
            createdAt: Date.now() - 10_000,
            updatedAt: Date.now() - 10_000,
            tokenRevision: 1,
          },
        },
        pending: {},
      }));
      const storedSecret = JSON.stringify({
        revision: 3,
        accessToken: 'recovered-access-token',
        refreshToken: 'recovered-refresh-token',
        previous: { revision: 2, accessToken: 'prev-access-token', refreshToken: 'prev-refresh-token' },
      });
      const secrets = {
        resolveLocalSecretSync: (key: string) => key === 'GOODVIBES_SUBSCRIPTION_TOKENS_OPENAI'
          ? { state: 'resolved' as const, value: Secret.of(storedSecret, key) }
          : { state: 'absent' as const },
        set: async () => {},
        delete: async () => {},
      };
      const manager = new SubscriptionManager(subPath, { secrets });
      const grant = manager.get('openai');
      expect(grant).not.toBeNull();
      expect(grant!.accessToken.reveal('dispatch')).toBe('recovered-access-token');
      expect(grant!.refreshToken?.reveal('dispatch')).toBe('recovered-refresh-token');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('formatDelegatedWorkProgress reports concise title and live step progress from run.steps', () => {
    const multilineTitle = 'review this codebase, give it a score out of 10\n\nPlanned for the agents:\n- backend\n- frontend';
    expect(formatDelegatedWorkProgress(multilineTitle, 'running', { steps: [] }))
      .toBe('"review this codebase, give it a score out of 10": planning steps on the daemon');

    expect(formatDelegatedWorkProgress(multilineTitle, 'running', {
      steps: [
        { id: 'u1', title: 'Review backend', status: 'passed' },
        { id: 'u2', title: 'Review frontend', status: 'passed' },
        { id: 'u3', title: 'Synthesize score', status: 'running' },
      ],
    })).toBe('"review this codebase, give it a score out of 10": 2/3 steps done · running: Synthesize score');

    expect(formatDelegatedWorkProgress(multilineTitle, 'needs-you', {
      statusLine: 'The work finished; waiting for acceptance.',
      steps: [{ id: 'u1', title: 'Review', status: 'passed' }],
    })).toContain('needs you in Work (Ctrl+G then w) (1/1 steps done)');
  });

  test('decisionModelSet recognizes a stored daemon secret key when systemd env lacks TYPESAFE_API_KEY', () => {
    expect(decisionModelSet({ keySource: 'env' }, {})).toBe(false);
    expect(decisionModelSet({ keySource: 'env' }, {}, { hasStoredKey: true })).toBe(true);
    expect(decisionModelSet({ keySource: 'env', noDecisionModel: true }, {}, { hasStoredKey: true })).toBe(false);
    expect(decisionModelReady({ keySource: 'env', policy: 'Hybrid' }, {}, { hasStoredKey: true })).toBe(true);
    expect(decisionModelReady({ keySource: 'env', policy: 'No Decision Model' }, {}, { hasStoredKey: true })).toBe(false);

    // Process-level stored-key probe applies only against process.env (never leaks into custom env maps).
    const unregister = registerStoredDecisionKeyProbe((name) => name === 'CUSTOM_DECISION_KEY');
    try {
      expect(decisionModelSet({ keySource: 'env', keyName: 'CUSTOM_DECISION_KEY' }, {})).toBe(false);
      expect(decisionModelSet({ keySource: 'env', keyName: 'CUSTOM_DECISION_KEY' }, process.env)).toBe(true);
      expect(decisionModelSet({ keySource: 'env', keyName: 'CUSTOM_DECISION_KEY' }, process.env, { hasStoredKey: false })).toBe(false);
    } finally {
      unregister();
    }
  });

  test('liveContractStatusLine derives live step progress for running contracts and avoids duplicating it', () => {
    expect(formatLiveStepProgress([])).toBe('Planning steps on the daemon');
    const live = liveContractStatusLine({
      status: 'running',
      statusLine: undefined,
      units: [
        { id: 'u1', title: 'Review backend', brief: '', status: 'passed' } as never,
        { id: 'u2', title: 'Review frontend', brief: '', status: 'running' } as never,
      ],
    });
    expect(live).toBe('1/2 steps done · running: Review frontend');
    // Terminal or already-populated statusLine contracts are left untouched.
    expect(liveContractStatusLine({ status: 'passed', statusLine: undefined, units: [] })).toBeUndefined();
    expect(liveContractStatusLine({ status: 'running', statusLine: 'Waiting on approval', units: [] })).toBeUndefined();
    // Delegation formatter does not duplicate daemon-provided live statusLine while running.
    expect(formatDelegatedWorkProgress('review repo', 'running', {
      statusLine: live,
      steps: [
        { id: 'u1', title: 'Review backend', status: 'passed' },
        { id: 'u2', title: 'Review frontend', status: 'running' },
      ],
    })).toBe('"review repo": 1/2 steps done · running: Review frontend');
  });
});
