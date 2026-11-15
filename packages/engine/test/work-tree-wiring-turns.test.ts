import { describe, expect, test } from 'bun:test';
import type { ConversationMessageSnapshot } from '@goodvibes-jev/engine/platform/platform/core';
import { createSessionContractViews, wireWorkTree, type WorkTreeConversation, type WorkTreeWiringDeps } from '../terminal-shell/src/work-tree-wiring.ts';
import type { WorkTreeSources } from '../terminal-shell/src/work-tree-sources.ts';
import { makeProjectTempDir } from './_helpers/project-temp.ts';

type Handler = (event: Record<string, unknown>) => void;

function harness() {
  const handlers = new Map<string, Handler[]>();
  const on = (type: string, handler: Handler): (() => void) => {
    handlers.set(type, [...(handlers.get(type) ?? []), handler]);
    return () => handlers.set(type, (handlers.get(type) ?? []).filter((h) => h !== handler));
  };
  const emit = (type: string, event: Record<string, unknown>): void => { for (const handler of handlers.get(type) ?? []) handler(event); };
  const outcomes: Array<{ outcome: string }> = [];
  let sources: WorkTreeSources | undefined;
  let resetListener: (() => void) | undefined;
  let foldListener: (() => void) | null | undefined;
  const messages = [{ role: 'user', content: 'build it' }] as unknown as readonly ConversationMessageSnapshot[];
  const conversation = {
    workTree: {
      invalidate() {}, onReset: (listener: () => void) => { resetListener = listener; return () => {}; },
      onFoldChange: (listener: (() => void) | null) => { foldListener = listener; },
      recordTurnOutcome: (record: { outcome: string }) => { outcomes.push(record); return true; },
      foldState: () => [], turnOutcomes: () => [], turnOutcome: () => undefined, restoreFoldState() {}, restoreTurnOutcomes() {},
    },
    getMessageSnapshot: () => messages,
    setWorkTreeSources: (next: WorkTreeSources) => { sources = next; },
  } as unknown as WorkTreeConversation;
  let snapshotReads = 0;
  const agentManager = {
    getStatus: (id: string) => ({ id, status: 'completed', completedAt: 1, startedAt: 0, toolCallCount: 0, template: 'engineer', task: 'work' }),
    getConversationSnapshot: () => { snapshotReads++; return []; },
  };
  const deps = {
    conversation, events: { turns: { on }, tools: { on } }, agentManager, contracts: createSessionContractViews({ list: () => [], on: () => () => {} }, () => 's1'), fleetNodes: () => [],
    pendingCallId: () => undefined, turnActive: () => false, sessionsDir: makeProjectTempDir('work-tree-wiring-'), sessionId: () => 's1', requestRender() {},
  } as unknown as WorkTreeWiringDeps;
  const wiring = wireWorkTree(deps);
  return { wiring, emit, outcomes, sources: () => sources!, reads: () => snapshotReads, reset: () => resetListener?.(), foldListener: () => foldListener };
}

describe('work tree turn tracking', () => {
  test('a duplicate submission that is refused does not end the turn that is still running', () => {
    const h = harness();
    h.emit('TURN_SUBMITTED', { turnId: 'a' });
    h.emit('TURN_SUBMITTED', { turnId: 'dup' });
    h.emit('PREFLIGHT_FAIL', { turnId: 'dup', stopReason: 'preflight_failed' });
    expect(h.wiring.timings.turnTiming(0)?.outcome).toBeUndefined();
    h.emit('TURN_COMPLETED', { turnId: 'a', stopReason: 'completed' });
    expect(h.wiring.timings.turnTiming(0)?.outcome).toBe('completed');
    expect(h.outcomes.map((o) => o.outcome)).toEqual(['completed']);
  });

  test('a preflight failure of a turn that really started still ends it as failed', () => {
    const h = harness();
    h.emit('TURN_SUBMITTED', { turnId: 'a' });
    h.emit('PREFLIGHT_FAIL', { turnId: 'a', stopReason: 'preflight_failed' });
    expect(h.wiring.timings.turnTiming(0)?.outcome).toBe('failed');
  });
});

describe('work tree wiring lifetime', () => {
  test('finished agent transcripts are kept only up to a bound, newest last', () => {
    const h = harness();
    for (let i = 0; i < 1000; i++) h.sources().agent!(`agent-${i}`);
    expect(h.reads()).toBe(1000);
    h.sources().agent!('agent-999');
    expect(h.reads()).toBe(1000); // recent: served from memory
    h.sources().agent!('agent-0');
    expect(h.reads()).toBe(1001); // oldest: evicted, read again
  });

  test('a transcript reset drops every kept agent transcript', () => {
    const h = harness();
    h.sources().agent!('agent-1');
    h.sources().agent!('agent-1');
    expect(h.reads()).toBe(1);
    h.reset();
    h.sources().agent!('agent-1');
    expect(h.reads()).toBe(2);
  });

  test('tearing the wiring down detaches the fold listener', () => {
    const h = harness();
    expect(h.foldListener()).toBeTypeOf('function');
    for (const unsub of h.wiring.unsubs) unsub();
    expect(h.foldListener()).toBeNull();
  });
});
