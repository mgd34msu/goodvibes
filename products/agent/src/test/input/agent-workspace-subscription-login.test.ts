import { describe, expect, test } from 'bun:test';
import {
  submitAgentWorkspaceSubscriptionLoginFinishEditor,
  type AgentWorkspaceSubscriptionEditorHost,
} from '../../input/agent-workspace-subscription-editor.ts';
import { trySubmitDirectHostActionEditor } from '../../input/agent-workspace-direct-editor-submission.ts';
import type { AgentWorkspaceLocalEditor } from '../../input/agent-workspace-types.ts';
import type { CommandContext } from '../../input/command-registry.ts';

const finishEditor: AgentWorkspaceLocalEditor = {
  kind: 'subscription-login-finish',
  mode: 'create',
  title: 'Finish login',
  selectedFieldIndex: 0,
  message: '',
  fields: [],
};

function makeHost(overrides: Partial<AgentWorkspaceSubscriptionEditorHost> = {}): AgentWorkspaceSubscriptionEditorHost {
  return {
    localEditor: finishEditor,
    runtimeSnapshot: null,
    status: '',
    lastActionResult: null,
    clampSelection: () => {},
    ...overrides,
  };
}

/** A service-registered OAuth provider, so the flow goes through manager.completeOAuthLogin and needs no network. */
function makeContext(completeOAuthLogin: (code: string) => Promise<unknown>): { context: CommandContext; calls: string[] } {
  const calls: string[] = [];
  const oauth = { authorizationUrl: 'https://example.test/auth', tokenUrl: 'https://example.test/token', clientId: 'c', scopes: [], redirectUri: 'http://localhost/cb' };
  const service = { name: 'custom', authType: 'oauth', oauth, tokenKey: 'custom-token' };
  const context = {
    platform: {
      subscriptionManager: {
        getPending: () => ({ state: 'expected-state' }),
        completeOAuthLogin: (_provider: string, _config: unknown, code: string) => {
          calls.push(code);
          return completeOAuthLogin(code);
        },
      },
      serviceRegistry: { get: () => service, getAll: () => ({}) },
    },
  } as unknown as CommandContext;
  return { context, calls };
}

const saved = { provider: 'custom', accessToken: 't', tokenType: 'Bearer', authMode: 'oauth', overrideAmbientApiKeys: false, createdAt: 1, updatedAt: 1 };
const fields = (code: string) => (id: string): string => ({ provider: 'custom', code, confirm: 'yes' })[id] ?? '';

describe('subscription login finish', () => {
  test('a second Enter while the first is running does not spend the code again or overwrite the result', async () => {
    let finish: (value: unknown) => void = () => {};
    const { context, calls } = makeContext(() => new Promise((resolve) => { finish = resolve; }));
    const host = makeHost();

    const directHost = host as unknown as Parameters<typeof trySubmitDirectHostActionEditor>[0];
    let settled: () => void = () => {};
    const done = new Promise<void>((resolve) => { settled = resolve; });
    trySubmitDirectHostActionEditor(directHost, finishEditor, context, fields('abc'), () => settled());
    await Promise.resolve();
    trySubmitDirectHostActionEditor(directHost, finishEditor, context, fields('abc'));
    expect(calls).toEqual(['abc']);
    expect(host.status).toContain('still running');

    finish(saved);
    await done;
    expect(host.lastActionResult?.kind).toBe('refreshed');
    expect(host.localEditor).toBeNull();
  });

  test('a late success does not discard an editor the user opened in the meantime', async () => {
    let finish: (value: unknown) => void = () => {};
    const { context } = makeContext(() => new Promise((resolve) => { finish = resolve; }));
    const host = makeHost();
    const pending = submitAgentWorkspaceSubscriptionLoginFinishEditor(host, finishEditor, context, fields('abc'));
    const other: AgentWorkspaceLocalEditor = { ...finishEditor, kind: 'subscription-logout', title: 'Logout' };
    host.localEditor = other;
    finish(saved);
    await pending;
    expect(host.localEditor).toBe(other);
    expect(host.lastActionResult?.kind).toBe('refreshed');
  });

  test('a failing onboarding follow-up does not turn a saved login into a failure', async () => {
    const { context } = makeContext(async () => saved);
    const host = makeHost({ onSubscriptionLoginSuccess: () => { throw new Error('marker unreadable'); } });
    await submitAgentWorkspaceSubscriptionLoginFinishEditor(host, finishEditor, context, fields('abc'));
    expect(host.lastActionResult?.kind).toBe('refreshed');
    expect(host.status).toContain('saved');
    expect(host.status).toContain('marker unreadable');
  });

  test('a failed exchange puts the form back with the reason and allows a retry', async () => {
    let attempt = 0;
    const { context, calls } = makeContext(async () => {
      attempt += 1;
      if (attempt === 1) throw new Error('code already used');
      return saved;
    });
    const host = makeHost();
    await submitAgentWorkspaceSubscriptionLoginFinishEditor(host, finishEditor, context, fields('abc'));
    expect(host.lastActionResult?.kind).toBe('error');
    expect(host.localEditor?.message).toBe('code already used');
    await submitAgentWorkspaceSubscriptionLoginFinishEditor(host, finishEditor, context, fields('def'));
    expect(calls).toEqual(['abc', 'def']);
    expect(host.lastActionResult?.kind).toBe('refreshed');
  });

  test('a pasted provider error address is refused and never sent as the code', async () => {
    const { context, calls } = makeContext(async () => saved);
    const host = makeHost();
    await submitAgentWorkspaceSubscriptionLoginFinishEditor(host, finishEditor, context, fields('http://localhost/cb?error=access_denied'));
    expect(calls).toEqual([]);
    expect(host.lastActionResult?.kind).toBe('error');
    expect(host.localEditor?.message).toContain('access_denied');
  });

  test('an address from a different login attempt is refused', async () => {
    const { context, calls } = makeContext(async () => saved);
    const host = makeHost();
    await submitAgentWorkspaceSubscriptionLoginFinishEditor(host, finishEditor, context, fields('http://localhost/cb?code=abc&state=other'));
    expect(calls).toEqual([]);
    expect(host.localEditor?.message).toContain('state mismatch');
  });
});
