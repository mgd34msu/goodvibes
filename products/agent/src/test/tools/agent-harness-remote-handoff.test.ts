import { describe, expect, test } from 'bun:test';
import {
  remoteMissingInput,
  remotePairApproveHandoff,
  remotePairRejectHandoff,
  remotePeersInvokeHandoff,
  remoteWorkCancelHandoff,
} from '../../tools/agent-harness-remote.ts';

describe('remote handoffs', () => {
  test('a pair approval keeps the whole call, request id included, in modelRoute', () => {
    const handoff = remotePairApproveHandoff({ requestId: 'req-123' });
    expect(handoff).toMatchObject({
      modelRoute: 'agent_operator_method methodId:"remote.pair.requests.approve" input:{"requestId":"req-123"}',
    });
  });

  test('confirmReplace travels in the approve input only when it is exactly true', () => {
    const confirmed = remotePairApproveHandoff({ requestId: 'r1', confirmReplace: true });
    if (!('input' in confirmed)) throw new Error('expected a handoff');
    expect(confirmed.input).toEqual({ requestId: 'r1', confirmReplace: true });
    expect(confirmed.modelRoute).toContain('"confirmReplace":true');
    for (const value of ['true', 1, false, undefined]) {
      const handoff = remotePairApproveHandoff({ requestId: 'r1', confirmReplace: value });
      if (!('input' in handoff)) throw new Error('expected a handoff');
      expect(handoff.input).toEqual({ requestId: 'r1' });
    }
  });

  test.each([
    ['approve', remotePairApproveHandoff, { requestId: 'r1' }],
    ['reject', remotePairRejectHandoff, { requestId: 'r1', note: 'no' }],
    ['invoke', remotePeersInvokeHandoff, { peerId: 'p1', command: 'run', payload: { a: 1 } }],
    ['cancel', remoteWorkCancelHandoff, { workId: 'w1', reason: 'stop' }],
  ] as const)('%s route ends with the closing brace of its input', (_name, build, args) => {
    const handoff = build(args);
    if (!('modelRoute' in handoff)) throw new Error('expected a handoff');
    expect(handoff.modelRoute.endsWith(`input:${JSON.stringify(handoff.input)}`)).toBe(true);
    expect(handoff.modelRoute).not.toContain('...');
  });

  test.each([
    ['approve', remotePairApproveHandoff, ['requestId']],
    ['reject', remotePairRejectHandoff, ['requestId']],
    ['invoke', remotePeersInvokeHandoff, ['peerId', 'command']],
    ['cancel', remoteWorkCancelHandoff, ['workId']],
  ] as const)('%s without its ids names the missing fields instead of handing off', (_name, build, missing) => {
    const result = build({});
    expect(result).toMatchObject({ status: 'missing_input', missing });
    expect('modelRoute' in result).toBe(false);
    for (const field of missing) expect((result as { error: string }).error).toContain(field);
  });

  test('a target stands in for the id, and invoke still needs its command', () => {
    expect(remoteMissingInput('remote_pair_approve', { target: 'req-9' })).toBeNull();
    expect(remoteMissingInput('remote_peers_invoke', { target: 'peer-9' })?.missing).toEqual(['command']);
  });
});
