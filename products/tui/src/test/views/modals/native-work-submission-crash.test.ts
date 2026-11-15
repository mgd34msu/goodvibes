import { expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { NativeWorkSubmissionRequest } from '@goodvibes-jev/engine/platform/platform/workflow/work-ledger/native-submission-client';
import { NativeWorkSubmissionControls } from '@goodvibes-jev/engine/terminal-shell/native';
import { createNativeWorkSubmissionBinding, createNativeSubmissionIdentity } from '../../../runtime/native-work-submission-host.ts';
import { NativeWorkSubmissionJournal } from '@goodvibes-jev/engine/terminal-shell/native';

test('an abandoned submission after server persistence recovers the same journal identity in a restarted controller without cross-principal replay', async () => {
  const home = mkdtempSync(join(tmpdir(), 'native-submit-crash-')); const journalPath = join(home, 'product-state', 'native-work-submission.json');
  const sourcePath = join(home, 'source.json');
  const original = { goal: '  Crash-safe original goal\n  ', criteria: [' first ', 'second', ' first '] };
  writeFileSync(sourcePath, JSON.stringify(original));
  let command: NativeWorkSubmissionRequest | undefined; let received!: () => void;
  const arrived = new Promise<void>(resolve => { received = resolve; }); const mutations: string[] = []; const lookups: string[] = [];
  const server = Bun.serve({ port: 0, hostname: '127.0.0.1', async fetch(request) {
    const path = new URL(request.url).pathname; const replacement = request.headers.get('authorization') === 'Bearer synthetic-replacement-token';
    if (path === '/api/control-plane/auth') return Response.json({ authenticated: true, authMode: 'shared-token', tokenPresent: true, authorizationHeaderPresent: true, sessionCookiePresent: false, principalId: replacement ? 'principal-replacement' : 'principal-original', principalKind: 'token', credential: 'device-token' as const, admin: true, scopes: ['read:work-ledger', 'write:work-ledger'], roles: [] });
    if (path === '/api/work-ledger/snapshot') return Response.json({ projectId: 'p', revision: 0, cursor: 0, works: [] });
    if (path === '/api/work-ledger/submissions') {
      mutations.push(path); command = await request.json() as NativeWorkSubmissionRequest;
      const journal = JSON.parse(readFileSync(journalPath, 'utf8')) as { records: { command: NativeWorkSubmissionRequest }[] };
      expect(journal.records[0]?.command).toEqual(command); // durable publication preceded the first POST
      received(); return await new Promise<Response>(() => {}); // acknowledgement never reaches the child
    }
    if (path === '/api/work-ledger/submissions/get') {
      const input = await request.json() as { requestId: string }; lookups.push(input.requestId);
      if (!command || input.requestId !== command.requestId || replacement) return Response.json({ kind: 'not-found' });
      return Response.json({ kind: 'found', receipt: { projectId: 'p', requestId: command.requestId, inputId: command.inputId, ledgerRevision: 1, workId: 'crash-work', attemptId: 'crash-attempt', expectedRevision: { work: 1, criteria: 1, attempt: 1 }, source: { version: 1, sourceId: 'source-crash', sourceRevision: 'source-v1', sessionId: 'session-crash' }, goal: command.goal, criteria: command.criteria } });
    }
    throw new Error(`Unexpected method: ${path}`);
  } });
  // A restart is a fresh controller over the same journal file: nothing in memory survives, so
  // recovery can only come from what was durably published before the first POST.
  const baseUrl = `http://127.0.0.1:${server.port}`;
  const nativeSubmissionIdentity = createNativeSubmissionIdentity().identify;
  const controllersFor = (token: string) => {
    const host = { baseUrl, token, workspace: home, journalPath };
    return new NativeWorkSubmissionControls(() => ({ available: true, identity: nativeSubmissionIdentity(host, 'p'), endpoint: host.baseUrl, projectId: 'p', workspace: host.workspace, journal: new NativeWorkSubmissionJournal(host.journalPath), bind: () => createNativeWorkSubmissionBinding(host, 'p') }));
  };
  const controllers: NativeWorkSubmissionControls[] = [];
  const launch = (token = 'synthetic-original-token') => { const controls = controllersFor(token); controllers.push(controls); return controls; };
  try {
    const first = launch(); void first.submitFile(sourcePath).catch(() => {}); await arrived;
    expect(command).toMatchObject({ expectedRevision: 0, ...original });
    const bytes = readFileSync(journalPath, 'utf8'); expect(bytes).not.toContain('synthetic-original-token'); expect(bytes).not.toContain('synthetic-replacement-token');
    rmSync(sourcePath); // restart recovery cannot reread or rebuild the original source
    const other = await launch('synthetic-replacement-token').retry();
    if (other === undefined) throw new Error('Expected a retry outcome for the replacement token');
    expect(other.status).toBe('unavailable'); expect(lookups).toEqual([]); expect(mutations).toHaveLength(1);
    const result = await launch().retry();
    if (result === undefined) throw new Error('Expected a retry outcome');
    expect(result.status).toBe('submitted'); if (result.status !== 'submitted') throw new Error('Expected a recovered submission');
    const receipt = result.receipt; if (receipt === undefined) throw new Error('Expected a recovered receipt');
    expect(receipt.requestId).toBe(command!.requestId); expect(receipt.inputId).toBe(command!.inputId);
    expect(receipt.goal).toBe(original.goal); expect(receipt.criteria).toEqual(original.criteria);
    expect(lookups).toEqual([command!.requestId]); expect(mutations).toEqual(['/api/work-ledger/submissions']);
  } finally {
    for (const controls of controllers) controls.close();
    server.stop(true); rmSync(home, { recursive: true, force: true });
  }
});
