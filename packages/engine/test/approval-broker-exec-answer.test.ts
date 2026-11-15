import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ApprovalBroker, type SharedApprovalRecord } from '../platform/src/platform/control-plane/approval-broker.js';
import type { PermissionPromptRequest } from '../platform/src/platform/permissions/prompt.js';

const cleanup: string[] = [];
afterEach(() => { for (const path of cleanup.splice(0)) rmSync(path, { recursive: true, force: true }); });

const SECRET = 's3cret-passphrase';

function execPrompt(): PermissionPromptRequest {
  return { callId: 'exec-prompt-1', tool: 'exec:prompt', args: { command: 'sudo ls', prompt: '[sudo] password:', recentOutput: '' }, category: 'execute',
    analysis: { classification: 'exec-terminal-prompt', riskLevel: 'medium', summary: 'A running command is waiting on its terminal', reasons: [] },
    attribution: { kind: 'exec-prompt', command: 'sudo ls', prompt: '[sudo] password:' } };
}

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'gv-approval-exec-answer-'));
  cleanup.push(dir);
  const storePath = join(dir, 'approvals.json');
  const broker = new ApprovalBroker({ storePath });
  const published: unknown[] = [];
  broker.setPublisher({ publishEvent: (_event, payload) => { published.push(payload); }, publishSurfaceMessage: () => {} });
  return { broker, storePath, published };
}

test('the typed answer reaches the waiting command but is not stored, published or returned', async () => {
  const { broker, storePath, published } = fixture();
  const raised = await broker.raiseApproval({ request: execPrompt() });
  const resolved = await broker.resolveApproval(raised.approval.id, { approved: true, remember: false, actor: 'operator', actorSurface: 'tui', modifiedArgs: { answer: SECRET } });

  expect(await raised.decision).toMatchObject({ approved: true, modifiedArgs: { answer: SECRET } });
  expect(JSON.stringify(resolved)).not.toContain(SECRET);
  expect(JSON.stringify(broker.getApproval(raised.approval.id))).not.toContain(SECRET);
  expect(readFileSync(storePath, 'utf8')).not.toContain(SECRET);
  expect(JSON.stringify(published)).not.toContain(SECRET);
});

test('a decision whose first write failed still delivers the real answer when a later write succeeds', async () => {
  const { broker } = fixture();
  const raised = await broker.raiseApproval({ request: execPrompt() });
  const store = (broker as unknown as { store: { persist: (snapshot: unknown) => Promise<void> } }).store;
  const original = store.persist.bind(store);
  let fail = true;
  store.persist = async (snapshot) => { if (fail) throw new Error('disk full'); await original(snapshot); };
  await expect(broker.resolveApproval(raised.approval.id, { approved: true, remember: false, actor: 'operator', actorSurface: 'tui', modifiedArgs: { answer: SECRET } })).rejects.toThrow('could not be written');
  fail = false;
  await broker.resolveApproval(raised.approval.id, { approved: true, remember: false, actor: 'operator', actorSurface: 'tui' });
  expect(await raised.decision).toMatchObject({ approved: true, modifiedArgs: { answer: SECRET } });
});

test('modified arguments on any other ask are kept as sent', async () => {
  const { broker } = fixture();
  const request: PermissionPromptRequest = { callId: 'edit-1', tool: 'edit', args: { path: 'a.txt' }, category: 'write',
    analysis: { classification: 'write', riskLevel: 'medium', summary: 'edit a file', reasons: [] } };
  const raised = await broker.raiseApproval({ request });
  const resolved: SharedApprovalRecord | null = await broker.resolveApproval(raised.approval.id, { approved: true, remember: false, actor: 'operator', actorSurface: 'tui', modifiedArgs: { answer: 'visible' } });
  expect(resolved?.decision?.modifiedArgs).toEqual({ answer: 'visible' });
});
