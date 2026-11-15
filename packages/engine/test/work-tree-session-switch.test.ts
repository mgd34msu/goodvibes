import { describe, expect, test } from 'bun:test';
import type { ConversationMessageSnapshot } from '@goodvibes-jev/engine/platform/platform/core';
import { wireWorkTree, type WorkTreeConversation, type WorkTreeWiringDeps } from '../terminal-shell/src/work-tree-wiring.ts';
import { loadWorkTreeFolds, saveWorkTreeFolds } from '../terminal-shell/src/work-tree-fold-store.ts';
import { makeProjectTempDir } from './_helpers/project-temp.ts';

describe('work tree folds when the session id moves without a resume', () => {
  test('the first fold change under a recovered session id keeps that session\'s saved folds', () => {
    const sessionsDir = makeProjectTempDir('work-tree-switch-');
    saveWorkTreeFolds(sessionsDir, 'recovered', [['turn_0', true], ['turn_1', false]], []);
    const live = new Map<string, boolean>([['turn_9', true]]);
    let foldListener: (() => void) | null = null;
    const conversation = {
      workTree: {
        invalidate() {}, onReset: () => () => {},
        onFoldChange: (listener: (() => void) | null) => { foldListener = listener; },
        recordTurnOutcome: () => true,
        foldState: () => [...live],
        turnOutcomes: () => [], turnOutcome: () => undefined,
        restoreFoldState: (entries: Iterable<readonly [string, boolean]>) => { for (const [k, v] of entries) live.set(k, v); },
        restoreTurnOutcomes() {},
      },
      getMessageSnapshot: () => [] as readonly ConversationMessageSnapshot[],
      setWorkTreeSources() {},
    } as unknown as WorkTreeConversation;
    let sessionId = 'boot';
    wireWorkTree({
      conversation, events: { turns: { on: () => () => {} }, tools: { on: () => () => {} } }, agentManager: {},
      listContracts: () => [], fleetNodes: () => [], pendingCallId: () => undefined, turnActive: () => false,
      sessionsDir, sessionId: () => sessionId, requestRender() {},
    } as unknown as WorkTreeWiringDeps);

    sessionId = 'recovered'; // set directly by crash recovery, no resume routine
    live.set('turn_1', true); // the user toggles a fold this instant
    foldListener!();

    const saved = new Map(loadWorkTreeFolds(sessionsDir, 'recovered'));
    expect(saved.get('turn_0')).toBe(true); // the session's own fold survived
    expect(saved.get('turn_1')).toBe(true); // the live toggle won
  });
});
