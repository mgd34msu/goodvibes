import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDaemonSystemRouteHandlers } from '../daemon-api/src/system-routes.js';
import type { DaemonSystemRouteContext } from '../daemon-api/src/system-route-types.js';
import { ApprovalBroker } from '../platform/src/platform/control-plane/approval-broker.js';
import type { PermissionPromptRequest } from '../platform/src/platform/permissions/prompt.js';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const REQUEST: PermissionPromptRequest = { callId: 'fixture', tool: 'workspace-trust', args: { workspace: '/fixture' }, category: 'read', analysis: { classification: 'workspace-trust', riskLevel: 'high', summary: 'Fixture trust', reasons: ['fixture'] } };

for (const action of ['approve', 'deny', 'claim', 'cancel'] as const) {
  test(`an unreadable body on /api/approvals/:id/${action} is refused and leaves the approval pending`, async () => {
    const root = mkdtempSync(join(tmpdir(), 'approval-invalid-body-')); roots.push(root);
    const broker = new ApprovalBroker({ storePath: join(root, 'approvals.json') });
    const raised = await broker.raiseApproval({ request: REQUEST });
    const context = {
      approvalBroker: broker,
      parseOptionalJsonBody: async () => Response.json({ error: 'Invalid JSON body' }, { status: 400 }),
      requireAdmin: () => null,
      requireAuthenticatedSession: () => ({ username: 'fixture-owner', roles: ['admin'] }),
      recordApiResponse: (_request: Request, _path: string, response: Response) => response,
    } as unknown as DaemonSystemRouteContext;
    const response = await createDaemonSystemRouteHandlers(context).approvalAction(raised.approval.id, action, new Request('http://daemon.test/x', { method: 'POST', body: '{' }));
    expect(response.status).toBe(400);
    expect(broker.getApproval(raised.approval.id)?.status).toBe('pending');
    await broker.cancelApproval(raised.approval.id, 'fixture cleanup'); await raised.decision;
  });
}
