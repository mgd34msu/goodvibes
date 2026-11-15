import { describe, expect, test } from 'bun:test';
import { existsSync, utimesSync } from 'node:fs';
import { createSessionSurface, writeRecoveryFile } from '@/runtime/index.ts';
import { handleBlockingShellInput } from '../../shell/blocking-input.ts';
import { SessionManager } from '@goodvibes-jev/engine/platform/platform/sessions';
import { buildAgentRecoveryApply } from '../../shell/recovery-apply.ts';
import { makeProjectTempDir } from '../helpers/project-temp.ts';

function setup(options: { readonly fromJsonThrows: boolean }) {
  const home = makeProjectTempDir('gv-agent-recovery-apply-home');
  const work = makeProjectTempDir('gv-agent-recovery-apply-work');
  const surface = createSessionSurface({ surfaceRoot: 'agent', workingDirectory: work, homeDirectory: home });
  writeRecoveryFile({ messages: [{ role: 'user', content: 'hello' } as never], timestamp: Date.now(), title: 'crashed' }, 'crashed-session', 'crashed', { surface });
  const aged = (Date.now() - 10 * 60_000) / 1000;
  utimesSync(surface.recoveryFile('crashed-session'), aged, aged);

  let held: unknown[] = [];
  const conversation = {
    title: '',
    resetAll: () => { held = []; },
    toJSON: () => ({ messages: held }),
    fromJSON: (state: { messages: unknown[] }) => {
      if (options.fromJsonThrows) throw new Error('rejected');
      held = state.messages;
    },
    getTitleSource: () => 'auto',
    getMessageCount: () => held.length,
    getMessageSnapshot: () => held,
  };
  const saved: string[] = [];
  const runtime = { sessionId: 'fresh-session', model: 'm', provider: 'p' };
  const apply = buildAgentRecoveryApply({
    surface,
    sessionManager: { save: (id: string) => { saved.push(id); } } as never,
    runtime,
    conversation: conversation as never,
  });
  const high: string[] = [];
  const press = () => handleBlockingShellInput({
    data: '\x12',
    pendingPermission: null,
    recoveryPending: 'crashed-session',
    daemonRepairPrompt: null,
    abortTurn: () => {},
    conversation: conversation as never,
    systemMessageRouter: { high: (message: string) => high.push(message) } as never,
    render: () => {},
    applyRecovery: apply,
    consumeRecovery: () => { throw new Error('the older path must not run'); },
    removeRecoveryPoint: () => {},
  });
  return { surface, runtime, saved, high, press, held: () => held };
}

describe('Ctrl+R on the recovery offer', () => {
  test('a conversation that rejects the snapshot leaves the file on disk and the session unchanged', () => {
    const { surface, runtime, saved, high, press } = setup({ fromJsonThrows: true });

    const result = press();

    expect(result.recoveryPending).toBeNull();
    expect(existsSync(surface.recoveryFile('crashed-session'))).toBe(true);
    expect(runtime.sessionId).toBe('fresh-session');
    expect(saved).toEqual([]);
    expect(high.join('\n')).toContain('still on disk');
  });

  test('a restore persists the session, moves the runtime onto it, and retires the file', () => {
    const { surface, runtime, saved, high, press, held } = setup({ fromJsonThrows: false });

    press();

    expect(held()).toHaveLength(1);
    expect(runtime.sessionId).toBe('crashed-session');
    expect(saved).toContain('crashed-session');
    expect(existsSync(surface.recoveryFile('crashed-session'))).toBe(false);
    expect(high.join('\n')).toContain('Session restored');
  });

  test('a restore over a saved session keeps the side branches that session was saved with', () => {
    const { surface } = setup({ fromJsonThrows: false });
    const store = new SessionManager(makeProjectTempDir('gv-agent-recovery-apply-store'), { surface });
    store.save('crashed-session', [{ role: 'user', content: 'old' }] as never[], { title: 't', model: 'm', provider: 'p', timestamp: 1 }, undefined, undefined, {
      branches: { alt: [{ role: 'user', content: 'branch work' }] },
      currentBranch: 'main',
    });
    // The restore resets the live conversation, which is what drops the branches.
    let state: { messages: unknown[]; branches?: Record<string, unknown[]> } = { messages: [] };
    const live = {
      title: '',
      resetAll: () => { state = { messages: [] }; },
      toJSON: () => state,
      fromJSON: (next: typeof state) => { state = { messages: next.messages, ...(next.branches ? { branches: next.branches } : {}) }; },
      getTitleSource: () => 'auto',
      getMessageCount: () => 1,
      getMessageSnapshot: () => [{ role: 'user', content: 'recovered' }],
    };
    // The shared setup stubs the session store; wire the real one for this restore.
    const apply = buildAgentRecoveryApply({
      surface,
      sessionManager: store,
      runtime: { sessionId: 'fresh-session', model: 'm', provider: 'p' },
      conversation: live as never,
    });
    expect(apply('crashed-session').applied).toBe(true);
    // The next turn's autosave serialises the live conversation, so the branches must be there too.
    expect(live.toJSON().branches).toEqual({ alt: [{ role: 'user', content: 'branch work' }] });

    expect(store.load('crashed-session').branches?.branches.alt).toEqual([{ role: 'user', content: 'branch work' }]);
  });
});
