import { afterEach, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { registerLegacyImportCommands } from '../terminal-shell/src/legacy-work-ledger-import-command.ts';
import { openLegacyImportOperator } from '../terminal-shell/src/legacy-work-ledger-import-operator.ts';
import type { LegacyImportCommand } from '../terminal-shell/src/legacy-work-ledger-import-journal.ts';
import { prepareLegacyWorkLedgerMigration, projectLegacyImportWorks } from '../platform/src/platform/workflow/work-ledger/legacy-import.ts';
import fixture from '../../../products/agent/src/test/fixtures/legacy-ledger/preparation.json' with { type: 'json' };

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function harness() {
  const root = mkdtempSync(join(tmpdir(), 'import-cancel-')); roots.push(root);
  const path = join(root, 'state', 'journal.sqlite');
  const prepared = prepareLegacyWorkLedgerMigration(fixture); if (prepared.kind !== 'prepared') throw new Error(prepared.reason);
  const selected = { baseUrl: 'http://synthetic-host', token: 'synthetic-secret', workspace: root };
  const auth = { authenticated: true, admin: true, principalId: 'paired', principalKind: 'token', scopes: ['read:work-ledger', 'read:knowledge', 'write:work-ledger-import'] };
  const writes: string[] = [];
  const open = () => openLegacyImportOperator({ projectId: fixture.projectId, journalPath: path, resolve: () => selected, journalOptions: { beforeWrite: () => { writes.push('write'); } },
    createClient: () => ({ currentAuth: async () => auth, dispose() {}, invoke: async (method, input) => {
      if (method === 'knowledge.sources.list') return { items: fixture.sources.map(value => value.source), hasMore: false };
      if (method === 'workLedger.prepareLegacyImport') return prepared;
      const command = input as LegacyImportCommand;
      return { kind: 'accepted', replayed: false, event: { type: 'import_legacy', requestId: command.requestId, actorId: 'host-actor', sequence: 1, at: 1, manifest: command.manifest, works: projectLegacyImportWorks(command.manifest, 1) } };
    } }) });
  return { open, path, writes };
}

test('cancelling with a mistyped request ID on a project with no journal creates nothing', async () => {
  const f = harness();
  const session = await f.open();
  try { await expect(session.cancel('mistyped')).rejects.toThrow('does not match'); } finally { session.dispose(); }
  expect(existsSync(f.path)).toBe(false);
  expect(existsSync(join(f.path, '..'))).toBe(false);
  expect(f.writes).toEqual([]);
});

test('the command says nothing was cancelled when the import is not pending', async () => {
  const f = harness();
  const printed: string[] = [];
  let handler!: (args: string[], context: { print(text: string): void }) => Promise<void>;
  registerLegacyImportCommands({ register: command => { handler = command.handler; } }, async () => f.open());
  const context = { print: (text: string) => { printed.push(text); } };
  await handler(['submit', fixture.projectId], context);
  const reader = await f.open();
  const accepted = (await reader.status())!;
  reader.dispose();
  await handler(['cancel', fixture.projectId, accepted.command.requestId], context);
  expect(printed.at(-1)).toContain('Nothing was cancelled');
  expect(printed.at(-1)).toContain('accepted');
});
