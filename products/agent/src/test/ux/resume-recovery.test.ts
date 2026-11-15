/**
 * UX Anti-Regression: Resume/Recovery With Active State
 *
 * Drives the real runtime store: session metadata patches merge without losing
 * identity, and overlays and the conversation are left alone.
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

    dispatch.syncSessionState({ status: 'active', isResumed: true }, 'resume');

    expect(selectAnyOverlayVisible(store.getState())).toBe(false);
    expect(selectConversation(store.getState())).toBe(conversation);
  });
});
