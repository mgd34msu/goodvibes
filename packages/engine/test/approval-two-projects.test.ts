// Proves: Two projects' identical questions asked at once under one session id become one question, so the owner's answer for one project settles the other's call.
// Red when: The broker's coalescing key stops including the project of the ask, so an ask from another project joins the open record and its waiter is resolved by that record's answer.
/**
 * One daemon's broker, two projects. The daemon runs work in several projects
 * under one session id (its runners, its native work), so the same call with
 * the same arguments can be asked in two projects at the same moment. Each is
 * its own question: answering yellow's settles yellow's call only, and zinc's
 * keeps waiting. Two identical asks in ONE project still coalesce into one
 * question, the control that the separation is the project and not a blanket
 * end to coalescing. Real broker over a real store file; nothing stands in.
 */
import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ApprovalBroker } from '../platform/src/platform/control-plane/approval-broker.ts';
import type { PermissionPromptRequest } from '../platform/src/platform/permissions/prompt.ts';

let dir: string;
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

function ask(callId: string, workingDirectory: string): PermissionPromptRequest {
  return {
    callId, tool: 'exec', args: { command: 'bun test' }, category: 'execute', workingDirectory,
    analysis: { classification: 'command', riskLevel: 'medium', summary: 'Run bun test', reasons: [] },
  };
}

test('the same ask from two projects under one session is two questions, each settled by its own answer; in one project it is one', async () => {
  dir = mkdtempSync(join(tmpdir(), 'gv-approval-two-projects-'));
  const broker = new ApprovalBroker({ storePath: join(dir, 'approvals.json') });
  await broker.start();
  const yellow = join(dir, 'projects', 'yellow');
  const zinc = join(dir, 'projects', 'zinc');
  const session = 'daemon-runners';
  // Asked at the same moment: yellow's, zinc's, and a second one in yellow.
  const [inYellow, inZinc, againInYellow] = await Promise.all([
    broker.raiseApproval({ request: ask('call-yellow', yellow), sessionId: session }),
    broker.raiseApproval({ request: ask('call-zinc', zinc), sessionId: session }),
    broker.raiseApproval({ request: ask('call-yellow-2', yellow), sessionId: session }),
  ]);
  const settled: string[] = [];
  void inYellow.decision.then((decision) => settled.push(`yellow ${decision.approved ? 'yes' : 'no'}`));
  void inZinc.decision.then((decision) => settled.push(`zinc ${decision.approved ? 'yes' : 'no'}`));
  void againInYellow.decision.then((decision) => settled.push(`yellow again ${decision.approved ? 'yes' : 'no'}`));
  const questions = new Set([inYellow.approval.id, inZinc.approval.id, againInYellow.approval.id]).size;

  // The owner answers yellow's question.
  await broker.resolveApproval(inYellow.approval.id, { approved: true, actor: 'owner', actorSurface: 'tui', expectedRevision: broker.getApproval(inYellow.approval.id)!.revision });
  await inYellow.decision;
  await againInYellow.decision;
  expect(`questions ${questions}; settled ${[...settled].sort().join(', ')}; zinc ${broker.getApproval(inZinc.approval.id)!.status}`)
    .toBe('questions 2; settled yellow again yes, yellow yes; zinc pending');

  await broker.resolveApproval(inZinc.approval.id, { approved: false, actor: 'owner', actorSurface: 'tui', expectedRevision: broker.getApproval(inZinc.approval.id)!.revision });
  await inZinc.decision;
  expect(settled.includes('zinc no')).toBe(true);
});
