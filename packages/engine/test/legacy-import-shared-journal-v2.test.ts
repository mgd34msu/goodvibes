/** Actual SQLite/private filesystem. Regression source UNRUN. */
import { afterEach, expect, spyOn, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import * as crypto from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { LegacyImportJournal, type LegacyImportBinding } from '../terminal-shell/src/legacy-work-ledger-import-journal.js';
import { openLegacyImportOperator, type LegacyImportOperatorOptions } from '../terminal-shell/src/legacy-work-ledger-import-operator.js';
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
  return new LegacyImportJournal(f.path, undefined, { layout: f.selected.layout, assertCurrent: f.selected.assertCurrent, beforeWrite });
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

test('an equal-valued replacement configuration cannot acquire the original journal selection', () => {
  const f = setup(), formats: string[] = [], config = { getNativeDataWriter() { return { declare(format: string) { formats.push(format); } }; } };
  let current = config;
  const options = retainLegacyImportJournalOwner(f.selected, config, f.stateDirectory, () => ({ config: current, stateDirectory: f.stateDirectory }));
  const journal = new LegacyImportJournal(f.path, undefined, options); current = { ...config };
  try { expect(() => journal.reserve(f.binding, () => f.command)).toThrow('selection changed'); expect(formats).toEqual([]); expect(existsSync(f.stateDirectory)).toBe(false); }
  finally { journal.close(); }
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

test('same-byte replacement file and replaced parent cannot acquire the original pending journal', () => {
  for (const replaceParent of [false, true]) {
    const f = setup(), journal = open(f);
    try {
      journal.reserve(f.binding, () => f.command);
      if (replaceParent) { renameSync(dirname(f.path), dirname(f.path) + '-original'); mkdirSync(dirname(f.path)); writeFileSync(f.path, 'foreign private journal', { mode: 0o600 }); }
      else { const bytes = readFileSync(f.path); renameSync(f.path, f.path + '-original'); writeFileSync(f.path, bytes, { mode: 0o600 }); }
      const foreign = readFileSync(f.path);
      expect(() => journal.dispatch(f.binding, f.command)).toThrow(); expect(() => journal.read(f.binding)).toThrow();
      expect(readFileSync(f.path)).toEqual(foreign);
    } finally { journal.close(); }
  }
});

test('borrowed command construction cannot write or clean a retargeted parent', () => {
  const f = setup(), journal = open(f);
  try {
    expect(() => journal.reserve(f.binding, () => {
      renameSync(dirname(f.path), dirname(f.path) + '-original'); mkdirSync(dirname(f.path)); writeFileSync(f.path, 'foreign bytes', { mode: 0o600 });
      return f.command;
    })).toThrow();
    expect(readFileSync(f.path, 'utf8')).toBe('foreign bytes'); expect(readdirSync(dirname(f.path))).toEqual(['journal.sqlite']);
  } finally { journal.close(); }
});

test('a rejected command promise is drained even when its callback retires the original parent', async () => {
  const f = setup(), journal = open(f), rejected: unknown[] = [], listener = (reason: unknown) => { rejected.push(reason); };
  process.on('unhandledRejection', listener);
  try {
    const make = (() => { renameSync(dirname(f.path), dirname(f.path) + '-original'); mkdirSync(dirname(f.path)); writeFileSync(f.path, 'foreign bytes', { mode: 0o600 }); return Promise.reject(new Error('Late rejected command')); }) as unknown as () => typeof f.command;
    expect(() => journal.reserve(f.binding, make)).toThrow();
    await new Promise<void>(resolve => setTimeout(resolve, 1));
    expect(rejected).toEqual([]); expect(readFileSync(f.path, 'utf8')).toBe('foreign bytes');
  } finally { journal.close(); process.off('unhandledRejection', listener); }
});

test('future saved and live formats are refused without rewriting their database', () => {
  const f = setup(); let journal = open(f);
  journal.reserve(f.binding, () => f.command); journal.close();
  const foreign = new Database(f.path); foreign.exec('PRAGMA user_version=3'); foreign.close();
  const before = readFileSync(f.path); expect(() => open(f)).toThrow('Unsupported'); expect(readFileSync(f.path)).toEqual(before);
  const restore = new Database(f.path); restore.exec('PRAGMA user_version=2'); restore.close();
  journal = open(f);
  const change = new Database(f.path); change.exec('PRAGMA user_version=3'); change.close();
  const changed = readFileSync(f.path);
  try { expect(() => journal.read(f.binding)).toThrow('format changed'); expect(() => journal.dispatch(f.binding, f.command)).toThrow(); expect(readFileSync(f.path)).toEqual(changed); }
  finally { journal.close(); }
});

test('existing historical shared filenames retain their exact file, binding and unknown command', () => {
  const f = setup(), key = crypto.createHash('sha256').update(JSON.stringify([f.selected.workspace, f.binding.projectId])).digest('hex');
  const path = join(dirname(f.path), `${key}.sqlite`); const old = new LegacyImportJournal(path);
  old.reserve(f.binding, () => f.command); old.dispatch(f.binding, f.command); old.close();
  const before = readFileSync(path), selection = resolveLegacyImportJournalLocation({ workspace: f.workspace, stateDirectory: f.stateDirectory, projectId: f.binding.projectId });
  expect(selection.layout).toBe('historical-v1'); expect(selection.journalPath).toBe(path);
  const journal = new LegacyImportJournal(path, undefined, { layout: selection.layout, assertCurrent: selection.assertCurrent });
  try { expect(journal.read(f.binding)).toMatchObject({ state: 'unknown', command: f.command }); expect(readFileSync(path)).toEqual(before); }
  finally { journal.close(); }
});

test('two real journals for the same scope cannot hide or replace either unknown request', () => {
  const f = setup(), shared = open(f); shared.reserve(f.binding, () => f.command); shared.dispatch(f.binding, f.command); shared.close();
  const key = crypto.createHash('sha256').update(JSON.stringify([f.selected.workspace, f.binding.projectId])).digest('hex');
  const path = join(dirname(f.path), `${key}.sqlite`), old = new LegacyImportJournal(path);
  old.reserve(f.binding, () => ({ ...f.command, requestId: 'other-old-request' })); old.dispatch(f.binding, { ...f.command, requestId: 'other-old-request' }); old.close();
  const original = readFileSync(f.path), historical = readFileSync(path);
  expect(() => f.selected.assertCurrent()).toThrow('Both historical and shared');
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


test('authentication cannot retarget an open import session to a different project, journal or resolver', async () => {
  const f = setup(), original = open(f);
  original.reserve(f.binding, () => f.command); original.dispatch(f.binding, f.command); original.close();
  const saved = readFileSync(f.path), replacementPath = join(f.root, 'replacement.sqlite');
  let release!: () => void;
  const authenticated = new Promise<void>(resolve => { release = resolve; });
  let authenticationStarted!: () => void;
  const started = new Promise<void>(resolve => { authenticationStarted = resolve; });
  const auth = { authenticated: true, admin: true, principalId: f.binding.principalId, principalKind: f.binding.principalKind, scopes: ['read:work-ledger', 'read:knowledge'] };
  const host = { baseUrl: f.binding.endpoint, token: 'original-test-token', workspace: f.workspace };
  let disposed = 0;
  const options: { -readonly [K in keyof LegacyImportOperatorOptions]: LegacyImportOperatorOptions[K] } = {
    projectId: f.binding.projectId, journalPath: f.path,
    journalOptions: { layout: f.selected.layout, assertCurrent: f.selected.assertCurrent },
    resolve: () => host,
    createClient: () => ({
      async currentAuth() { authenticationStarted(); await authenticated; return auth; },
      async invoke() { throw new Error('Status must never dispatch'); },
      dispose() { disposed++; },
    }),
  };
  const pending = openLegacyImportOperator(options);
  await started;
  options.projectId = 'replacement-project'; options.journalPath = replacementPath;
  options.resolve = () => { throw new Error('Replacement resolver must not acquire this session'); };
  options.createClient = () => { throw new Error('Replacement client must not acquire this session'); };
  release();
  const session = await pending;
  try {
    expect(session.binding).toEqual(f.binding);
    expect(await session.status()).toMatchObject({ binding: f.binding, state: 'unknown', attempts: 1, command: f.command });
    expect(readFileSync(f.path)).toEqual(saved); expect(existsSync(replacementPath)).toBe(false);
  } finally { session.dispose(); }
  expect(disposed).toBe(1);
});
