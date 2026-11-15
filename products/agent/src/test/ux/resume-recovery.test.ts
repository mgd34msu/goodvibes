/**
 * UX Anti-Regression: Resume/Recovery With Active State
 *
 * Drives the real runtime store: the session resume-repair event decides whether
 * recovery is ready, session metadata patches merge without losing identity, and
 * overlays and the conversation are left alone.
 */
import { describe, test, expect } from 'bun:test';
import { createRuntimeStore, createDomainDispatch } from '../../runtime/store/index.ts';
import {
  selectSession,
  selectAnyOverlayVisible,
  selectConversation,
} from '../../runtime/store/selectors/index.ts';

function makeStore() {
  const store = createRuntimeStore();
  const dispatch = createDomainDispatch(store);
  dispatch.syncSessionState({ id: 'sess-1', status: 'suspended', recoveryState: 'loading', isResumed: false }, 'suspend');
  return { store, dispatch };
}

describe('ux:resume-recovery: resume session', () => {
  test('a repair that is safe to resume moves recovery to ready and records the repair', () => {
    const { store, dispatch } = makeStore();

    dispatch.dispatchCompactionEvent({
      type: 'COMPACTION_RESUME_REPAIR',
      sessionId: 'sess-1',
      repaired: true,
      actionsCount: 2,
      safeToResume: true,
    });

    const session = selectSession(store.getState());
    expect(session.recoveryState).toBe('ready');
    expect(session.wasRepaired).toBe(true);
  });

  test('a repair that is not safe to resume leaves recovery where it was', () => {
    const { store, dispatch } = makeStore();

    dispatch.dispatchCompactionEvent({
      type: 'COMPACTION_RESUME_REPAIR',
      sessionId: 'sess-1',
      repaired: true,
      actionsCount: 4,
      safeToResume: false,
    });

    const session = selectSession(store.getState());
    expect(session.recoveryState).toBe('loading');
    expect(session.wasRepaired).toBe(true);
  });

  test('marking the session resumed keeps its id and unrelated fields, and advances the revision', () => {
    const { store, dispatch } = makeStore();
    const before = selectSession(store.getState());

    dispatch.syncSessionState({ status: 'active', isResumed: true }, 'resume');

    const after = selectSession(store.getState());
    expect(after.id).toBe('sess-1');
    expect(after.status).toBe('active');
    expect(after.isResumed).toBe(true);
    expect(after.recoveryState).toBe(before.recoveryState);
    expect(after.revision).toBeGreaterThan(before.revision);
    expect(after.source).toBe('resume');
  });

  test('repeated suspend and resume cycles end in the last state written', () => {
    const { store, dispatch } = makeStore();
    for (let i = 0; i < 5; i++) {
      dispatch.syncSessionState({ status: 'suspended' }, 'suspend');
      dispatch.syncSessionState({ status: 'active', isResumed: true }, 'resume');
    }

    const session = selectSession(store.getState());
    expect(session.status).toBe('active');
    expect(session.isResumed).toBe(true);
    expect(session.id).toBe('sess-1');
  });

  test('resume leaves overlays hidden and the conversation untouched', () => {
    const { store, dispatch } = makeStore();
    const conversation = selectConversation(store.getState());

    dispatch.dispatchCompactionEvent({
      type: 'COMPACTION_RESUME_REPAIR',
      sessionId: 'sess-1',
      repaired: false,
      actionsCount: 0,
      safeToResume: true,
    });
    dispatch.syncSessionState({ status: 'active', isResumed: true }, 'resume');

    expect(selectAnyOverlayVisible(store.getState())).toBe(false);
    expect(selectConversation(store.getState())).toBe(conversation);
  });
});
