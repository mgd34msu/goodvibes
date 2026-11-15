import { describe, expect, test } from 'bun:test';
import { runExitSequence, type ExitSequenceDeps } from '../../shell/exit-sequence.ts';

type Snap = { readonly messages: readonly string[] };

function harness(overrides: Partial<ExitSequenceDeps<Snap>> = {}) {
  const events: string[] = [];
  const warnings: string[] = [];
  let resolveExit!: (code: number) => void;
  const exited = new Promise<number>((resolve) => { resolveExit = resolve; });
  const deps: ExitSequenceDeps<Snap> = {
    closeHerdr: async () => { events.push('herdr'); },
    disposePairing: () => { events.push('pairing'); },
    closePaintWindow: () => { events.push('paint-close'); },
    stopSpokenOutput: () => { events.push('speech'); return undefined; },
    unsubs: [],
    stopAutonomy: () => { events.push('autonomy'); },
    detachHostedSession: async () => { events.push('hosted-detach'); return 'detached'; },
    buildSnapshot: () => ({ messages: ['full'] }),
    buildMessagesSnapshot: () => ({ messages: ['messages-only'] }),
    shutdown: async (snap) => { events.push(`shutdown ${snap.messages[0]}`); },
    removeRecoveryPoint: () => { events.push('recovery-removed'); },
    detach: () => { events.push('detach'); },
    restoreTerminal: () => { events.push('restore'); },
    warn: (message) => { warnings.push(message); },
    warnPlain: (message) => { warnings.push(message); },
    exit: (code) => { events.push(`exit ${code}`); resolveExit(code); },
    ...overrides,
  };
  return { deps, events, warnings, exited };
}

describe('runExitSequence', () => {
  test('a throwing herdr release still restores the terminal, saves the session and exits', async () => {
    const h = harness({ closeHerdr: () => { throw new Error('herdr gone'); } });
    runExitSequence(h.deps);
    expect(await h.exited).toBe(0);
    expect(h.events).toContain('restore');
    expect(h.events).toContain('shutdown full');
    expect(h.warnings).toContain('Owned cleanup failed during exitApp');
  });

  test('a throwing pairing dispose or paint close is reported and the session is still saved', async () => {
    const h = harness({
      disposePairing: () => { throw new Error('pairing'); },
      closePaintWindow: () => { throw new Error('paint'); },
    });
    runExitSequence(h.deps, () => 7);
    expect(await h.exited).toBe(7);
    expect(h.events).toContain('shutdown full');
    expect(h.events.indexOf('recovery-removed')).toBeGreaterThan(h.events.indexOf('shutdown full'));
    expect(h.warnings).toContain('Pairing prompt could not be cancelled during exitApp');
    expect(h.warnings).toContain('Paint window could not be closed during exitApp');
  });

  test('a throwing autonomy stop is reported and the session is still saved', async () => {
    const h = harness({ stopAutonomy: () => { throw new Error('autonomy sync'); } });
    runExitSequence(h.deps);
    await h.exited;
    expect(h.events).toContain('shutdown full');
    expect(h.events.indexOf('recovery-removed')).toBeGreaterThan(h.events.indexOf('shutdown full'));
    expect(h.warnings).toContain('Autonomy could not be stopped during exitApp');
  });

  test('a snapshot that cannot carry its session context falls back to the messages and still shuts down', async () => {
    const h = harness({ buildSnapshot: () => { throw new Error('context'); } });
    runExitSequence(h.deps);
    await h.exited;
    expect(h.events).toContain('shutdown messages-only');
    expect(h.events).toContain('recovery-removed');
  });

  test('when even the messages cannot be read nothing is saved and the recovery snapshot stays', async () => {
    const h = harness({
      buildSnapshot: () => { throw new Error('context'); },
      buildMessagesSnapshot: () => { throw new Error('messages'); },
    });
    runExitSequence(h.deps);
    await h.exited;
    expect(h.events.some((e) => e.startsWith('shutdown'))).toBe(false);
    expect(h.events).not.toContain('recovery-removed');
    expect(h.events).toContain('restore');
  });

  test('the hosted session is left before the session is saved, and a failed or throwing detach only warns', async () => {
    const ok = harness();
    runExitSequence(ok.deps);
    await ok.exited;
    expect(ok.events.indexOf('hosted-detach')).toBeGreaterThanOrEqual(0);
    expect(ok.events.indexOf('hosted-detach')).toBeLessThan(ok.events.indexOf('shutdown full'));

    for (const detachHostedSession of [
      async () => 'failed' as const,
      async (): Promise<'detached'> => { throw new Error('refused'); },
      (): Promise<'detached'> => { throw new Error('sync'); },
    ]) {
      const h = harness({ detachHostedSession });
      runExitSequence(h.deps);
      expect(await h.exited).toBe(0);
      expect(h.events).toContain('shutdown full');
      expect(h.warnings.some((w) => w.toLowerCase().includes('hosted session'))).toBe(true);
    }
  });

  test('a crash exit carries its code', async () => {
    const h = harness();
    runExitSequence(h.deps, undefined, 1);
    expect(await h.exited).toBe(1);
  });

  test('a handover is skipped when shutdown did not finish, and the plain exit code is used', async () => {
    const h = harness({ shutdown: async () => { throw new Error('owner hung'); } });
    let handedOver = false;
    runExitSequence(h.deps, () => { handedOver = true; return 7; });
    expect(await h.exited).toBe(0);
    expect(handedOver).toBe(false);
    expect(h.warnings.some((w) => w.startsWith('Restart onto the updated program skipped'))).toBe(true);
  });

  test('a completed shutdown hands over with the handover code', async () => {
    const h = harness();
    runExitSequence(h.deps, () => 7);
    expect(await h.exited).toBe(7);
  });

  test('a throwing detach step still restores the terminal', async () => {
    const h = harness({ detach: () => { throw new Error('listener'); } });
    runExitSequence(h.deps);
    await h.exited;
    expect(h.events).toContain('restore');
  });
});
