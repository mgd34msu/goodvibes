/**
 * session-resume-core.test.ts, the canonical resume routine both resume
 * seams (session-workflow.ts's /session resume and bootstrap-hook-bridge.ts's
 * session-browser resume) now call.
 *
 * Covers the four divergences the audit found between the two seams (now
 * impossible by construction, since both call this one function):
 *   1. restoreTurnAnchors is always called.
 *   2. conversation.resetAll() always runs before fromJSON().
 *   3. The selectModel reselection fallback (raw id on failure) is honored
 *      when provided, and skipped cleanly when omitted.
 *   4. A session saved while the TUI still had side panes carries
 *      returnContext.openPanels; it loads, and the loaded return context
 *      no longer carries the pane list.
 *
 * Parity of the two real seams on one saved session is in seam-replay.test.ts.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { SessionManager } from '@goodvibes-jev/engine/platform/platform/sessions';
import { journalPathFor, openTranscriptJournal } from '@goodvibes-jev/engine/platform/platform/runtime/operations';
import { ConversationManager } from '../../core/conversation.ts';
import { makeProjectTempDir } from '../helpers/project-temp.ts';
import { resumeSessionCore } from '../../core/session-resume-core.ts';
import { clearTurnAnchors, getTurnAnchors, persistTurnAnchors, recordTurnAnchor } from '@goodvibes-jev/engine/platform/platform/rewind';
import { makeTestSurface } from '../helpers/session-surface.ts';
import { rewriteAsLegacyPaneSession } from '../helpers/legacy-pane-session.ts';

let tmpDir: string;

beforeEach(() => {
  tmpDir = makeProjectTempDir('gv-session-resume-core');
});

afterEach(() => {
  if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true, force: true });
});

function makeRuntime(sessionId = 'previous-session') {
  return { sessionId, model: 'old-model', provider: 'old-provider' };
}

describe('resumeSessionCore journal replay', () => {
  test('the write that closes a replayed journal gap is stamped as an automatic save, not one the user asked for', async () => {
    const surface = makeTestSurface(tmpDir);
    const sm = new SessionManager(tmpDir, { surface });
    sm.save('sess-gap', [{ role: 'user', content: 'snapshot message' }], {
      title: 'Gap', model: 'm', provider: 'p', timestamp: Date.now() - 5000, saveSource: 'auto',
    });
    const journalPath = journalPathFor(surface, 'sess-gap');
    mkdirSync(join(journalPath, '..'), { recursive: true });
    openTranscriptJournal(journalPath, 'sess-gap').appendRecord('assistant_turn', [
      { role: 'user', content: 'journaled question' },
      { role: 'assistant', content: 'journaled answer' },
    ] as never);

    const outcome = await resumeSessionCore('sess-gap', {
      sessionManager: sm,
      conversation: new ConversationManager(() => 80),
      runtime: makeRuntime(),
      surface,
    });

    expect(outcome.journalReplay.replayed).toBeGreaterThan(0);
    // The snapshot was an automatic save; a replay that stamped 'user' would upgrade it.
    expect(sm.getMeta('sess-gap')?.saveSource).toBe('auto');
  });
});

describe('resumeSessionCore', () => {
  test('resets and restores the conversation from the saved session, not appending to whatever was already live', async () => {
    const sm = new SessionManager(tmpDir, { surface: makeTestSurface(tmpDir) });
    sm.save('sess-a', [{ role: 'user', content: 'saved message' }], { title: 'Saved', model: 'm', provider: 'p', timestamp: Date.now() });

    const conversation = new ConversationManager(() => 80);
    // Pre-populate with unrelated live content the resume must fully replace.
    conversation.fromJSON({ messages: [{ role: 'user', content: 'stale live message 1' }, { role: 'assistant', content: 'stale live message 2' }] as never });
    expect(conversation.getMessageCount()).toBe(2);

    const outcome = await resumeSessionCore('sess-a', {
      sessionManager: sm,
      conversation,
      runtime: makeRuntime(),
      surface: makeTestSurface(tmpDir),
    });

    expect(outcome.resumedMessageCount).toBe(1);
    expect(conversation.getMessageCount()).toBe(1);
  });

  test('restores this session\'s persisted rewind anchors (restoreTurnAnchors is always called)', async () => {
    const sessionId = 'sess-anchors';
    clearTurnAnchors(sessionId);
    // Seed a sidecar the way a prior run would have (recordTurnAnchor + persistTurnAnchors).
    recordTurnAnchor(sessionId, { turnId: 't1', label: 'did a thing', messageCount: 1, at: Date.now() });
    persistTurnAnchors(sessionId, makeTestSurface(tmpDir));
    clearTurnAnchors(sessionId); // simulate a fresh process with an empty in-memory registry

    const sm = new SessionManager(tmpDir, { surface: makeTestSurface(tmpDir) });
    sm.save(sessionId, [{ role: 'user', content: 'hi' }], { title: 'T', model: 'm', provider: 'p', timestamp: Date.now() });
    const conversation = new ConversationManager(() => 80);

    const outcome = await resumeSessionCore(sessionId, {
      sessionManager: sm,
      conversation,
      runtime: makeRuntime(),
      surface: makeTestSurface(tmpDir),
    });

    expect(outcome.restoredAnchorCount).toBe(1);
    expect(getTurnAnchors(sessionId)).toHaveLength(1);
  });

  test('with selectModel provided: reselects through the live provider registry', async () => {
    const sm = new SessionManager(tmpDir, { surface: makeTestSurface(tmpDir) });
    sm.save('sess-model', [], { title: 'T', model: 'saved-model-id', provider: 'saved-provider', timestamp: Date.now() });
    const conversation = new ConversationManager(() => 80);
    const runtime = makeRuntime();

    const outcome = await resumeSessionCore('sess-model', {
      sessionManager: sm,
      conversation,
      runtime,
      surface: makeTestSurface(tmpDir),
      selectModel: async (model) => ({ registryKey: `resolved:${model}`, providerId: 'resolved-provider' }),
    });

    expect(runtime.model).toBe('resolved:saved-model-id');
    expect(runtime.provider).toBe('resolved-provider');
    expect(outcome.meta.model).toBe('saved-model-id');
  });

  test('with selectModel provided but it throws: falls back to the raw saved model id', async () => {
    const sm = new SessionManager(tmpDir, { surface: makeTestSurface(tmpDir) });
    sm.save('sess-model-gone', [], { title: 'T', model: 'no-longer-installed', provider: 'saved-provider', timestamp: Date.now() });
    const conversation = new ConversationManager(() => 80);
    const runtime = makeRuntime();

    await resumeSessionCore('sess-model-gone', {
      sessionManager: sm,
      conversation,
      runtime,
      surface: makeTestSurface(tmpDir),
      selectModel: async () => { throw new Error('model not found locally'); },
    });

    expect(runtime.model).toBe('no-longer-installed');
  });

  test('without selectModel: sets the model straight from the saved meta (the behavior when no provider API is wired)', async () => {
    const sm = new SessionManager(tmpDir, { surface: makeTestSurface(tmpDir) });
    sm.save('sess-direct-model', [], { title: 'T', model: 'direct-model-id', provider: 'direct-provider', timestamp: Date.now() });
    const conversation = new ConversationManager(() => 80);
    const runtime = makeRuntime();

    await resumeSessionCore('sess-direct-model', {
      sessionManager: sm,
      conversation,
      runtime,
      surface: makeTestSurface(tmpDir),
    });

    expect(runtime.model).toBe('direct-model-id');
    expect(runtime.provider).toBe('direct-provider');
  });

  test('calls hydrateSessionUsage exactly once when provided', async () => {
    const sm = new SessionManager(tmpDir, { surface: makeTestSurface(tmpDir) });
    sm.save('sess-hydrate', [], { title: 'T', model: 'm', provider: 'p', timestamp: Date.now() });
    const conversation = new ConversationManager(() => 80);
    let hydrateCalls = 0;

    await resumeSessionCore('sess-hydrate', {
      sessionManager: sm,
      conversation,
      runtime: makeRuntime(),
      surface: makeTestSurface(tmpDir),
      hydrateSessionUsage: () => { hydrateCalls++; },
    });

    expect(hydrateCalls).toBe(1);
  });

  test('a session saved with returnContext.openPanels (from when the TUI had side panes) loads; the loaded return context no longer carries the pane list', async () => {
    const sm = new SessionManager(tmpDir, { surface: makeTestSurface(tmpDir) });
    const { filePath } = sm.save('sess-panels', [{ role: 'user', content: 'from the pane era' }], {
      title: 'T', model: 'm', provider: 'p', timestamp: Date.now(),
    });
    rewriteAsLegacyPaneSession(filePath);
    expect(readFileSync(filePath, 'utf-8')).toContain('"openPanels"');
    const conversation = new ConversationManager(() => 80);

    const outcome = await resumeSessionCore('sess-panels', {
      sessionManager: sm,
      conversation,
      runtime: makeRuntime(),
      surface: makeTestSurface(tmpDir),
    });

    expect(outcome.resumedMessageCount).toBe(1);
    expect(conversation.getMessageCount()).toBe(1);
    const loaded = outcome.meta.returnContext as Record<string, unknown> | undefined;
    expect(loaded).toBeDefined();
    expect(loaded).not.toHaveProperty('openPanels');
    expect(outcome.meta.returnContext?.lines.some((line) => line.startsWith('Open panels'))).toBe(false);
    expect(outcome.meta.returnContext?.lines).toEqual(['Activity: idle', 'Status: idle']);
    expect(Object.keys(outcome)).not.toContain('panels');
  });
});
