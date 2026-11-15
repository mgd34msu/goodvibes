import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { Question } from '@goodvibes-jev/judgment';
import { choiceAnswer, fakePort } from '@goodvibes-jev/judgment/testing';
import { installJudgmentPort } from '@goodvibes-jev/engine/errors';
import type { SideEffectKind } from '../platform/src/platform/gate/batteries/side-effect.ts';
import {
  readPermissionCategory,
  TOOL_PERMISSION_SAFETY_SITE,
} from '../platform/src/platform/gate/policy/tool-permission-safety.ts';

/** What Jev reads for a call, keyed by text in the call; the confidence says how sure. */
const KINDS: ReadonlyArray<readonly [text: string, kind: SideEffectKind, confidence: number]> = [
  ['"summary"', 'read', 0.95],
  ['"learning_auto_promote"', 'write', 0.95],
  ['"docs_page"', 'network', 0.95],
  ['"kill"', 'shell', 0.95],
  ['"spawn"', 'delegation', 0.95],
  ['"navigate"', 'browser', 0.95],
  ['"unsure"', 'read', 0.4],
];

let requests: ReadonlyArray<{ readonly site?: string | undefined; readonly state: unknown }> = [];
let previous: ReturnType<typeof installJudgmentPort>;

beforeEach(() => {
  const fake = fakePort((name: string, question: Question, state: unknown) => {
    if (name !== 'kind') throw new Error(`unexpected question ${name}`);
    const text = JSON.stringify(state);
    const [, kind, confidence] = KINDS.find(([match]) => text.includes(match)) ?? ['', 'other', 0.95];
    return choiceAnswer(question, kind, confidence);
  });
  requests = fake.requests as typeof requests;
  previous = installJudgmentPort(fake.port);
});

afterEach(() => {
  installJudgmentPort(previous);
});

describe('readPermissionCategory: the side-effect kind, mapped to a category', () => {
  test('each kind maps to its category, with the reading\'s confidence', async () => {
    expect(await readPermissionCategory('agent_harness', { mode: 'summary' })).toEqual({ category: 'read', confident: true });
    expect(await readPermissionCategory('agent_harness', { mode: 'learning_auto_promote' })).toEqual({ category: 'write', confident: true });
    expect(await readPermissionCategory('process', { action: 'kill' })).toEqual({ category: 'execute', confident: true });
    expect(await readPermissionCategory('agent', { mode: 'spawn' })).toEqual({ category: 'delegate', confident: true });
    expect(await readPermissionCategory('browser', { action: 'navigate' })).toEqual({ category: 'execute', confident: true });
    expect(await readPermissionCategory('fetch', { url: 'docs_page' })).toEqual({ category: 'read', confident: true });
    expect(await readPermissionCategory('memory', { action: 'unsure' })).toEqual({ category: 'read', confident: false });
  });

  test('category input is captured before the cancellation helper yields', async () => {
    const args = { mode: 'summary' };
    const pending = readPermissionCategory('agent_harness', args);
    args.mode = 'learning_auto_promote';
    expect(await pending).toEqual({ category: 'read', confident: true });
    expect(JSON.stringify(requests[0])).toContain('summary');
    expect(JSON.stringify(requests[0])).not.toContain('learning_auto_promote');
  });

  test('category cancellation reaches Jev and discards a late non-cooperative answer', async () => {
    const controller = new AbortController();
    let enter!: () => void;
    const entered = new Promise<void>((resolve) => { enter = resolve; });
    let release!: () => void;
    const pending = new Promise<void>((resolve) => { release = resolve; });
    let seenSignal: AbortSignal | undefined;
    // The first ask is answered late with a different category than any later ask,
    // so a late answer that was cached or published would surface in the fresh call.
    const late = fakePort((_name, question) => choiceAnswer(question, 'write', 0.99));
    const fresh = fakePort((_name, question) => choiceAnswer(question, 'read', 0.99));
    let asks = 0;
    installJudgmentPort({ model: fresh.port.model, async ask(request) {
      asks += 1;
      if (asks > 1) return fresh.port.ask(request);
      seenSignal = request.signal; enter(); await pending; return late.port.ask(request);
    } });
    const outcome = readPermissionCategory('read', {}, undefined, controller.signal).catch((error: unknown) => error);
    await entered;
    expect(seenSignal).toBe(controller.signal);
    controller.abort('private caller reason');
    expect(await outcome).toMatchObject({ name: 'JudgmentError', kind: 'aborted' });
    expect(JSON.stringify(await outcome)).not.toContain('private caller reason');
    release();
    expect(await readPermissionCategory('read', {})).toEqual({ category: 'read', confident: true });
    expect(asks).toBe(2);
  });

  test('the reading is asked at the tool-permission-safety site, one question per call', async () => {
    await readPermissionCategory('agent_harness', { mode: 'summary' });
    expect(requests).toHaveLength(1);
    expect(JSON.stringify(requests[0])).toContain(TOOL_PERMISSION_SAFETY_SITE);
  });
});
