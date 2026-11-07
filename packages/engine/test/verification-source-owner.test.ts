import { afterEach, expect, test } from 'bun:test';
import { appendFileSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { VerificationStore } from '../sdk/src/platform/core/verification/store.js';
import { issueVerificationSource, verificationSources, verificationWireSource } from '../sdk/src/platform/core/verification/source.js';
import { retainedDelegationSources } from '../sdk/src/platform/core/verification/delegated-history.js';
import { citedReadSources, nativeReadReceipts } from '../sdk/src/platform/core/verification/read-receipts.js';
import { observeReadContent } from '../sdk/src/platform/tools/read/observation.js';
import type { VerificationSourceInput } from '../sdk/src/platform/core/verification/types.js';
import { CompletionVerification } from '../sdk/src/platform/core/verification/coordinator.js';
import { fakePort, noulAnswer } from '@goodvibes-jev/judgment/testing';
import { verificationWriter } from './_helpers/verification.js';
import { ConversationManager } from '../sdk/src/platform/core/conversation.js';
import { appendVerificationObservation, archiveVerificationCompaction, registerVerificationArchive, verificationHistory, verificationMessages } from '../sdk/src/platform/core/verification/archive.js';
import { VerificationJournalSource } from '../sdk/src/platform/core/verification/journal-source.js';
import { ResponseCompletionGuard, type ResponseCompletionInput } from '../sdk/src/platform/core/response-completion.js';
import { installJudgmentPort } from '@goodvibes-jev/engine/errors';
import { JudgmentError } from '@goodvibes-jev/judgment';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function journal() {
  const root = mkdtempSync(join(tmpdir(), 'verification-source-owner-')); roots.push(root);
  const session = 'native-source-owner';
  return { root, session, path: join(root, '.goodvibes', 'verification', session + '.jsonl'),
    store: new VerificationStore(root, session) };
}
const source = (): VerificationSourceInput => ({ kind: 'observation', reference: 'native tool call; complete source', text: 'Actual returned bytes.',
  messageRole: 'tool', completeMessage: true, execution: { callId: 'actual-call', tool: 'read', exactArguments: { path: 'source.ts' } } });

async function holdForAccount(guard: ResponseCompletionGuard, input: ResponseCompletionInput): Promise<void> {
  const previous = installJudgmentPort({ model: 'laya', async ask() { throw new JudgmentError('rejected', 'Synthetic provider access refusal', { status: 402 }); } });
  try { await expect(guard.check(input)).rejects.toMatchObject({ problem: 'access-blocked', status: 402 }); }
  finally { installJudgmentPort(previous); }
}

test('unchanged source records reuse owned IDs without another journal write, including after restart', () => {
  const f = journal(); const input = source();
  const first = f.store.retainSource(input), bytes = readFileSync(f.path, 'utf8');
  expect(f.store.retainSource(structuredClone(input))).toBe(first);
  expect(readFileSync(f.path, 'utf8')).toBe(bytes);
  const reopened = new VerificationStore(f.root, f.session);
  const restored = reopened.retainSource(structuredClone(input));
  expect(restored.id).toBe(first.id);
  expect(restored.text).toBe(input.text);
  expect(readFileSync(f.path, 'utf8')).toBe(bytes);
  expect(Object.isFrozen(restored)).toBe(true);
});

test('each changed source or execution attribution receives a new native record, preserving prior bytes', () => {
  const store = new VerificationStore(); const input = source();
  const first = store.retainSource(input);
  const changed = store.retainSource({ ...input, text: 'A changed returned body.' });
  const restored = store.retainSource(input);
  const otherExecution = store.retainSource({ ...input, execution: { ...input.execution, callId: 'another-call' } });
  const parentChanged = store.retainSource({ ...input, originalIds: ['actual-parent'] });
  expect(new Set([first.id, changed.id, restored.id, otherExecution.id, parentChanged.id]).size).toBe(5);
  expect(store.sources.get(first.id)?.text).toBe('Actual returned bytes.');
  expect(store.sources.get(changed.id)?.text).toBe('A changed returned body.');
  expect(verificationWireSource(parentChanged)).not.toHaveProperty('originalIds');
});

test('restoration treats earlier record IDs as opaque and never derives them again from text', () => {
  const f = journal(); const prior = { ...source(), id: 'previously-issued-native-reference' };
  f.store.rememberSource(prior);
  const reopened = new VerificationStore(f.root, f.session);
  expect(reopened.retainSource(source()).id).toBe(prior.id);
  const otherOwner = new VerificationStore();
  expect(otherOwner.retainSource(source()).id).not.toBe(prior.id);
  expect(issueVerificationSource(source()).id).not.toBe(issueVerificationSource(source()).id);
});

test('archive history IDs survive restart and preserve originals when a caller mutates its prior message array', () => {
  const f = journal(), history = { messages: [{ role: 'user', content: 'Original owner request.' }] };
  f.store.rememberArchive({ histories: [history], derived: [] });
  const initial = readFileSync(f.path, 'utf8');
  const reopened = new VerificationStore(f.root, f.session);
  reopened.rememberArchive({ histories: [structuredClone(history)], derived: [] });
  expect(readFileSync(f.path, 'utf8')).toBe(initial);
  history.messages[0]!.content = 'A changed owner request.';
  f.store.rememberArchive({ histories: [history], derived: [] });
  const records = readFileSync(f.path, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line));
  const originals = records.filter(record => record.kind === 'history');
  expect(originals).toHaveLength(2);
  expect(originals[0].key).not.toBe(originals[1].key);
  expect(originals[0].value.messages[0].content).toBe('Original owner request.');
  expect(originals[1].value.messages[0].content).toBe('A changed owner request.');
  expect(new VerificationStore(f.root, f.session).archive?.histories[0]?.messages[0]?.content).toBe('A changed owner request.');
});

test('existing history identities remain opaque and inline archive originals receive a native record only once', () => {
  const f = journal();
  f.store.rememberArchive({ histories: [], derived: [] });
  const history = { messages: [{ role: 'tool', content: 'Previously retained original bytes.' }] };
  appendFileSync(f.path, JSON.stringify({ kind: 'history', key: 'existing-stored-key', value: history }) + '\n'
    + JSON.stringify({ kind: 'archive', key: 'old-position-key', value: { historyKeys: ['existing-stored-key'], derived: [] } }) + '\n');
  const restored = new VerificationStore(f.root, f.session), before = readFileSync(f.path, 'utf8');
  restored.rememberArchive(restored.archive!);
  expect(readFileSync(f.path, 'utf8')).toBe(before);
  appendFileSync(f.path, JSON.stringify({ kind: 'archive', key: 'inline-position-key', value: { branch: 'inline', histories: [history], derived: [] } }) + '\n');
  const inline = new VerificationStore(f.root, f.session);
  inline.rememberArchive(inline.archive!);
  const saved = readFileSync(f.path, 'utf8');
  const reopened = new VerificationStore(f.root, f.session);
  reopened.rememberArchive(reopened.archive!);
  expect(readFileSync(f.path, 'utf8')).toBe(saved);
  expect(reopened.archive?.histories[0]?.messages).toEqual(history.messages);
});

test('native feedback records preserve exact roles after restart and do not bind a changed message occupying the same slot', () => {
  const f = journal(), conversation = new ConversationManager();
  conversation.addUserMessage('Review the source; do not change it.');
  registerVerificationArchive(conversation, value => f.store.rememberArchive(value));
  appendVerificationObservation(conversation, 'Observed native report delivery.');
  const record = f.store.archive?.messageRecords?.[0];
  expect(record?.id).toStartWith('message-');
  expect(record).toHaveProperty('message'); expect(record).not.toHaveProperty('contentCommitment');
  const resumed = new ConversationManager(); resumed.fromJSON(conversation.toJSON() as Parameters<ConversationManager['fromJSON']>[0]);
  const reopened = new VerificationStore(f.root, f.session);
  registerVerificationArchive(resumed, value => reopened.rememberArchive(value), [...reopened.archives.values()]);
  const messages = resumed.getMessageSnapshot();
  expect(verificationMessages(resumed, messages).map(message => message.role)).toEqual(['user', 'system']);
  const changed = messages.map((message, index) => index === 1 ? { ...message, content: 'A different owner instruction.' } : message);
  expect(verificationMessages(resumed, changed).map(message => message.role)).toEqual(['user', 'user']);
  expect(verificationMessages(resumed, messages).map(message => message.role)).toEqual(['user', 'system']);
});

test('private feedback persists no raw credential and retains exact provenance when restored', () => {
  const f = journal(), conversation = new ConversationManager();
  registerVerificationArchive(conversation, value => f.store.rememberArchive(value));
  appendVerificationObservation(conversation, 'password=synthetic-private-runtime-value');
  const record = f.store.archive?.messageRecords?.[0];
  expect(record?.id).toStartWith('message-');
  expect(record).toHaveProperty('contentCommitment'); expect(record).not.toHaveProperty('message');
  expect(readFileSync(f.path, 'utf8')).not.toContain('synthetic-private-runtime-value');
  const resumed = new ConversationManager(); resumed.fromJSON(conversation.toJSON() as Parameters<ConversationManager['fromJSON']>[0]);
  const reopened = new VerificationStore(f.root, f.session);
  registerVerificationArchive(resumed, value => reopened.rememberArchive(value), [...reopened.archives.values()]);
  expect(verificationMessages(resumed, resumed.getMessageSnapshot())[0]?.role).toBe('system');
  expect(verificationMessages(resumed, resumed.getMessageSnapshot())[0]?.role).toBe('system');
  const different = resumed.getMessageSnapshot().map(message => ({ ...message, content: 'password=another-private-value' }));
  expect(verificationMessages(resumed, different)[0]?.role).toBe('user');
  expect(readFileSync(f.path, 'utf8')).not.toContain('synthetic-private-runtime-value');
  expect(readFileSync(f.path, 'utf8')).not.toContain('another-private-value');
});

test('earlier stored provenance commitments migrate public originals into exact native records without restoring instruction authority', () => {
  const f = journal(), conversation = new ConversationManager();
  conversation.addUserMessage('[Summary] Earlier work is retained as reference.');
  f.store.rememberArchive({ histories: [], derived: [] });
  // Fixed earlier-format fixture, independent of the current implementation.
  const prior = 'oncfadclihooppodmieiniadfiemimjfepcifbinphkgkjnjkbnmlegohcbbcnmh';
  appendFileSync(f.path, JSON.stringify({ kind: 'archive', key: 'earlier-position', value: { histories: [], derived: [[0, prior]] } }) + '\n');
  const restored = new VerificationStore(f.root, f.session);
  registerVerificationArchive(conversation, value => restored.rememberArchive(value), [...restored.archives.values()]);
  expect(verificationMessages(conversation, conversation.getMessageSnapshot())[0]?.role).toBe('system');
  expect(restored.archive?.messageRecords?.[0]).toHaveProperty('message');
  expect(restored.archive?.messageRecords?.[0]).not.toHaveProperty('contentCommitment');
  const resumed = new ConversationManager(); resumed.fromJSON(conversation.toJSON() as Parameters<ConversationManager['fromJSON']>[0]);
  const reopened = new VerificationStore(f.root, f.session);
  registerVerificationArchive(resumed, value => reopened.rememberArchive(value), [...reopened.archives.values()]);
  const before = readFileSync(f.path, 'utf8');
  expect(verificationMessages(resumed, resumed.getMessageSnapshot())[0]?.role).toBe('system');
  expect(readFileSync(f.path, 'utf8')).toBe(before);
});

test('compaction matches duplicate occurrences once and archives original owner text instead of elevating generated prose', () => {
  const owner = {}, duplicate = { role: 'user', content: 'An original owner request.' };
  const original = [duplicate, duplicate];
  archiveVerificationCompaction(owner, original, [duplicate, duplicate, duplicate]);
  expect(verificationMessages(owner, [duplicate, duplicate, duplicate]).map(message => message.role)).toEqual(['user', 'user', 'system']);
  expect(verificationHistory(owner)[0]?.messages).toEqual(original);
  archiveVerificationCompaction(owner, [duplicate, duplicate, duplicate], [{ role: 'user', content: 'A generated summary.' }]);
  expect(verificationHistory(owner)[1]?.messages).toHaveLength(2);
  expect(verificationMessages(owner, [{ role: 'user', content: 'A generated summary.' }])[0]?.role).toBe('system');
});

test('compaction preserves reordered exact JSON records and distinguishes property presence and signed zero', () => {
  const owner = {};
  const before = [{ role: 'user', content: 'An exact retained owner message.', metadata: { active: true, count: 1 } },
    { role: 'user', content: 'A message with an explicit field.', flag: undefined },
    { role: 'user', content: 'A signed numeric observation.', delta: -0 }];
  const after = [{ metadata: { count: 1, active: true }, content: 'An exact retained owner message.', role: 'user' },
    { role: 'user', content: 'A message with an explicit field.' },
    { role: 'user', content: 'A signed numeric observation.', delta: 0 }];
  archiveVerificationCompaction(owner, before, after);
  expect(verificationMessages(owner, after).map(message => message.role)).toEqual(['user', 'system', 'system']);
  expect(verificationHistory(owner)[0]?.messages).toEqual(before);
});

test('a native provenance reference without its complete archived record holds recovery', () => {
  const f = journal(); f.store.rememberArchive({ histories: [], derived: [] });
  appendFileSync(f.path, JSON.stringify({ kind: 'archive', key: 'broken-position', value: { histories: [], derived: [[0, 'message-missing-record']] } }) + '\n');
  expect(() => new VerificationStore(f.root, f.session)).toThrow('missing archived message record');
});

test('undo owns removed provenance, redo restores it, and new user input retires it', () => {
  const f = journal(), conversation = new ConversationManager();
  conversation.addUserMessage('Original owner request.');
  registerVerificationArchive(conversation, value => f.store.rememberArchive(value));
  appendVerificationObservation(conversation, 'Native observation, never an owner instruction.');
  const recordId = f.store.archive?.messageRecords?.[0]?.id;
  const feedback = conversation.getMessageSnapshot()[1]!.content;
  expect(conversation.undo()).toBe(true);
  expect(f.store.archive?.messageRecords ?? []).toHaveLength(0);
  expect(conversation.redo()).toBe(true);
  expect(f.store.archive?.messageRecords?.[0]?.id).toBe(recordId);
  expect(verificationMessages(conversation, conversation.getMessageSnapshot()).map(message => message.role)).toEqual(['user', 'system']);
  expect(conversation.undo()).toBe(true);
  conversation.addUserMessage(feedback as string);
  expect(conversation.redo()).toBe(false);
  expect(f.store.archive?.messageRecords ?? []).toHaveLength(0);
  expect(verificationMessages(conversation, conversation.getMessageSnapshot()).map(message => message.role)).toEqual(['user', 'user']);
});

test('native message deletions remap surviving feedback and retire removed source records', () => {
  const f = journal(), conversation = new ConversationManager();
  conversation.addUserMessage('Original owner request.');
  registerVerificationArchive(conversation, value => f.store.rememberArchive(value));
  conversation.startStreamingBlock();
  appendVerificationObservation(conversation, 'First native observation.');
  conversation.finalizeStreamingBlock();
  expect(verificationMessages(conversation, conversation.getMessageSnapshot()).map(message => message.role)).toEqual(['user', 'system']);
  conversation.addAssistantMessage('Unsent private draft.');
  appendVerificationObservation(conversation, 'Second native observation.');
  conversation.addAssistantMessage('', { toolCalls: [{ id: 'native-read', name: 'read', arguments: { path: 'source.ts' } }] });
  conversation.addToolResults([{ callId: 'native-read', success: true, output: 'Actual returned source bytes.' }]);
  conversation.removeMessagesAfter(1, { preserveCompletedTools: true });
  expect(verificationMessages(conversation, conversation.getMessageSnapshot()).map(message => message.role)).toEqual(['user', 'system', 'system', 'assistant', 'tool']);
  expect(f.store.archive?.messageRecords).toHaveLength(2);
  conversation.removeMessagesAfter(1);
  expect(f.store.archive?.messageRecords ?? []).toHaveLength(0);
  expect(f.store.archive?.runtimeMessages ?? []).toHaveLength(0);
});

test('native cancellation preserves feedback origin and a loaded conversation cannot redo another session source', () => {
  const f = journal(), conversation = new ConversationManager();
  conversation.addUserMessage('Original owner request.');
  registerVerificationArchive(conversation, value => f.store.rememberArchive(value));
  appendVerificationObservation(conversation, 'Native feedback.');
  const originalId = f.store.archive?.messageRecords?.[0]?.id;
  conversation.markLastUserMessageCancelled();
  expect(f.store.archive?.messageRecords?.[0]?.id).not.toBe(originalId);
  const cancelledId = f.store.archive?.messageRecords?.[0]?.id;
  conversation.markLastUserMessageCancelled();
  expect(f.store.archive?.messageRecords?.[0]?.id).toBe(cancelledId);
  expect(verificationMessages(conversation, conversation.getMessageSnapshot()).map(message => message.role)).toEqual(['user', 'system']);
  expect(conversation.undo()).toBe(true);
  conversation.fromJSON({ messages: [{ role: 'user', content: 'Another loaded session.' }] });
  expect(conversation.redo()).toBe(false);
  expect(verificationMessages(conversation, conversation.getMessageSnapshot()).map(message => message.role)).toEqual(['user']);
});

test('an inadmissible latest archive cannot silently fall back to earlier message provenance', () => {
  const f = journal(); f.store.rememberArchive({ histories: [], derived: [] });
  appendFileSync(f.path, JSON.stringify({ kind: 'archive', key: 'unadmitted-position', value: { histories: [], derived: [[0, 'message-private-record']],
    messageRecords: [{ id: 'message-private-record', message: { role: 'user', content: 'password=synthetic-unadmitted-private-value' } }] } }) + '\n');
  expect(() => new VerificationStore(f.root, f.session)).toThrow('unadmitted archived provenance');
});

test('repair checkpoints reuse original message records across draft edits and recover private observations without storing them', async () => {
  const f = journal(), request = 'Review the source and deliver the findings.', conversation = new ConversationManager();
  conversation.addUserMessage(request);
  conversation.addToolResults([{ callId: 'private-observation', success: true, output: 'password=synthetic-private-checkpoint-value' }]);
  const initial = { request, conversation, verificationStore: f.store };
  const first = new ResponseCompletionGuard(initial);
  const input = { request, response: 'The review found an input-validation defect.', conversation, tools: ['read'] };
  await holdForAccount(first, input);
  const before = f.store.repairCheckpoint('main');
  expect(before?.schemaVersion).toBe(2);
  expect(before?.sourceIds).toHaveLength(2);
  await holdForAccount(first, { ...input, response: 'The retained findings describe an input-validation defect.' });
  const after = f.store.repairCheckpoint('main');
  expect(after?.sourceIds).toEqual(before?.sourceIds);
  expect(after?.requestSource).toBe(before?.requestSource);
  expect(after?.id).not.toBe(before?.id);
  const records = readFileSync(f.path, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line));
  expect(records.filter(record => record.kind === 'original')).toHaveLength(3);
  expect(readFileSync(f.path, 'utf8')).not.toContain('synthetic-private-checkpoint-value');
  const reopened = new VerificationStore(f.root, f.session);
  const restored = new ResponseCompletionGuard({ ...initial, verificationStore: reopened });
  expect(restored.resumedRepair()).toContain(after!.response);
  expect(restored.resumedRepair()).toContain('Do not restart the task');
  expect(restored.resumedRepair()).not.toContain('Jev account');
  expect(restored.resumedRepair()).not.toContain('synthetic-private-checkpoint-value');
  expect(() => restored.beginFinalization({ content: after!.response })).toThrow();
  conversation.addUserMessage(request);
  const next = new ResponseCompletionGuard({ ...initial, verificationStore: new VerificationStore(f.root, f.session) });
  expect(next.resumedRepair()).toBe('');
  await holdForAccount(next, input);
  const later = readFileSync(f.path, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line));
  expect(later.filter(record => record.kind === 'original')).toHaveLength(4);
});

test('a repair checkpoint belongs to its native branch and stale cleanup cannot clear a newer diagnostic', async () => {
  const f = journal(), request = 'Review the source.', conversation = new ConversationManager(); conversation.addUserMessage(request);
  const input = { request, response: 'Retained private review draft.', conversation, tools: [] };
  await holdForAccount(new ResponseCompletionGuard({ request, conversation, verificationStore: f.store }), input);
  const main = f.store.repairCheckpoint('main')!;
  conversation.forkBranch('alternate'); conversation.switchBranch('alternate');
  const alternate = new ResponseCompletionGuard({ request, conversation, verificationStore: f.store });
  expect(alternate.resumedRepair()).toBe('');
  await holdForAccount(alternate, input);
  const other = f.store.repairCheckpoint('alternate')!;
  expect(other.id).not.toBe(main.id);
  expect(f.store.repairCheckpoint('main')?.id).toBe(main.id);
  await holdForAccount(alternate, { ...input, response: 'A revised retained draft.' });
  const latest = f.store.repairCheckpoint('alternate')!;
  f.store.clearRepairCheckpoint('alternate', other.id);
  expect(f.store.repairCheckpoint('alternate')?.id).toBe(latest.id);
  f.store.clearRepairCheckpoint('alternate', latest.id);
  expect(new VerificationStore(f.root, f.session).repairCheckpoint('alternate')).toBeNull();
  expect(new VerificationStore(f.root, f.session).repairCheckpoint('main')?.id).toBe(main.id);
});

test('existing held drafts convert their stored request and prefix commitments once, and clearing cannot resurrect them', () => {
  const f = journal(), request = 'Review the source.', conversation = new ConversationManager(); conversation.addUserMessage(request);
  const key = 'giehkliihjmninenafpghoailomgnhceobeahjkfijmfdagjabljpffafkppnikh';
  const value = { count: 1, prefix: 'bhfhocmghppiibmegpallheiihjnkjlhlhngoakcfddpeileacgaidnpgggjaipj', accessHeld: true, review: null, response: 'An earlier retained draft.' };
  f.store.rememberProposal(key, JSON.stringify(value));
  const guard = new ResponseCompletionGuard({ request, conversation, verificationStore: f.store });
  expect(guard.resumedRepair()).toContain(value.response);
  const checkpoint = f.store.repairCheckpoint('main')!;
  expect(checkpoint.schemaVersion).toBe(2);
  expect(f.store.proposals.get(key)).toBe('null');
  expect(() => guard.beginFinalization({ content: value.response })).toThrow();
  const reopened = new VerificationStore(f.root, f.session), bytes = readFileSync(f.path, 'utf8');
  expect(new ResponseCompletionGuard({ request, conversation, verificationStore: reopened }).resumedRepair()).toContain(value.response);
  expect(readFileSync(f.path, 'utf8')).toBe(bytes);
  reopened.clearRepairCheckpoint('main', checkpoint.id);
  reopened.rememberProposal(key, JSON.stringify(value));
  expect(new ResponseCompletionGuard({ request, conversation, verificationStore: new VerificationStore(f.root, f.session) }).resumedRepair()).toBe('');
});

test('immutable original IDs cannot be rebound, including after recovery of a stored commitment', () => {
  const f = journal();
  const original = VerificationJournalSource.capture('original-actual-source', { content: 'Actual retained source.' });
  f.store.rememberOriginal(original);
  expect(() => f.store.rememberOriginal(VerificationJournalSource.capture(original.id, { content: 'A foreign substituted source.' }))).toThrow('immutable journal original changed');
  const value = { content: 'Recovered public original.' };
  appendFileSync(f.path, JSON.stringify({ kind: 'original', key: 'original-stored-commitment', value: { id: 'original-stored-commitment', contentCommitment: 'apgaohfemallppnpgkcpbhlbhihknphdnbnndoilhjbopaigibkmpbkjlnkfnfol' } }) + '\n');
  const reopened = new VerificationStore(f.root, f.session);
  expect(() => reopened.rememberOriginal(VerificationJournalSource.capture('original-stored-commitment', { content: 'Foreign source.' }))).toThrow('immutable journal original changed');
  const recovered = VerificationJournalSource.restore(reopened.original('original-stored-commitment')!);
  expect(recovered.matches(value)).toBe(true);
  expect(() => reopened.rememberOriginal(recovered)).toThrow('immutable journal original changed');
  const converted = VerificationJournalSource.capture('original-converted-public-source', recovered.message!);
  reopened.rememberOriginal(converted);
  const restored = new VerificationStore(f.root, f.session);
  expect(restored.original(recovered.id)).toHaveProperty('contentCommitment');
  expect(restored.original(converted.id)).toHaveProperty('message');
});

test('a repair checkpoint with missing originals holds recovery instead of reviving earlier diagnostics', () => {
  const f = journal(); f.store.rememberArchive({ histories: [], derived: [] });
  appendFileSync(f.path, JSON.stringify({ kind: 'repair', key: 'main', value: { schemaVersion: 2, id: 'repair-incomplete', count: 1,
    requestSource: 'original-missing-request', sourceIds: ['original-missing-message'], review: null, response: 'Retained draft.', accessHeld: true } }) + '\n');
  expect(() => new VerificationStore(f.root, f.session)).toThrow('missing repair checkpoint original');
});

test('malformed restored findings cannot become current repair guidance', () => {
  const f = journal(), source = VerificationJournalSource.capture('original-source-record', { content: 'Actual source.' });
  f.store.rememberOriginal(source);
  expect(() => f.store.rememberRepairCheckpoint('main', { schemaVersion: 2, id: 'repair-invalid-review', count: 1,
    requestSource: source.id, sourceIds: [source.id], response: 'Retained draft.', review: { findings: [null] } })).toThrow('invalid repair checkpoint');
  expect(f.store.repairCheckpoint('main')).toBeUndefined();
});

test('retrieval indexes compare every native member and preview, and keep their issued IDs on restart', () => {
  const f = journal();
  const index = { representation: 'source-index' as const, children: [], sourceIds: ['first-source', 'middle-source', 'last-source'],
    summary: { facts: [{ text: 'RETRIEVAL INDEX ONLY; open the actual originals.', sources: [] }], concerns: [] } };
  const first = f.store.retainIndex(index);
  expect(f.store.retainIndex(structuredClone(index))).toBe(first);
  const changed = { ...index, sourceIds: ['first-source', 'different-middle', 'last-source'] };
  const second = f.store.retainIndex(changed);
  expect(second.id).not.toBe(first.id);
  const differentPreview = f.store.retainIndex({ ...changed, summary: { facts: [{ text: 'A different preview.', sources: [] }], concerns: [] } });
  expect(differentPreview.id).not.toBe(second.id);
  const current = f.store.retainIndex(changed), bytes = readFileSync(f.path, 'utf8');
  const reopened = new VerificationStore(f.root, f.session);
  expect(reopened.retainIndex(changed).id).toBe(current.id);
  expect(readFileSync(f.path, 'utf8')).toBe(bytes);
  expect(current.representation).toBe('source-index');
});

test('changed qualified summaries retire their native identity without rewriting earlier summary records', () => {
  const f = journal();
  const evidence = { representation: 'jev-qualified' as const, children: ['s-child'], sourceIds: ['s-original'],
    summary: { facts: [{ text: 'The original source says A.', sources: ['s-child'] }], concerns: [] } };
  const first = f.store.retainEvidence(evidence);
  const changed = { ...evidence, summary: { facts: [{ text: 'The original source says B.', sources: ['s-child'] }], concerns: [] } };
  const second = f.store.retainEvidence(changed);
  expect(second.id).not.toBe(first.id);
  expect(first.summary.facts[0]?.text).toBe('The original source says A.');
  const bytes = readFileSync(f.path, 'utf8');
  expect(new VerificationStore(f.root, f.session).retainEvidence(changed).id).toBe(second.id);
  expect(readFileSync(f.path, 'utf8')).toBe(bytes);
});

test('live atomic-qualification revisions follow complete admitted proposal values rather than a reused proposal slot', () => {
  const store = new VerificationStore();
  const proposed = { facts: [{ text: 'An actual proposed fact.', sources: ['source-one'] }], concerns: [] };
  const first = store.retainProposalRevision('native-proposal-slot', proposed);
  expect(store.retainProposalRevision('native-proposal-slot', structuredClone(proposed))).toBe(first);
  const changed = store.retainProposalRevision('native-proposal-slot', { ...proposed, concerns: [{ text: 'Contrary evidence.', sources: ['source-one'] }] });
  expect(changed).not.toBe(first);
  expect(store.retainProposalRevision('native-proposal-slot', proposed)).not.toBe(first);
});

test('unchanged persisted sources and summaries avoid another private draft on restart but still receive fresh Jev checks', async () => {
  const f = journal(), firstPort = fakePort(() => noulAnswer(0.01));
  const full = { request: 'Review all source and write review.md.', response: 'The report is saved in review.md.',
    transcript: [{ role: 'tool', callId: 'read-source', content: 'Retained original source line. '.repeat(1_500) }],
    tools: ['read', 'write'], delegated: [], requirements: null, initial: null, previousReview: null };
  let drafts = 0;
  const first = new CompletionVerification(async request => { drafts++; return verificationWriter(request); }, f.store);
  expect((await first.prepare(full, { port: firstPort.port, identity: {}, assertCurrent() {} })).findings).toHaveLength(0);
  expect(drafts).toBeGreaterThan(1);
  const secondPort = fakePort(() => noulAnswer(0.01));
  const reopened = new CompletionVerification(async () => { throw new Error('Unchanged retained source must not require another private draft'); },
    new VerificationStore(f.root, f.session));
  expect((await reopened.prepare(full, { port: secondPort.port, identity: {}, assertCurrent() {} })).findings).toHaveLength(0);
  expect(secondPort.requests.some(request => request.context?.battery === 'engine.verification.evidence')).toBe(true);
  expect(secondPort.requests.some(request => request.context?.battery === 'engine.verification.requirement')).toBe(true);
});

test('selected read and citation sources retain exact provenance and reuse their native IDs after restart', () => {
  const f = journal();
  const content = '1 | First actual source line.\n2 | Second actual source line.';
  const file = { path: 'source.ts', content, readObservation: observeReadContent(content, 1, 2, true) };
  const state = { request: 'Review this file.', transcript: [
    { role: 'assistant', toolCalls: [{ id: 'read-source', name: 'read', arguments: { path: 'source.ts' } }] },
    { role: 'tool', callId: 'read-source', outcome: 'ok', content: JSON.stringify({ success: true, files: [file] }) },
  ] };
  const read = (store: VerificationStore) => {
    const own = (value: VerificationSourceInput) => store.retainSource(value);
    const originals = verificationSources(state, own);
    const native = nativeReadReceipts(originals, own);
    const citations = citedReadSources(native.reads, 'source.ts:1-2 and source.ts#L1-L2', undefined, own);
    return { originals, native, citations };
  };
  const first = read(f.store), bytes = readFileSync(f.path, 'utf8');
  expect(first.citations).toHaveLength(1);
  expect(first.citations[0]?.source.readKind).toBe('citation');
  expect(first.native.receipts[0]?.readKind).toBe('receipt');
  expect(first.native.ledgers[0]?.source.readKind).toBe('ledger');
  expect(verificationWireSource(first.citations[0]!.source)).not.toHaveProperty('readKind');
  expect(JSON.parse(first.citations[0]!.source.text).rows).toEqual(content.split('\n'));
  const reopened = read(new VerificationStore(f.root, f.session));
  expect(reopened.originals.map(value => value.id)).toEqual(first.originals.map(value => value.id));
  expect(reopened.native.receipts.map(value => value.id)).toEqual(first.native.receipts.map(value => value.id));
  expect(reopened.native.ledgers.map(value => value.source.id)).toEqual(first.native.ledgers.map(value => value.source.id));
  expect(reopened.citations.map(value => value.source.id)).toEqual(first.citations.map(value => value.source.id));
  expect(reopened.citations[0]?.originals).toEqual(first.citations[0]?.originals);
  expect(readFileSync(f.path, 'utf8')).toBe(bytes);
});

test('counterevidence audits recognize a native read citation independently of its opaque ID and retain its complete original', async () => {
  const content = '1 | Actual source definition.\n2 | Actual source implementation.';
  const file = { path: 'source.ts', content, readObservation: observeReadContent(content, 1, 2, true) };
  const full = { request: 'Review source.ts and report its observed implementation.', response: 'The implementation is at source.ts:1-2.',
    transcript: [
      { role: 'tool', callId: 'earlier-observation', content: 'Earlier actual native observation. '.repeat(12_000) },
      { role: 'assistant', toolCalls: [{ id: 'read-source', name: 'read', arguments: { path: 'source.ts' } }] },
      { role: 'tool', callId: 'read-source', outcome: 'ok', content: JSON.stringify({ success: true, files: [file] }) },
    ], initial: { request: 'Review source.ts and report its observed implementation.', transcript: [] },
    tools: ['read'], delegated: [], requirements: null, previousReview: null };
  const fake = fakePort(() => noulAnswer(.01)), verifier = new CompletionVerification(verificationWriter);
  expect((await verifier.prepare(full, { port: fake.port, identity: {}, assertCurrent() {} })).findings).toHaveLength(0);
  const audits = fake.requests.filter(request => ['engine.verification.audit', 'engine.verification.instruction-audit'].includes(request.context?.battery ?? ''));
  const cited = audits.flatMap(request => ((request.state as unknown as { caseEvidence?: { sources?: Record<string, unknown>[] } }).caseEvidence?.sources ?? []))
    .filter(source => typeof source.reference === 'string' && source.reference.startsWith('cited source source.ts:'));
  expect(cited.length).toBeGreaterThan(0);
  expect(cited.every(source => source.representation === 'native-checked-source-reference' && !Object.hasOwn(source, 'text'))).toBe(true);
  expect([...verifier.store.sources.values()].some(source => source.readKind === 'citation' && source.text.includes('Actual source implementation.'))).toBe(true);
});

test('a retained worker source is projected once, without recursively persisting projections as new originals', () => {
  const f = journal();
  const parent = [
    { role: 'assistant', toolCalls: [{ id: 'spawn-worker', name: 'agent', arguments: { mode: 'spawn' } }] },
    { role: 'tool', callId: 'spawn-worker', outcome: 'ok', content: JSON.stringify({ agentId: 'worker' }) },
  ];
  const own = (value: VerificationSourceInput) => f.store.retainSource(value);
  verificationSources({ transcript: parent, delegated: [{ id: 'worker', output: 'Actual retained result.' }] }, own);
  const full = { transcript: parent, delegated: [] };
  const first = retainedDelegationSources(full, f.store.sources, own);
  const bytes = readFileSync(f.path, 'utf8');
  const second = retainedDelegationSources(full, f.store.sources, own);
  expect(first).toHaveLength(1);
  expect(second.map(value => value.id)).toEqual(first.map(value => value.id));
  expect(first[0]?.text).toContain('Actual retained result.');
  expect(readFileSync(f.path, 'utf8')).toBe(bytes);
});
