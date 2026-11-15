/**
 * session-browser-resume-liveness-confirm.test.ts, the multi-instance guard on the
 * session-browser resume seam.
 *
 * `/session resume <id>` already refused to fork a session another terminal
 * had open, telling the operator to re-run with `--force`. The session-browser seam had
 * no such check at all: picking a row in the session browser forked the other
 * instance's live state silently. The session-browser seam has no argv to carry a
 * `--force`, so it asks the same question as a modal.
 *
 * Best-effort semantics are unchanged and are pinned here: a missing, stale,
 * or own-process marker never asks anything and never blocks.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import type { SessionSurface } from '@/runtime/index.ts';
import {
  buildLiveResumeConfirmItems,
  LIVE_RESUME_CONFIRM_TITLE,
  confirmLiveResume,
  type LiveResumeSelectionOpener,
} from '../../runtime/session-resume-liveness-confirm.ts';
import { createResumeSessionHandler } from '../../runtime/bootstrap-hook-bridge.ts';
import { ConversationManager } from '../../core/conversation.ts';
import { writeLivenessMarker, livenessMarkerPathFor, LIVENESS_STALE_AFTER_MS } from '@goodvibes-jev/engine/platform/platform/runtime/operations';
import type { ConfirmOptions } from '../../input/confirm-dialog.ts';
import { makeProjectTempDir } from '../helpers/project-temp.ts';
import { makeTestSurface } from '../helpers/session-surface.ts';

let tmpDir: string;
let surface: SessionSurface;

beforeEach(() => {
  tmpDir = makeProjectTempDir('gv-session-browser-liveness');
  surface = makeTestSurface(tmpDir);
});
afterEach(() => { if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true, force: true }); });

/** An operator that answers the confirm modal with the given item id (null = dismissed). */
function operator(answer: string | null): { open: LiveResumeSelectionOpener; titles: string[]; details: string[]; asked: () => number } {
  const titles: string[] = [];
  const details: string[] = [];
  const open: LiveResumeSelectionOpener = (title, items, _opts, cb) => {
    titles.push(title);
    details.push(items.map((i) => i.detail ?? '').join('\n'));
    cb(answer === null ? null : { item: { id: answer, label: answer }, action: 'select' });
  };
  return { open, titles, details, asked: () => titles.length };
}

describe('confirmLiveResume: when it asks at all', () => {
  test('no marker: proceeds without asking', async () => {
    const op = operator('cancel');
    expect(await confirmLiveResume('sess-none', { surface, openSelection: () => op.open })).toBe(true);
    expect(op.asked()).toBe(0);
  });

  test("this process's OWN marker never asks; re-resuming the session already open here is not a fork", async () => {
    writeLivenessMarker(surface, 'sess-self', process.pid);
    const op = operator('cancel');
    expect(await confirmLiveResume('sess-self', { surface, openSelection: () => op.open, selfPid: process.pid })).toBe(true);
    expect(op.asked()).toBe(0);
  });

  test('a marker older than the staleness window never asks and never blocks; best-effort, not a lock', async () => {
    // A live pid that is not this process, so only the age can make it not live.
    writeLivenessMarker(surface, 'sess-stale', process.pid);
    const markerPath = livenessMarkerPathFor(surface, 'sess-stale');
    const marker = JSON.parse(readFileSync(markerPath, 'utf-8')) as { updatedAt: number };
    marker.updatedAt = Date.now() - LIVENESS_STALE_AFTER_MS - 60_000;
    writeFileSync(markerPath, JSON.stringify(marker));
    const op = operator('cancel');
    expect(await confirmLiveResume('sess-stale', { surface, openSelection: () => op.open, selfPid: 999_999 })).toBe(true);
    expect(op.asked()).toBe(0);
  });

  test('a fresh marker for the same live pid does ask, so the stale case above is decided by age alone', async () => {
    writeLivenessMarker(surface, 'sess-fresh', process.pid);
    const op = operator('cancel');
    expect(await confirmLiveResume('sess-fresh', { surface, openSelection: () => op.open, selfPid: 999_999 })).toBe(false);
    expect(op.asked()).toBe(1);
  });

  test('a marker whose process is gone never asks', async () => {
    writeLivenessMarker(surface, 'sess-dead', 2_147_483_000);
    const op = operator('cancel');
    expect(await confirmLiveResume('sess-dead', { surface, openSelection: () => op.open })).toBe(true);
    expect(op.asked()).toBe(0);
  });

  test('no selection surface (headless): proceeds as the seam always did rather than silently refusing', async () => {
    writeLivenessMarker(surface, 'sess-live', process.pid);
    expect(await confirmLiveResume('sess-live', { surface, openSelection: () => undefined, selfPid: 999_999 })).toBe(true);
  });
});

describe('confirmLiveResume: the question and its answers', () => {
  test('the shell confirm dialog is preferred: its answer is the result and the selection list is not consulted', async () => {
    writeLivenessMarker(surface, 'sess-other', process.pid);
    const op = operator('resume');
    const asked: ConfirmOptions[] = [];
    const confirm = (answer: boolean) => () => async (options: ConfirmOptions): Promise<boolean> => { asked.push(options); return answer; };

    expect(await confirmLiveResume('sess-other', { surface, openSelection: () => op.open, confirm: confirm(true), selfPid: 999_999 })).toBe(true);
    expect(await confirmLiveResume('sess-other', { surface, openSelection: () => op.open, confirm: confirm(false), selfPid: 999_999 })).toBe(false);
    expect(op.asked()).toBe(0);
    expect(asked).toHaveLength(2);
    expect(asked[0]!.title).toBe(`${LIVE_RESUME_CONFIRM_TITLE}?`);
    expect(asked[0]!.body).toContain(`pid ${process.pid}`);
    expect(asked[0]!.confirmLabel).toBe('Resume anyway');
    expect(asked[0]!.tone).toBe('warning');
  });

  test('the shell confirm dialog is not asked when there is nothing to warn about', async () => {
    let asks = 0;
    const confirm = () => async (): Promise<boolean> => { asks++; return false; };
    expect(await confirmLiveResume('sess-none', { surface, openSelection: () => undefined, confirm, selfPid: 999_999 })).toBe(true);
    expect(asks).toBe(0);
  });

  test('a confirm hook that has no dialog yet falls back to the selection list', async () => {
    writeLivenessMarker(surface, 'sess-other', process.pid);
    const op = operator('cancel');
    expect(await confirmLiveResume('sess-other', { surface, openSelection: () => op.open, confirm: () => undefined, selfPid: 999_999 })).toBe(false);
    expect(op.asked()).toBe(1);
  });

  test('a live marker from a DIFFERENT pid asks, naming that pid where it cannot be clipped', async () => {
    writeLivenessMarker(surface, 'sess-other', process.pid);
    const op = operator('resume');

    expect(await confirmLiveResume('sess-other', { surface, openSelection: () => op.open, selfPid: 999_999 })).toBe(true);
    expect(op.asked()).toBe(1);
    // The overlay truncates its title and wraps a row's detail, so the pid
    // (the one fact that lets the operator go look at the other terminal) and
    // the consequence both live in the detail.
    expect(op.titles[0]).toBe(LIVE_RESUME_CONFIRM_TITLE);
    expect(op.details[0]).toContain(`pid ${process.pid}`);
    expect(op.details[0]).toContain('fork its live state');
  });

  test('Cancel refuses the resume', async () => {
    writeLivenessMarker(surface, 'sess-other', process.pid);
    const op = operator('cancel');
    expect(await confirmLiveResume('sess-other', { surface, openSelection: () => op.open, selfPid: 999_999 })).toBe(false);
  });

  test('a dismissed modal refuses: the safe answer to an unanswered fork question is no', async () => {
    writeLivenessMarker(surface, 'sess-other', process.pid);
    const op = operator(null);
    expect(await confirmLiveResume('sess-other', { surface, openSelection: () => op.open, selfPid: 999_999 })).toBe(false);
  });

  test('the modal shows complete, non-clipped copy for both choices', () => {
    const items = buildLiveResumeConfirmItems(4242);
    expect(items.map((i) => i.id)).toEqual(['resume', 'cancel']);
    for (const item of items) {
      expect(item.detail).toBeTruthy();
      expect(item.detail!.endsWith('.')).toBe(true);
    }
    expect(items[0]!.detail).toContain('4242');
    // The title must survive the narrowest box the overlay builds (see
    // getOverlaySurfaceMetrics: margin 4, maxWidth 72, ~28 inner columns at
    // a 40-column terminal), because titles are truncated, not wrapped.
    expect(LIVE_RESUME_CONFIRM_TITLE.length).toBeLessThanOrEqual(28);
  });
});

// ── The seam itself ─────────────────────────────────────────────────────────

function makeResumeOptions(overrides: Record<string, unknown>) {
  const conversation = new ConversationManager(() => 80);
  const loaded = { messages: [{ role: 'user', content: 'from the other terminal' }], meta: { title: 't', titleSource: 'auto', timestamp: Date.now(), model: 'm', provider: 'p', returnContext: undefined } };
  return {
    conversation,
    options: {
      runtimeBus: { emit: () => {} },
      runtime: { sessionId: 'boot-session', model: 'm', provider: 'p' },
      conversation,
      requestRender: () => {},
      onSessionIdChanged: () => {},
      sharedSessionBroker: { reopenSession: async () => {} },
      sessionSpine: { reopen: () => {} },
      project: tmpDir,
      writeLastSessionPointer: () => {},
      hookDispatcher: { fire: async () => ({ fired: 0 }) },
      sessionManager: { load: () => loaded, save: () => {}, list: () => [] },
      panelManager: { open: () => {}, show: () => {}, getModalRedirect: () => undefined },
      surface,
      configManager: { get: () => 'off', getCategory: () => ({}) },
      providerRegistry: {},
      ...overrides,
    } as never,
  };
}

describe('the session-browser resume seam honours the confirm', () => {
  test('Cancel stops the resume before any conversation state is touched', async () => {
    const logged: string[] = [];
    const { conversation, options } = makeResumeOptions({
      confirmLiveResume: async () => false,
      conversation: undefined,
    });
    // Re-point the conversation log so the receipt is observable.
    (options as { conversation: ConversationManager }).conversation = conversation;
    conversation.log = ((line: string) => { logged.push(line); }) as never;

    const resume = createResumeSessionHandler(options);
    await resume('sess-other');

    expect(conversation.getMessageCount()).toBe(0);
    expect(logged.join('\n')).toContain('still open in another terminal');
  });

  test('Resume anyway proceeds and the session is loaded', async () => {
    const { conversation, options } = makeResumeOptions({ confirmLiveResume: async () => true });
    const resume = createResumeSessionHandler(options);
    await resume('sess-other');

    expect(conversation.getMessageCount()).toBe(1);
    expect((options as { runtime: { sessionId: string } }).runtime.sessionId).toBe('sess-other');
  });

  test('a seam wired without a confirm keeps the seam\'s original behavior', async () => {
    const { conversation, options } = makeResumeOptions({});
    const resume = createResumeSessionHandler(options);
    await resume('sess-other');

    expect(conversation.getMessageCount()).toBe(1);
  });
});

test('the browser resume seam revokes pending native retry admission before replacing the session', async () => {
  const { heldNativeRetry } = await import('../helpers/held-native-retry.ts');
  const native = await heldNativeRetry(); const result = native.start(); let cancelled = 0;
  const runtime = { sessionId: 'boot-session', model: 'm', provider: 'p' };
  const { options } = makeResumeOptions({ runtime, cancelPendingRecovery: () => {
    expect(runtime.sessionId).toBe('boot-session'); cancelled++; return native.cancel();
  } });
  try {
    await native.waiting; expect(native.orchestrator.isThinking).toBe(false);
    await createResumeSessionHandler(options)('other-session');
    expect(cancelled).toBe(1); expect(runtime.sessionId).toBe('other-session');
    native.release(); expect(await result).toMatchObject({ status: 'rejected', reason: { name: 'AbortError' }, signalAborted: true, messageCount: 0 });
    expect(native.conversation.getMessageCount()).toBe(0);
  } finally { native.dispose(); await result; }
});
