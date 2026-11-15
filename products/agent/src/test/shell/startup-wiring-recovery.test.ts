/**
 * What the agent's startup wiring does about a session another terminal has
 * open, and about a session save that fails.
 */
import { describe, expect, test } from 'bun:test';
import { existsSync, utimesSync } from 'node:fs';
import { createSessionSurface, writeRecoveryFile } from '@/runtime/index.ts';
import { livenessMarkerPathFor, writeLivenessMarker } from '@goodvibes-jev/engine/platform/platform/runtime/operations';
import { wireSessionPersistenceAndRecovery, type SessionPersistenceAndRecoveryDeps } from '../../shell/startup-wiring.ts';
import { makeProjectTempDir } from '../helpers/project-temp.ts';

function setup(overrides: Partial<SessionPersistenceAndRecoveryDeps> = {}) {
  const home = makeProjectTempDir('gv-agent-startup-recovery-home');
  const work = makeProjectTempDir('gv-agent-startup-recovery-work');
  const surface = createSessionSurface({ surfaceRoot: 'agent', workingDirectory: work, homeDirectory: home });
  const high: string[] = [];
  const handlers: Array<() => void> = [];
  const unsubs: Array<() => void> = [];
  const deps: SessionPersistenceAndRecoveryDeps = {
    buildCurrentSessionSnapshot: () => ({ messages: [], timestamp: Date.now(), title: 't' }),
    runtime: { sessionId: 'this-session', model: 'm', provider: 'p' },
    conversation: { title: 't' },
    workingDir: work,
    homeDirectory: home,
    surface,
    systemMessageRouter: { high: (message) => high.push(message), low: () => {} },
    render: () => {},
    unsubs,
    uiServicesTurns: { on: (event, handler) => { if (event === 'TURN_COMPLETED') handlers.push(handler); return () => {}; } },
    hookDispatcher: { fire: async () => {} } as never,
    onStreamSpeedUpdate: () => {},
    ...overrides,
  };
  return { deps, surface, high, handlers, unsubs };
}

function seedAgedSnapshot(surface: ReturnType<typeof setup>['surface'], sessionId: string): void {
  writeRecoveryFile({ messages: [{ role: 'user', content: 'hi' } as never], timestamp: Date.now(), title: 'other' }, sessionId, 'other', { surface });
  // Past the live-refresh window, so only the liveness marker can mark it as another terminal's.
  const aged = (Date.now() - 10 * 60_000) / 1000;
  utimesSync(surface.recoveryFile(sessionId), aged, aged);
}

describe('recovery offer and liveness marker', () => {
  test('a snapshot another running terminal is refreshing is not offered', () => {
    const { deps, surface, high } = setup();
    seedAgedSnapshot(surface, 'other-session');
    // The parent process is alive and is not this process.
    writeLivenessMarker(surface, 'other-session', process.ppid);

    const result = wireSessionPersistenceAndRecovery(deps);
    clearInterval(result.recoveryInterval);

    expect(result.recoveryPending).toBeNull();
    expect(high.some((message) => message.includes('[Recovery] Found unsaved session'))).toBe(false);
  });

  test('the same snapshot with no live owner is offered', () => {
    const { deps, surface } = setup();
    seedAgedSnapshot(surface, 'other-session');

    const result = wireSessionPersistenceAndRecovery(deps);
    clearInterval(result.recoveryInterval);

    expect(result.recoveryPending).toBe('other-session');
  });

  test('this terminal writes its own marker at once and removes it on exit', () => {
    const { deps, surface, unsubs } = setup();

    clearInterval(wireSessionPersistenceAndRecovery(deps).recoveryInterval);
    expect(existsSync(livenessMarkerPathFor(surface, 'this-session'))).toBe(true);

    for (const unsub of unsubs) unsub();
    expect(existsSync(livenessMarkerPathFor(surface, 'this-session'))).toBe(false);
  });
});

describe('a session save that fails', () => {
  test('tells the owner once per failing streak, and again after a save succeeds', () => {
    let failing = true;
    const { deps, high, handlers } = setup({
      buildCurrentSessionSnapshot: () => {
        if (failing) throw new Error('disk full');
        return { messages: [], timestamp: Date.now(), title: 't' };
      },
    });
    clearInterval(wireSessionPersistenceAndRecovery(deps).recoveryInterval);
    const turnCompleted = handlers[0]!;

    turnCompleted();
    turnCompleted();
    expect(high.filter((message) => message.startsWith('[Session]'))).toHaveLength(1);

    failing = false;
    turnCompleted();
    failing = true;
    turnCompleted();
    expect(high.filter((message) => message.startsWith('[Session]'))).toHaveLength(2);
  });
});
