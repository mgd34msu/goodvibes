/** Regression source UNRUN during the coding-first pass. No providers or executors. */
import { afterEach, expect, test } from 'bun:test';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { KnowledgeStore } from '../platform/src/platform/knowledge/store.js';
import { PairingTokenManager } from '../platform/src/platform/pairing/pairing-token-store.js';
import { WorkspaceRegistrationStore } from '../platform/src/platform/workspace/registration/store.js';
import { DaemonControlPlaneHelper, type DaemonControlPlaneContext } from '../platform/src/platform/daemon/control-plane.js';
import { GatewayMethodCatalog } from '../platform/src/platform/control-plane/method-catalog.js';
import { createWorkLedger, readWorkLedgerState } from '../platform/src/platform/workflow/work-ledger/service.js';
import { createNativeWorkSubmissionHost } from '../platform/src/platform/workflow/work-ledger/native-submission.js';
import { createOperatorNativeWorkSubmissionClient, nativeWorkSubmissionReceiptSchema } from '../platform/src/platform/workflow/work-ledger/native-submission-client.js';
import type { OperatorRemoteClient } from '../operator-client/src/client-core.js';
import { loadSqlJsEngine } from '../platform/src/platform/state/sqlite-store.js';
import { createNativeDataWriteOwner, nativeReaderCapabilities, assertNativeReaderCompatible } from '../platform/src/platform/runtime/native-reader-compatibility.js';
import { realUpdateFileIo } from '../platform/src/platform/runtime/self-update.js';

const cleanup: Array<() => Promise<void> | void> = [];
const clock = { now: () => 100, newId: (kind: string) => `${kind}-${randomUUID()}` };
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
async function fixture(declare?: (format: string) => void) {
  const root = mkdtempSync(join(tmpdir(), 'native-explicit-v3-')); cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, '.goodvibes'));
  const workspace = join(root, 'workspace'); mkdirSync(workspace);
  const tokens = new PairingTokenManager(join(root, '.goodvibes', 'pairing.json')), token = tokens.mint({ name: 'Synthetic explicit source fixture' });
  const helper = new DaemonControlPlaneHelper({ pairingTokens: tokens, authToken: () => 'synthetic-shared', gatewayMethods: new GatewayMethodCatalog(),
    controlPlaneGateway: { touchWebSocketClient() {} } } as unknown as DaemonControlPlaneContext);
  const authority = helper.createNativeExecutionAuthority(token.token)!;
  const scopes = new WorkspaceRegistrationStore({ path: join(root, '.goodvibes', 'workspaces.json'), homeDir: root, daemonStateDir: join(root, '.goodvibes', 'daemon') }); await scopes.add(workspace);
  const file = join(root, '.goodvibes', 'knowledge.sqlite'), store = new KnowledgeStore({ dbPath: file, ...(declare ? { nativeDataWriter: { declare } } : {}) });
  cleanup.push(() => store.close()); const storage = await store.openWorkLedgerStorage('project');
  const ledger = createWorkLedger({ projectId: 'project', storage, clock });
  const deps = { projectId: 'project', projectRoot: workspace, sessionId: 'native-session', service: ledger.service, authority: ledger.authority, scopes };
  const host = createNativeWorkSubmissionHost(deps); cleanup.push(() => host.close());
  const actor = ledger.authority.issueActor({ actorId: authority.current()!.principalId, projectId: 'project', role: 'coordinator' });
  const input = { requestId: 'original-request', inputId: 'original-input', expectedRevision: 0, goal: '  Keep exact source. 🌻\r\n', criteria: ['  Keep order.  ', 'Keep duplicates.', 'Keep duplicates.'] };
  return { root, workspace, file, store, storage, tokens, token, authority, ledger, deps, host, actor, input };
}

test('real paired explicit source v3 creates one opaque identity; concurrent/restarted replay preserves the full original event', async () => {
  const f = await fixture(), other = createNativeWorkSubmissionHost(f.deps); cleanup.push(() => other.close());
  const [first, second] = await Promise.all([f.host.submit(f.input, f.authority), other.submit(f.input, f.authority)]);
  expect(first.receipt).toEqual(second.receipt); expect([first.replayed, second.replayed].sort()).toEqual([false, true]);
  expect(first.receipt.source.version).toBe(3); expect(first.receipt.source.sourceId).toMatch(/^[a-p]{8}(?:-[a-p]{4}){3}-[a-p]{12}$/);
  expect(first.receipt.source.sourceId).not.toContain(f.authority.current()!.principalId);
  const before = readFileSync(f.file), originalState = readWorkLedgerState(await f.storage.read(), 'project');
  expect(originalState.works).toHaveLength(1); expect(originalState.attempts).toHaveLength(1);
  expect(JSON.parse(originalState.receipts[0]!.signature).command.source).toEqual(originalState.works[0]!.source);
  const reopened = new KnowledgeStore({ dbPath: f.file }); cleanup.push(() => reopened.close());
  const ledger = createWorkLedger({ projectId: 'project', storage: await reopened.openWorkLedgerStorage('project'), clock });
  const restarted = createNativeWorkSubmissionHost({ ...f.deps, service: ledger.service, authority: ledger.authority }); cleanup.push(() => restarted.close());
  expect(await restarted.submit(f.input, f.authority)).toEqual({ kind: 'submitted', replayed: true, receipt: first.receipt });
  expect(await restarted.get({ requestId: f.input.requestId }, f.authority)).toEqual({ kind: 'found', receipt: first.receipt });
  for (const changed of [{ ...f.input, expectedRevision: 1 }, { ...f.input, inputId: 'different' }, { ...f.input, goal: f.input.goal.trim() }, { ...f.input, criteria: [...f.input.criteria].reverse() }]) {
    await expect(restarted.submit(changed, f.authority)).rejects.toMatchObject({ code: 'request-conflict' });
  }
  expect(readFileSync(f.file)).toEqual(before);
});

test('actual v3 ledger publication declares its native floor before the first event; a denied owner publishes no source or attempt', async () => {
  let deny = true; const formats: string[] = [], f = await fixture(format => { formats.push(format); if (format === 'native-explicit-sources-v3' && deny) throw new Error('Synthetic unsupported explicit-source reader'); });
  expect(formats).not.toContain('native-explicit-sources-v3');
  await expect(f.host.submit(f.input, f.authority)).rejects.toMatchObject({ code: 'indeterminate' });
  expect(readWorkLedgerState(await f.storage.read(), 'project')).toMatchObject({ revision: 0, works: [], attempts: [], history: [] });
  deny = false; const receipt = (await f.host.submit(f.input, f.authority)).receipt;
  expect(receipt.source.version).toBe(3); expect(formats).toContain('native-explicit-sources-v3');
});

test('the actual saved source3 floor fences an older reader with the same version number', async () => {
  let owner: ReturnType<typeof createNativeDataWriteOwner> | undefined;
  const f = await fixture(format => { if (format === 'native-explicit-sources-v3') owner!.declare('native-explicit-sources-v3'); });
  const execPath = join(f.root, 'goodvibes'); writeFileSync(execPath, 'Synthetic admitted executable');
  owner = createNativeDataWriteOwner({ execPath, version: '3.1.2', assertCurrent() {} });
  await f.host.submit(f.input, f.authority);
  const capabilities = nativeReaderCapabilities('3.1.2');
  expect(() => assertNativeReaderCompatible(execPath, '3.1.2', realUpdateFileIo, { ...capabilities, formats: capabilities.formats.filter(format => format !== 'native-explicit-sources-v3') })).toThrow();
  expect(() => assertNativeReaderCompatible(execPath, '3.1.2', realUpdateFileIo, capabilities)).not.toThrow();
});

test('a failed asynchronous native declaration is drained and cannot publish a source3 event', async () => {
  const f = await fixture(format => {
    if (format === 'native-explicit-sources-v3') return Promise.reject(new Error('Synthetic asynchronous reader declaration'));
  });
  await expect(f.host.submit(f.input, f.authority)).rejects.toMatchObject({ code: 'indeterminate' });
  expect(readWorkLedgerState(await f.storage.read(), 'project')).toMatchObject({ revision: 0, works: [], attempts: [], history: [] });
});

test('historical explicit v1 receipts and signatures remain exact when the new host adopts their original request', async () => {
  const f = await fixture(), principalId = f.authority.current()!.principalId;
  const source = { version: 1, inputId: f.input.inputId, sessionId: f.deps.sessionId,
    sourceId: createHash('sha256').update(JSON.stringify({ projectId: 'project', principalId, inputId: f.input.inputId })).digest('hex'),
    sourceRevision: createHash('sha256').update(JSON.stringify({ version: 1, inputId: f.input.inputId, goal: f.input.goal, criteria: f.input.criteria })).digest('hex') };
  const submitted = await f.ledger.service.execute({ type: 'submit_native', ...f.input, title: f.input.goal.trim(), source }, f.actor);
  if (submitted.kind !== 'accepted' || submitted.event.type !== 'submit_native') throw new Error('Historical fixture not saved');
  const before = readFileSync(f.file), replay = await f.host.submit(f.input, f.authority);
  expect(replay.replayed).toBe(true); expect(replay.receipt.source).toMatchObject({ version: 1, sourceId: source.sourceId, sourceRevision: source.sourceRevision });
  expect(readFileSync(f.file)).toEqual(before); expect((await f.host.get({ requestId: f.input.requestId }, f.authority)).kind).toBe('found');
});

test('future explicit source records refuse mutation without replacing the original SQLite image', async () => {
  const f = await fixture(); await f.host.submit(f.input, f.authority); await f.host.close(); await f.store.close();
  const SQL = await loadSqlJsEngine(), db = new SQL.Database(readFileSync(f.file));
  try {
    const row = db.exec('SELECT state_json FROM work_ledgers WHERE project_id = ?', ['project'])[0]!.values[0]!;
    const state = JSON.parse(String(row[0])); state.works[0].source.version = 4;
    db.run('UPDATE work_ledgers SET state_json = ? WHERE project_id = ?', [JSON.stringify(state), 'project']); writeFileSync(f.file, db.export());
  } finally { db.close(); }
  const before = readFileSync(f.file), reopened = new KnowledgeStore({ dbPath: f.file }); cleanup.push(() => reopened.close());
  const ledger = createWorkLedger({ projectId: 'project', storage: await reopened.openWorkLedgerStorage('project'), clock });
  const host = createNativeWorkSubmissionHost({ ...f.deps, service: ledger.service, authority: ledger.authority }); cleanup.push(() => host.close());
  await expect(host.submit({ ...f.input, requestId: 'another-request', inputId: 'another-input', expectedRevision: 1 }, f.authority)).rejects.toThrow();
  expect(readFileSync(f.file)).toEqual(before);
});

test('the actual operator client accepts fresh source3 and still rejects malformed identity or changed criteria', async () => {
  const f = await fixture(), submitted = await f.host.submit(f.input, f.authority);
  const invoke: OperatorRemoteClient['invoke'] = async <T>() => structuredClone(submitted) as T;
  const client = createOperatorNativeWorkSubmissionClient({ invoke }, 'project');
  try { expect(await client.submit(f.input)).toEqual(submitted); } finally { client.dispose(); }
  expect(nativeWorkSubmissionReceiptSchema.safeParse({ ...submitted.receipt, source: { ...submitted.receipt.source, sourceId: 'private:principal' } }).success).toBe(false);
  const changed = createOperatorNativeWorkSubmissionClient({ invoke: (async <T>() => ({ ...submitted, receipt: { ...submitted.receipt, criteria: ['changed'] } }) as T) }, 'project');
  try { await expect(changed.submit(f.input)).rejects.toMatchObject({ code: 'invalid_response' }); } finally { changed.dispose(); }
});
