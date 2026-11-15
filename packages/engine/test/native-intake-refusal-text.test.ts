/** Owned synthetic fixtures only: no settings, real tokens, providers or executors. */
import * as fs from 'node:fs';
import { afterEach, expect, test } from 'bun:test';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { KnowledgeStore } from '../platform/src/platform/knowledge/store.js';
import { executionIntentMoveText, executionRecordMoveText, intakeMoveText } from '../platform/src/platform/knowledge/store-native-refusal.js';
import {
  nativeConversationSourceId, nativeConversationSourceRevision, parseNativeConversationCapture,
  type NativeConversationCapture,
} from '../platform/src/platform/workflow/work-ledger/native-intake-types.js';

const roots: string[] = [], stores: KnowledgeStore[] = [];
afterEach(async () => { await Promise.all(stores.splice(0).map(store => store.close())); for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });
const key = { principalId: 'owner', inputId: 'input' };

function capture(changes: Partial<NativeConversationCapture> = {}): NativeConversationCapture {
  const value = { version: 1 as const, projectId: 'project', ...key, requestId: 'request', text: 'Same task', unsupportedSources: [], sessionId: 'session',
    owner: { authorityId: 'owner', authorityRevision: 'token', authorityScopes: ['read:work-ledger', 'write:work-ledger'], scopeId: 'scope', scopeRevision: 'scope-generation', projectRoot: '/owned-fixture' },
    generation: 1, state: 'captured' as const, stage: null, route: null, reason: null, proposalsSpent: 0, proposal: null, decisions: [], association: null, ...changes };
  return parseNativeConversationCapture({ ...value, sourceId: nativeConversationSourceId(value.projectId, value.principalId, value.inputId), sourceRevision: nativeConversationSourceRevision(value) });
}

async function capturedStorage() {
  const root = fs.mkdtempSync(join(tmpdir(), 'native-intake-refusal-')); roots.push(root);
  const store = new KnowledgeStore({ dbPath: join(root, 'knowledge.sqlite') }); stores.push(store);
  const storage = await store.openNativeConversationStorage('project');
  const initial = capture();
  await storage.transaction(key, () => ({ next: initial, value: undefined }));
  return { storage, initial };
}

async function refusal(storage: Awaited<ReturnType<typeof capturedStorage>>['storage'], next: NativeConversationCapture): Promise<string> {
  const error = await storage.transaction(key, () => ({ next, value: undefined })).then(() => null, (thrown: unknown) => thrown);
  expect(error).toMatchObject({ code: 'conflict' });
  return String((error as Error).message);
}

test('a write that keeps the capture state but changes another field does not claim the state cannot be reached', async () => {
  const { storage, initial } = await capturedStorage();
  const message = await refusal(storage, { ...initial, generation: 2 } as NativeConversationCapture);
  expect(message).toContain('keeps that state, but it changes a field that cannot change in captured');
  expect(message).not.toContain('cannot become captured');
});

test('a state move the capture does not allow names the state and the moves it does allow', async () => {
  const { storage, initial } = await capturedStorage();
  const classic = { provenance: 'owner' as const, policy: 'Classic - Off' as const, reason: 'selected' as const };
  const message = await refusal(storage, { ...initial, state: 'turn', route: 'converse', classic } as NativeConversationCapture);
  expect(message).toContain('cannot become turn');
  expect(message).toContain('processing (next generation)');
  const sameGeneration = await refusal(storage, { ...initial, state: 'processing', stage: 'extracting', route: 'contract' } as NativeConversationCapture);
  expect(sameGeneration).toContain('cannot become processing');
});

test('the moves the refusal names are accepted: processing and cancelled at the next generation', async () => {
  for (const next of [
    (initial: NativeConversationCapture) => ({ ...initial, generation: 2, state: 'processing' as const, stage: 'extracting' as const, route: 'contract' as const }),
    (initial: NativeConversationCapture) => ({ ...initial, generation: 2, state: 'cancelled' as const }),
    (initial: NativeConversationCapture) => initial,
  ]) {
    const { storage, initial } = await capturedStorage();
    await expect(storage.transaction(key, () => ({ next: parseNativeConversationCapture(next(initial)), value: undefined }))).resolves.toBeUndefined();
  }
});

test('the execution texts separate a changed fact from a state move', () => {
  expect(executionRecordMoveText('launch-claimed', 'launch-claimed', true)).toContain('changes facts fixed when the record was created');
  expect(executionRecordMoveText('launch-claimed', 'launch-claimed', true)).not.toContain('cannot become');
  expect(executionRecordMoveText('launch-claimed', 'prepared')).toContain('cannot become prepared');
  expect(executionIntentMoveText('refused', 'refused', true)).toContain('changes facts fixed when the intent was created');
  expect(executionIntentMoveText('associated', 'refused')).toContain('cannot become refused');
});

test('for every capture state, the moves the refusal names are exactly the state moves the store accepts', async () => {
  const root = fs.mkdtempSync(join(tmpdir(), 'native-intake-moves-')); roots.push(root);
  const store = new KnowledgeStore({ dbPath: join(root, 'knowledge.sqlite') }); stores.push(store);
  const storage = await store.openNativeConversationStorage('project');
  const classic = { provenance: 'owner' as const, policy: 'Classic - Off' as const, reason: 'selected' as const };
  type State = NativeConversationCapture['state'];
  let serial = 0;
  const moveTo = async (id: string, build: (current: NativeConversationCapture) => Record<string, unknown>): Promise<void> => {
    const k = { principalId: 'owner', inputId: id };
    await storage.transaction(k, current => ({ next: parseNativeConversationCapture(build(current!)), value: undefined }));
  };
  const seed = async (state: State): Promise<NativeConversationCapture> => {
    const id = `${state}-${++serial}`, k = { principalId: 'owner', inputId: id };
    await storage.transaction(k, () => ({ next: capture({ ...k, requestId: id }), value: undefined }));
    const processing = (c: NativeConversationCapture) => ({ ...c, generation: 2, state: 'processing', stage: 'extracting', route: 'contract' });
    if (state === 'processing') await moveTo(id, processing);
    if (state === 'blocked' || state === 'refused') {
      await moveTo(id, processing);
      await moveTo(id, c => ({ ...c, state, stage: null, reason: state === 'blocked' ? 'semantic' : 'exhausted' }));
    }
    if (state === 'turn') {
      await moveTo(id, processing);
      await moveTo(id, c => ({ ...c, state: 'turn', stage: null, route: 'converse', classic }));
    }
    if (state === 'cancelled') await moveTo(id, c => ({ ...c, generation: 2, state: 'cancelled' }));
    return storage.current(k)!;
  };
  // A move is tried against a fresh capture per attempt: an accepted one changes the state.
  const accepted = async (from: State, to: State, nextGeneration: boolean): Promise<boolean> => {
    const current = await seed(from);
    const next: Record<string, unknown> = { ...current, generation: current.generation + (nextGeneration ? 1 : 0), state: to };
    if (to === 'processing') Object.assign(next, { stage: 'extracting', route: 'contract' });
    else if (to === 'turn') Object.assign(next, { stage: null, route: 'converse', classic });
    else if (to === 'blocked' || to === 'refused') Object.assign(next, { stage: null, reason: 'semantic' });
    else next.stage = null;
    try {
      const parsed = parseNativeConversationCapture(next);
      await storage.transaction({ principalId: 'owner', inputId: current.inputId }, () => ({ next: parsed, value: undefined }));
      return true;
    } catch { return false; }
  };
  // `associated` is reached only by publishing work through the ledger, not by a plain write.
  const states: State[] = ['captured', 'processing', 'blocked', 'refused', 'turn', 'cancelled'];
  for (const from of states) {
    const text = intakeMoveText(from, 'associated').split('legal moves are ')[1]!;
    const named = states.filter(to => to !== from && new RegExp(`\\b${to}\\b`, 'u').test(text));
    const taken: State[] = [];
    for (const to of states) {
      if (to === from) continue;
      const same = await accepted(from, to, false), next = await accepted(from, to, true);
      if (same || next) taken.push(to);
      if (next && !same) expect(text).toContain(`${to} (next generation)`);
    }
    expect({ from, named }).toEqual({ from, named: taken });
  }
  // From processing a later pass at the next generation is also legal, and the text must say so.
  expect(await accepted('processing', 'processing', true)).toBe(true);
  expect(intakeMoveText('processing', 'associated')).toContain('processing (same or next generation)');
});
