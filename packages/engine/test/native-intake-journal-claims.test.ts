import { expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeJsonFileAtomic } from '../platform/src/platform/state/durable-file-io.ts';
import {
  NATIVE_INTAKE_JOURNAL_MAX_RECORDS,
  NativeConversationIntakeJournal,
  type NativeIntakeJournalBinding,
} from '../terminal-shell/src/native/native-conversation-intake-journal.ts';

const bindingFor = (n: number): NativeIntakeJournalBinding => ({ endpoint: 'https://native.invalid', projectId: 'p', workspace: `/workspace/${n}`, principalId: 'paired' });
const commandFor = (n: number) => ({ requestId: `request-${n}`, inputId: `input-${n}`, text: `input ${n}`, unsupportedSources: [] });
const sourceFor = (n: number) => ({ version: 1 as const, inputId: `input-${n}`, sourceId: `source-${n}`, sourceRevision: 'r1', sessionId: 'host-session' });
async function fixture(run: (path: string) => Promise<void>) {
  const directory = mkdtempSync(join(tmpdir(), 'native-intake-claims-'));
  try { await run(join(directory, 'journal.json')); } finally { rmSync(directory, { recursive: true, force: true }); }
}
const hostedJournal = (path: string) => new NativeConversationIntakeJournal(path, {}, { allowHosted: true, allowSelectedDiff: false });
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

const bindingKey = (binding: NativeIntakeJournalBinding): string => JSON.stringify([binding.endpoint, binding.projectId, binding.workspace, binding.principalId]);
const exitedPid = (): number => Bun.spawnSync(['true']).pid;
async function fillHosted(journal: NativeConversationIntakeJournal): Promise<void> {
  for (let n = 0; n < NATIVE_INTAKE_JOURNAL_MAX_RECORDS; n++) {
    await journal.save(bindingFor(n), commandFor(n), null, { delivery: 'hosted' });
    await journal.saveHostedSource(bindingFor(n), commandFor(n), sourceFor(n));
  }
}
const ownedBy = (path: string, owner: { pid: number; host?: string }): void => writeJsonFileAtomic(`${path}.owners`, {
  version: 1, owners: { [bindingKey(bindingFor(0))]: { instance: 'another-process', ...owner } },
}, { mode: 0o600 });

test('a hosted owner recorded on another machine counts as alive even when its pid is not running here', async () => fixture(async path => {
  const journal = hostedJournal(path);
  await fillHosted(journal);
  ownedBy(path, { pid: exitedPid(), host: 'other-machine|pid:[4026531836]' });
  await journal.save(bindingFor(99), commandFor(99), null, { delivery: 'hosted' });
  expect(workspaces(path)).toContain('/workspace/0');
  expect(workspaces(path)).not.toContain('/workspace/1');
}));

test('the same exited owner without a foreign host is evicted, and a saved owner names this host', async () => fixture(async path => {
  const journal = hostedJournal(path);
  await fillHosted(journal);
  ownedBy(path, { pid: exitedPid() });
  await journal.save(bindingFor(99), commandFor(99), null, { delivery: 'hosted' });
  expect(workspaces(path)).not.toContain('/workspace/0');
  const owners = JSON.parse(readFileSync(`${path}.owners`, 'utf8')) as { owners: Record<string, { host?: string }> };
  expect(owners.owners[bindingKey(bindingFor(99))]?.host).toBeTruthy();
}));
