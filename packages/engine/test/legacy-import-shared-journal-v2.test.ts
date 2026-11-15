/** Actual SQLite/private filesystem. */
import { afterEach, expect, spyOn, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import * as crypto from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { LegacyImportJournal, type LegacyImportBinding } from '../terminal-shell/src/legacy-work-ledger-import-journal.js';
import { resolveLegacyImportJournalLocation, retainLegacyImportJournalOwner } from '../terminal-shell/src/legacy-work-ledger-import-path.js';
import { prepareLegacyWorkLedgerMigration } from '../platform/src/platform/workflow/work-ledger/legacy-import.js';
import fixture from '../../../products/agent/src/test/fixtures/legacy-ledger/preparation.json' with { type: 'json' };

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function setup() {
  const root = mkdtempSync(join(tmpdir(), 'shared-import-journal-')), workspace = join(root, 'workspace'), stateDirectory = join(root, 'state');
  roots.push(root); mkdirSync(workspace);
  const prepared = prepareLegacyWorkLedgerMigration(fixture); if (prepared.kind !== 'prepared') throw new Error(prepared.reason);
  const binding: LegacyImportBinding = { endpoint: 'http://host', projectId: fixture.projectId, workspaceId: workspace, principalKind: 'token', principalId: 'principal' };
  const command = { type: 'import_legacy' as const, requestId: 'original', expectedRevision: prepared.manifest.expectedLedgerRevision, manifest: prepared.manifest };
  const selected = resolveLegacyImportJournalLocation({ workspace, stateDirectory, projectId: fixture.projectId });
  return { root, workspace, stateDirectory, binding, command, selected, path: selected.journalPath };
}
function open(f: ReturnType<typeof setup>, beforeWrite?: () => void) {
  return new LegacyImportJournal(f.path, undefined, { layout: f.selected.layout, beforeWrite });
}

test('fresh alias/project selections use one exact keyed journal without hashes or filesystem effects on status', () => {
  const f = setup(), alias = join(f.root, 'alias'); symlinkSync(f.workspace, alias);
  const hashing = spyOn(crypto, 'createHash');
  try {
    const selected = resolveLegacyImportJournalLocation({ workspace: alias, projectId: 'different project', stateDirectory: f.stateDirectory });
    expect(selected.journalPath).toBe(f.path); expect(selected.workspace).toBe(f.selected.workspace); expect(selected.layout).toBe('shared-v2');
    const journal = open(f); try { expect(journal.read(f.binding)).toBeNull(); } finally { journal.close(); }
    expect(existsSync(f.stateDirectory)).toBe(false);
    expect(hashing.mock.calls.filter(([algorithm]) => algorithm === 'sha256')).toHaveLength(0);
  } finally { hashing.mockRestore(); }
});

test('format declaration precedes the first directory, database or pending command mutation', () => {
  for (const nonvoid of [false, true]) {
    const f = setup(); let calls = 0;
    const journal = open(f, () => { calls++; expect(existsSync(f.stateDirectory)).toBe(false); if (nonvoid) return Promise.reject(new Error('Async owner is invalid')); throw new Error('Installed reader unavailable'); });
    try { expect(() => journal.reserve(f.binding, () => f.command)).toThrow(); expect(calls).toBe(1); expect(existsSync(f.stateDirectory)).toBe(false); }
    finally { journal.close(); }
  }
});

test('actual native owner declares manifest3 before publishing the first saved command', () => {
  for (const nonvoid of [false, true]) {
    const f = setup(), formats: string[] = [];
    let permitted = false;
    const config = { getNativeDataWriter() { return { declare(format: string) {
      formats.push(format);
      if (format === 'native-historical-import-revisions-v3' && !permitted) {
        if (nonvoid) return Promise.reject(new Error('Invalid asynchronous preparation owner'));
        throw new Error('Preparation reader unavailable');
      }
    } }; } };
    const options = retainLegacyImportJournalOwner(f.selected, config, f.stateDirectory, () => ({ config, stateDirectory: f.stateDirectory }));
    const journal = new LegacyImportJournal(f.path, undefined, options);
    try {
      expect(() => journal.reserve(f.binding, () => f.command)).toThrow(nonvoid ? 'synchronous native owner' : 'Preparation reader unavailable');
      expect(formats).toContain('native-historical-import-revisions-v3');
      expect(journal.read(f.binding)).toBeNull();
      permitted = true;
      expect(journal.reserve(f.binding, () => f.command).command).toEqual(f.command);
      expect(journal.read(f.binding)?.command.manifest.version).toBe(3);
    } finally { journal.close(); }
  }
});

test('exact workspace/project slots preserve independent bindings, immutable unknown commands and restart recovery', () => {
  const f = setup(); let journal = open(f);
  try {
    journal.reserve(f.binding, () => f.command); journal.dispatch(f.binding, f.command); journal.close();
    const bytes = readFileSync(f.path); journal = open(f);
    expect(journal.read(f.binding)).toMatchObject({ state: 'unknown', attempts: 1, command: f.command });
    expect(readFileSync(f.path)).toEqual(bytes);
    expect(journal.reserve(f.binding, () => { throw new Error('Unknown requests cannot remint commands'); }).command).toEqual(f.command);
    expect(journal.cancel(f.binding, f.command)?.state).toBe('unknown');
    expect(() => journal.reserve(f.binding, () => f.command, f.command.requestId)).toThrow('Unresolved');
    expect(() => journal.read({ ...f.binding, principalId: 'replacement-owner' })).toThrow('another');
    expect(() => journal.read({ ...f.binding, endpoint: 'http://other-host' })).toThrow('another');
    const otherWorkspace = join(f.root, 'other-workspace'); mkdirSync(otherWorkspace);
    const otherBinding = { ...f.binding, workspaceId: otherWorkspace };
    expect(journal.reserve(otherBinding, () => ({ ...f.command, requestId: 'another-workspace' })).command.requestId).toBe('another-workspace');
    const next = prepareLegacyWorkLedgerMigration(JSON.parse(JSON.stringify(fixture).replaceAll(fixture.projectId, 'second-project')));
    if (next.kind !== 'prepared') throw new Error(next.reason);
    const otherProject = { ...f.binding, projectId: 'second-project' };
    expect(journal.reserve(otherProject, () => ({ ...f.command, requestId: 'another-project', manifest: next.manifest })).command.requestId).toBe('another-project');
    expect(journal.read(f.binding)?.command.requestId).toBe('original');
    expect(statSync(f.path).mode & 0o777).toBe(0o600);
  } finally { journal.close(); }
});

test('future saved and live formats are refused without rewriting their database', () => {
  const f = setup(); let journal = open(f);
  journal.reserve(f.binding, () => f.command); journal.close();
  const foreign = new Database(f.path); foreign.exec('PRAGMA user_version=3'); foreign.close();
  const before = readFileSync(f.path); expect(() => open(f).read(f.binding)).toThrow('Unsupported'); expect(readFileSync(f.path)).toEqual(before);
  const restore = new Database(f.path); restore.exec('PRAGMA user_version=2'); restore.close();
  journal = open(f);
  const change = new Database(f.path); change.exec('PRAGMA user_version=3'); change.close();
  const changed = readFileSync(f.path);
  try { expect(() => journal.read(f.binding)).toThrow('Unsupported import journal version; preserve existing data'); expect(() => journal.dispatch(f.binding, f.command)).toThrow(); expect(readFileSync(f.path)).toEqual(changed); }
  finally { journal.close(); }
});

test('existing historical shared filenames retain their exact file, binding and unknown command', () => {
  const f = setup(), key = crypto.createHash('sha256').update(JSON.stringify([f.selected.workspace, f.binding.projectId])).digest('hex');
  const path = join(dirname(f.path), `${key}.sqlite`); const old = new LegacyImportJournal(path);
  old.reserve(f.binding, () => f.command); old.dispatch(f.binding, f.command); old.close();
  const before = readFileSync(path), selection = resolveLegacyImportJournalLocation({ workspace: f.workspace, stateDirectory: f.stateDirectory, projectId: f.binding.projectId });
  expect(selection.layout).toBe('historical-v1'); expect(selection.journalPath).toBe(path);
  const journal = new LegacyImportJournal(path, undefined, { layout: selection.layout });
  try { expect(journal.read(f.binding)).toMatchObject({ state: 'unknown', command: f.command }); expect(readFileSync(path)).toEqual(before); }
  finally { journal.close(); }
});

test('two real journals for the same scope cannot hide or replace either unknown request', () => {
  const f = setup(), shared = open(f); shared.reserve(f.binding, () => f.command); shared.dispatch(f.binding, f.command); shared.close();
  const key = crypto.createHash('sha256').update(JSON.stringify([f.selected.workspace, f.binding.projectId])).digest('hex');
  const path = join(dirname(f.path), `${key}.sqlite`), old = new LegacyImportJournal(path);
  old.reserve(f.binding, () => ({ ...f.command, requestId: 'other-old-request' })); old.dispatch(f.binding, { ...f.command, requestId: 'other-old-request' }); old.close();
  const original = readFileSync(f.path), historical = readFileSync(path);
  expect(() => resolveLegacyImportJournalLocation({ workspace: f.workspace, stateDirectory: f.stateDirectory, projectId: f.binding.projectId })).toThrow('Both historical and shared');
  expect(readFileSync(f.path)).toEqual(original); expect(readFileSync(path)).toEqual(historical);
});

test('independent native processes retain the original winning shared slot after a crash', async () => {
  const f = setup(), initial = open(f); initial.reserve(f.binding, () => f.command); initial.close();
  const module = new URL('../terminal-shell/src/legacy-work-ledger-import-journal.ts', import.meta.url).pathname;
  const run = (id: string, hold: boolean) => Bun.spawn([process.execPath, '-e', `import {LegacyImportJournal} from ${JSON.stringify(module)};const j=new LegacyImportJournal(${JSON.stringify(f.path)},undefined,{layout:'shared-v2'});const e=j.reserve(${JSON.stringify(f.binding)},()=>({...${JSON.stringify(f.command)},requestId:${JSON.stringify(id)}}));console.log(e.command.requestId);${hold ? 'setInterval(()=>{},1000)' : 'j.close()'}`], { stdout: 'pipe', stderr: 'pipe' });
  const first = run('must-not-replace', true), reader = first.stdout.getReader();
  try { expect(new TextDecoder().decode((await reader.read()).value)).toContain('original'); }
  finally { reader.releaseLock(); first.kill('SIGKILL'); await first.exited; }
  for (const child of [run('agent', false), run('tui', false)]) { expect((await new Response(child.stdout).text()).trim()).toBe('original'); expect(await child.exited).toBe(0); }
});

test('explicit recovery of an actual killed SQLite writer preserves the original durable unknown command', async () => {
  const f = setup(), initial = open(f); initial.reserve(f.binding, () => f.command); initial.dispatch(f.binding, f.command); initial.close();
  const child = Bun.spawn([process.execPath, '-e', `import {Database} from 'bun:sqlite';const d=new Database(${JSON.stringify(f.path)});d.exec('PRAGMA journal_mode=DELETE;PRAGMA synchronous=FULL;PRAGMA cache_size=1;BEGIN IMMEDIATE;');d.query('UPDATE shared_legacy_import SET command=command||?,attempts=999').run('x'.repeat(2*1024*1024));console.log('uncommitted');setInterval(()=>{},1000);`], { stdout: 'pipe', stderr: 'pipe' });
  const reader = child.stdout.getReader();
  try { expect(new TextDecoder().decode((await reader.read()).value)).toContain('uncommitted'); }
  finally { reader.releaseLock(); child.kill('SIGKILL'); await child.exited; }
  expect(existsSync(f.path + '-journal')).toBe(true);
  const before = readFileSync(f.path), spool = readFileSync(f.path + '-journal'), readonly = open(f);
  try { try { readonly.read(f.binding); } catch { /* A hot journal may require explicit write/recovery intent. */ } }
  finally { readonly.close(); }
  expect(readFileSync(f.path)).toEqual(before); expect(readFileSync(f.path + '-journal')).toEqual(spool);
  let declared = 0; const recovered = open(f, () => { declared++; });
  try {
    expect(recovered.readForUpdate(f.binding)).toMatchObject({ state: 'unknown', attempts: 1, command: f.command });
    expect(declared).toBe(1);
    expect(recovered.reserve(f.binding, () => { throw new Error('Never mint a replacement for a durable unknown'); }).command).toEqual(f.command);
  } finally { recovered.close(); }
});

