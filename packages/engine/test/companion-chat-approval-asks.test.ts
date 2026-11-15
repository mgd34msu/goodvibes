/** A companion chat tool call that needs the owner raises an approval; it is not denied as if the user had refused. */
import { seedBenchmarkCache } from './_helpers/benchmark-cache.ts';
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { bootDaemon, type BootedDaemon } from '../platform/src/platform/daemon/boot.ts';

let home: string, work: string, daemon: BootedDaemon;
beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), 'companion-ask-home-')); seedBenchmarkCache(home, 'goodvibes');
  work = mkdtempSync(join(tmpdir(), 'companion-ask-work-'));
  daemon = await bootDaemon({ homeDirectory: home, workingDir: work, daemonHomeDir: join(home, 'daemon'), port: 0, host: '127.0.0.1', token: 'companion-ask-token' });
});
afterAll(async () => { await daemon?.stop(); rmSync(home, { recursive: true, force: true }); rmSync(work, { recursive: true, force: true }); });

test("the companion chat's permission asks reach the approval broker and are answered by whoever decides", async () => {
  type Ask = (request: unknown, execution?: unknown) => Promise<{ approved: boolean }>;
  const chat = (daemon.server as unknown as { companionChatManager: { permissionManager: { requestPermission: Ask } } }).companionChatManager;
  const answer = chat.permissionManager.requestPermission({ callId: 'companion-call-1', tool: 'exec', args: { command: 'ls' }, category: 'execute',
    analysis: { classification: 'execute', riskLevel: 'medium', summary: 'List files', reasons: [] }, rememberOptions: [] });
  let raised = daemon.approvals.listApprovals().find(entry => entry.request.callId === 'companion-call-1');
  for (let turn = 0; !raised && turn < 200; turn++) { await new Promise<void>(resolve => setImmediate(resolve)); raised = daemon.approvals.listApprovals().find(entry => entry.request.callId === 'companion-call-1'); }
  expect(raised?.status).toBe('pending');
  await daemon.approvals.resolveApproval(raised!.id, { approved: true, disposition: 'approved', actor: 'owner', actorSurface: 'web' });
  expect((await answer).approved).toBe(true);
});
