import { expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeJsonFileAtomic } from '@goodvibes-jev/engine/platform/platform/state/durable-file-io';
import type { NativeConversationIntakeCaptureRequest, NativeConversationIntakeResult, NativeConversationTurnPermit, OperatorNativeConversationIntakeClient } from '@goodvibes-jev/engine/platform/platform/workflow/work-ledger/native-intake-client';
import type { OperatorNativeWorkExecutionClient } from '@goodvibes-jev/engine/platform/platform/workflow/work-ledger/native-execution-client';
import { NATIVE_INTAKE_JOURNAL_MAX_RECORDS, NativeConversationIntakeJournal, type NativeIntakeJournalBinding } from '../../runtime/native-conversation-intake-journal.ts';
import { NativeConversationIntakeControls } from '../../runtime/native-conversation-intake.ts';

const bindingFor = (n: number): NativeIntakeJournalBinding => ({ endpoint: 'https://native.invalid', projectId: 'p', workspace: `/workspace/${n}`, principalId: 'paired' });
const commandFor = (n: number) => ({ requestId: `request-${n}`, inputId: `input-${n}`, text: `input ${n}`, unsupportedSources: [] });
async function fixture(run: (path: string) => Promise<void>) {
  const directory = mkdtempSync(join(tmpdir(), 'native-intake-capacity-'));
  try { await run(join(directory, 'journal.json')); } finally { rmSync(directory, { recursive: true, force: true }); }
}
const workspaces = (path: string): string[] => (JSON.parse(readFileSync(path, 'utf8')) as { records: Array<{ binding: NativeIntakeJournalBinding }> }).records.map(record => record.binding.workspace);

const intent = { sourceRevision: 'r1', target: { workId: 'work', attemptId: 'attempt', expectedRevision: { work: 1, criteria: 2, attempt: 3 } } };

test('a new binding at the record cap evicts the least recently saved record handed to native execution', async () => fixture(async path => {
  const journal = new NativeConversationIntakeJournal(path);
  for (let n = 0; n < NATIVE_INTAKE_JOURNAL_MAX_RECORDS; n++) {
    await journal.save(bindingFor(n), commandFor(n), null);
    await journal.saveExecutionIntent(bindingFor(n), commandFor(n), intent);
  }
  // Saving workspace 0 again makes workspace 1 the stalest record.
  await journal.save(bindingFor(0), { ...commandFor(0), requestId: 'request-0b', inputId: 'input-0b' }, 'request-0');
  await journal.save(bindingFor(99), commandFor(99), null);
  const kept = workspaces(path);
  expect(kept).toHaveLength(NATIVE_INTAKE_JOURNAL_MAX_RECORDS);
  expect(kept).not.toContain('/workspace/1');
  expect(kept).toContain('/workspace/0');
  expect(kept.at(-1)).toBe('/workspace/99');
  expect(await journal.read(bindingFor(1))).toBeUndefined();
}));

test('a claimed local turn is never evicted, so a retry cannot dispatch it a second time', async () => fixture(async path => {
  const journal = new NativeConversationIntakeJournal(path);
  for (let n = 0; n < NATIVE_INTAKE_JOURNAL_MAX_RECORDS; n++) {
    await journal.save(bindingFor(n), commandFor(n), null);
    expect(await journal.claimTurn(bindingFor(n), commandFor(n), 'r1')).toBe(true);
  }
  const before = readFileSync(path, 'utf8');
  await expect(journal.save(bindingFor(99), commandFor(99), null)).rejects.toMatchObject({ code: 'journal_limit' });
  expect(readFileSync(path, 'utf8')).toBe(before);
  expect(await journal.claimTurn(bindingFor(0), commandFor(0), 'r1')).toBe(false);
}));

test('records that may hold uncaptured text are never evicted; the save fails with journal_limit', async () => fixture(async path => {
  const journal = new NativeConversationIntakeJournal(path);
  for (let n = 0; n < NATIVE_INTAKE_JOURNAL_MAX_RECORDS; n++) await journal.save(bindingFor(n), commandFor(n), null);
  const before = readFileSync(path, 'utf8');
  await expect(journal.save(bindingFor(99), commandFor(99), null)).rejects.toMatchObject({ code: 'journal_limit' });
  expect(readFileSync(path, 'utf8')).toBe(before);
}));

function intakeFor(journal: NativeConversationIntakeJournal) {
  const server = new Map<string, NativeConversationIntakeResult>();
  const captures: NativeConversationIntakeCaptureRequest[] = [];
  const common = (request: NativeConversationIntakeCaptureRequest) => ({ projectId: 'p', requestId: request.requestId,
    sourceRef: { version: 1 as const, inputId: request.inputId, sourceId: `source-${request.inputId}`, sourceRevision: 'r1', sessionId: 'host-session' } });
  const client: OperatorNativeConversationIntakeClient = {
    async capture(request) { captures.push(structuredClone(request)); const result: NativeConversationIntakeResult = { kind: 'captured', ...common(request) }; server.set(request.inputId, result); return result; },
    async get({ inputId }) { return server.get(inputId) ?? { kind: 'not-found' }; },
    async admit({ inputId }) {
      const request = captures.find(item => item.inputId === inputId)!;
      const result: NativeConversationIntakeResult = { kind: 'turn', ...common(request), route: 'answer', text: request.text };
      server.set(inputId, result); return result;
    },
    async resume() { throw new Error('unexpected resume'); },
    async cancel() { throw new Error('unexpected cancel'); },
    bindTurn() { return Object.freeze({}) as NativeConversationTurnPermit; },
    dispose() {},
  };
  let ids = 0;
  return { captures, controls: new NativeConversationIntakeControls(() => ({ available: true, identity: 'selected', endpoint: 'https://native.invalid', projectId: 'p', workspace: '/workspace/live', journal,
    bind: () => ({ client, execution: {} as OperatorNativeWorkExecutionClient, readPrincipal: async () => 'paired', dispose: () => {} }) }), () => `id-${++ids}`) };
}
const input = (text: string) => ({ text, unsupportedSources: [] });

test('an input whose journal save failed can be discarded with cancel, and the next input is sent', async () => fixture(async path => {
  let failNext = true;
  const journal = new NativeConversationIntakeJournal(path, { writeJsonFileAtomic: (target, value, options) => {
    if (failNext) { failNext = false; throw Object.assign(new Error('no space'), { code: 'ENOSPC' }); }
    writeJsonFileAtomic(target, value, options);
  } });
  const { controls, captures } = intakeFor(journal);
  expect((await controls.submit(input('first')))?.message).toContain('could not be confirmed');
  const blocked = await controls.submit(input('second'));
  expect(blocked?.status).toBe('unknown');
  expect(blocked?.message).toContain('/work intake-cancel');
  const discarded = await controls.cancel();
  expect(discarded?.status).toBe('unavailable');
  expect(discarded?.message).toContain('discarded');
  const sent = await controls.submit(input('third'));
  expect(sent?.status).toBe('recorded');
  expect(sent?.turnReady).toBe(true);
  expect(captures.map(item => item.text)).toEqual(['third']);
}));

test('a full journal names its file and cap instead of a generic confirmation failure', async () => fixture(async path => {
  const journal = new NativeConversationIntakeJournal(path);
  for (let n = 0; n < NATIVE_INTAKE_JOURNAL_MAX_RECORDS; n++) await journal.save(bindingFor(n), commandFor(n), null);
  const state = await intakeFor(journal).controls.submit(input('new'));
  expect(state?.message).toContain(path);
  expect(state?.message).toContain(`at most ${NATIVE_INTAKE_JOURNAL_MAX_RECORDS}`);
  expect(state?.message).toContain('/work intake-cancel');
}));

// Hosted bindings: the host has acknowledged each source, so only another live process of this client keeps one.
const sourceFor = (n: number) => ({ version: 1 as const, inputId: `input-${n}`, sourceId: `source-${n}`, sourceRevision: 'r1', sessionId: 'host-session' });
async function fillHosted(journal: NativeConversationIntakeJournal): Promise<void> {
  for (let n = 0; n < NATIVE_INTAKE_JOURNAL_MAX_RECORDS; n++) {
    await journal.save(bindingFor(n), commandFor(n), null, { delivery: 'hosted' });
    await journal.saveHostedSource(bindingFor(n), commandFor(n), sourceFor(n));
  }
}
const bindingKey = (binding: NativeIntakeJournalBinding): string => JSON.stringify([binding.endpoint, binding.projectId, binding.workspace, binding.principalId]);
const ownedBy = (path: string, owners: Array<[NativeIntakeJournalBinding, number]>): void => writeJsonFileAtomic(`${path}.owners`, {
  version: 1, owners: Object.fromEntries(owners.map(([binding, pid]) => [bindingKey(binding), { pid, instance: 'another-process' }])),
}, { mode: 0o600 });
const exitedPid = (): number => Bun.spawnSync(['true']).pid;

test('a hosted binding another live process owns is skipped; the next stalest one is evicted', async () => fixture(async path => {
  const journal = new NativeConversationIntakeJournal(path);
  await fillHosted(journal);
  ownedBy(path, [[bindingFor(0), process.ppid]]);
  await journal.save(bindingFor(99), commandFor(99), null, { delivery: 'hosted' });
  const kept = workspaces(path);
  expect(kept).toContain('/workspace/0');
  expect(kept).not.toContain('/workspace/1');
  expect(kept).toHaveLength(NATIVE_INTAKE_JOURNAL_MAX_RECORDS);
}));

test('a hosted binding whose owner process has exited is evicted like any acknowledged one', async () => fixture(async path => {
  const journal = new NativeConversationIntakeJournal(path);
  await fillHosted(journal);
  ownedBy(path, [[bindingFor(0), exitedPid()]]);
  await journal.save(bindingFor(99), commandFor(99), null, { delivery: 'hosted' });
  expect(workspaces(path)).not.toContain('/workspace/0');
}));

test('when every acknowledged hosted binding is owned by a live process nothing is evicted and the save fails', async () => fixture(async path => {
  const journal = new NativeConversationIntakeJournal(path);
  await fillHosted(journal);
  ownedBy(path, Array.from({ length: NATIVE_INTAKE_JOURNAL_MAX_RECORDS }, (_, n) => [bindingFor(n), process.ppid] as [NativeIntakeJournalBinding, number]));
  const before = readFileSync(path, 'utf8');
  await expect(journal.save(bindingFor(99), commandFor(99), null, { delivery: 'hosted' })).rejects.toMatchObject({ code: 'journal_limit' });
  expect(readFileSync(path, 'utf8')).toBe(before);
}));
