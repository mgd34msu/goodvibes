import { expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  NativeConversationIntakeJournal,
  type NativeIntakeJournalBinding,
} from '../terminal-shell/src/native/native-conversation-intake-journal.ts';

const bindingFor = (n: number): NativeIntakeJournalBinding => ({ endpoint: 'https://native.invalid', projectId: 'p', workspace: `/workspace/${n}`, principalId: 'paired' });
const commandFor = (n: number) => ({ requestId: `request-${n}`, inputId: `input-${n}`, text: `input ${n}`, unsupportedSources: [] });
async function fixture(run: (path: string) => Promise<void>) {
  const directory = mkdtempSync(join(tmpdir(), 'native-intake-claims-'));
  try { await run(join(directory, 'journal.json')); } finally { rmSync(directory, { recursive: true, force: true }); }
}
const workspaces = (path: string): string[] => (JSON.parse(readFileSync(path, 'utf8')) as { records: Array<{ binding: NativeIntakeJournalBinding }> }).records.map(record => record.binding.workspace);

test('releasing a claim lets the same turn be claimed again; a different revision is refused', async () => fixture(async path => {
  const journal = new NativeConversationIntakeJournal(path);
  await journal.save(bindingFor(0), commandFor(0), null);
  expect(await journal.claimTurn(bindingFor(0), commandFor(0), 'r1')).toBe(true);
  expect(await journal.claimTurn(bindingFor(0), commandFor(0), 'r1')).toBe(false);
  await expect(journal.releaseTurnClaim(bindingFor(0), commandFor(0), 'other')).rejects.toMatchObject({ code: 'conflict' });
  await journal.releaseTurnClaim(bindingFor(0), commandFor(0), 'r1');
  expect((await journal.read(bindingFor(0)))?.dispatch).toBeUndefined();
  expect(await journal.claimTurn(bindingFor(0), commandFor(0), 'r1')).toBe(true);
}));

test('discard removes only a record that was never captured, claimed or handed to execution', async () => fixture(async path => {
  const journal = new NativeConversationIntakeJournal(path);
  await journal.save(bindingFor(0), commandFor(0), null);
  await journal.save(bindingFor(1), commandFor(1), null);
  await journal.claimTurn(bindingFor(1), commandFor(1), 'r1');
  await expect(journal.discardUncaptured(bindingFor(1), commandFor(1))).rejects.toMatchObject({ code: 'conflict' });
  await expect(journal.discardUncaptured(bindingFor(0), commandFor(1))).rejects.toMatchObject({ code: 'conflict' });
  await journal.discardUncaptured(bindingFor(0), commandFor(0));
  expect(workspaces(path)).toEqual(['/workspace/1']);
  await journal.discardUncaptured(bindingFor(0), commandFor(0));
}));

test('a finished local turn removes its record; a turn whose claim was given back is kept for retry', async () => fixture(async path => {
  const journal = new NativeConversationIntakeJournal(path);
  await journal.save(bindingFor(0), commandFor(0), null);
  await journal.save(bindingFor(1), commandFor(1), null);
  expect(await journal.claimTurn(bindingFor(0), commandFor(0), 'r1')).toBe(true);
  expect(await journal.claimTurn(bindingFor(1), commandFor(1), 'r1')).toBe(true);
  await journal.releaseTurnClaim(bindingFor(1), commandFor(1), 'r1');
  await journal.finishTurn(bindingFor(0), commandFor(0), 'r1');
  await journal.finishTurn(bindingFor(1), commandFor(1), 'r1');
  expect(workspaces(path)).toEqual(['/workspace/1']);
  await journal.remove(bindingFor(1), commandFor(1));
  expect(workspaces(path)).toEqual([]);
}));
