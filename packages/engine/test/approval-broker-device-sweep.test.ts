import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ApprovalBroker } from '../platform/src/platform/control-plane/approval-broker.js';
import type { PermissionPromptRequest } from '../platform/src/platform/permissions/prompt.js';

const cleanup: string[] = [];
afterEach(() => { for (const path of cleanup.splice(0)) rmSync(path, { recursive: true, force: true }); });

function phoneAsk(callId: string): PermissionPromptRequest {
  // Identical asks are coalesced into one record, so each carries its own call id in its args.
  return { callId, tool: 'phone', args: { action: 'invoke', callId }, category: 'execute',
    analysis: { classification: 'execute', riskLevel: 'medium', summary: 'use a device capability', reasons: [] } };
}

test('allowing one capability on one device always does not answer other device asks', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'gv-approval-device-'));
  cleanup.push(dir);
  const broker = new ApprovalBroker({ storePath: join(dir, 'approvals.json') });
  const device = (nodeId: string, capability: string) => ({ deviceNodeId: nodeId, deviceCapability: capability });
  const camera = await broker.raiseApproval({ request: phoneAsk('camera-a'), metadata: device('node-a', 'camera') });
  const microphone = await broker.raiseApproval({ request: phoneAsk('mic-b'), metadata: device('node-b', 'microphone') });
  const otherNode = await broker.raiseApproval({ request: phoneAsk('camera-b'), metadata: device('node-b', 'camera') });
  const sameGrant = await broker.raiseApproval({ request: phoneAsk('camera-a-again'), metadata: device('node-a', 'camera') });

  await broker.resolveApproval(camera.approval.id, { approved: true, rememberTier: 'tool', actor: 'operator' });

  expect(broker.getApproval(microphone.approval.id)?.status).toBe('pending');
  expect(broker.getApproval(otherNode.approval.id)?.status).toBe('pending');
  expect(broker.getApproval(sameGrant.approval.id)).toMatchObject({ status: 'approved', decision: { disposition: 'remembered' } });
  expect(await sameGrant.decision).toMatchObject({ approved: true });
});
