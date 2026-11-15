/**
 * A resume that is refused says why, and is not announced as having happened.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, rmSync } from 'node:fs';
import type { SessionSurface } from '@/runtime/index.ts';
import { createResumeSessionHandler } from '../../runtime/bootstrap-hook-bridge.ts';
import { ConversationManager } from '../../core/conversation.ts';
import { makeProjectTempDir } from '../helpers/project-temp.ts';
import { makeTestSurface } from '../helpers/session-surface.ts';

let tmpDir: string;
let surface: SessionSurface;
beforeEach(() => {
  tmpDir = makeProjectTempDir('gv-resume-refusal');
  surface = makeTestSurface(tmpDir);
});
afterEach(() => { if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true, force: true }); });

function setup(isGenerating: () => boolean, extra: Record<string, unknown> = {}) {
  const conversation = new ConversationManager(() => 80);
  const logged: string[] = [];
  conversation.log = ((line: string) => { logged.push(line); }) as never;
  const emitted: string[] = [];
  const runtime = { sessionId: 'boot-session', model: 'm', provider: 'p' };
  const loaded = { messages: [{ role: 'user', content: 'hello' }], meta: { title: 't', titleSource: 'auto', timestamp: Date.now(), model: 'm', provider: 'p', returnContext: undefined } };
  const options = {
    runtimeBus: { emit: (domain: string, event: { type: string }) => { emitted.push(`${domain}:${event.type}`); } },
    runtime,
    conversation,
    requestRender: () => {},
    sharedSessionBroker: { reopenSession: async () => {} },
    sessionSpine: { reopen: () => {} },
    project: tmpDir,
    writeLastSessionPointer: () => {},
    hookDispatcher: { fire: async () => ({ fired: 0 }) },
    sessionManager: { load: () => loaded, save: () => {}, list: () => [] },
    surface,
    configManager: { get: () => 'off', getCategory: () => ({}) },
    providerRegistry: {},
    isGenerating,
    ...extra,
  } as never;
  return { options, logged, emitted, runtime, conversation };
}

describe('a refused session resume', () => {
  test('names the reason in the line it logs, and announces nothing', async () => {
    const h = setup(() => true);

    await createResumeSessionHandler(h.options)('other-session');

    expect(h.logged.join('\n')).toContain('A turn is still running. Wait before resuming a session.');
    expect(h.emitted).toEqual([]);
    expect(h.runtime.sessionId).toBe('boot-session');
  });

  test('a turn that starts after the first check is refused by the second, also without an announcement', async () => {
    let checks = 0;
    const h = setup(() => ++checks > 1);

    await createResumeSessionHandler(h.options)('other-session');

    expect(h.logged.join('\n')).toContain('Failed to resume session: A turn is still running');
    expect(h.emitted).toEqual([]);
    expect(h.runtime.sessionId).toBe('boot-session');
  });

  test('a turn that starts during the model lookup leaves a pending recovery offer standing', async () => {
    let generating = false;
    let revoked = 0;
    const h = setup(() => generating, {
      selectModel: async () => { generating = true; return { registryKey: 'm', providerId: 'p' }; },
      cancelPendingRecovery: () => { revoked++; return true; },
    });

    await createResumeSessionHandler(h.options)('other-session');

    expect(h.logged.join('\n')).toContain('Failed to resume session:');
    expect(revoked).toBe(0);
    expect(h.runtime.sessionId).toBe('boot-session');
  });

  test('a resume that goes through is announced once, from the session it left', async () => {
    const h = setup(() => false);

    await createResumeSessionHandler(h.options)('other-session');

    expect(h.runtime.sessionId).toBe('other-session');
    expect(h.emitted.filter((entry) => entry === 'session:SESSION_RESUMED')).toHaveLength(1);
  });

  test('a resume that goes through revokes a pending recovery offer exactly once', async () => {
    let revoked = 0;
    const h = setup(() => false, { cancelPendingRecovery: () => { revoked++; return true; } });

    await createResumeSessionHandler(h.options)('other-session');

    expect(revoked).toBe(1);
  });
});
