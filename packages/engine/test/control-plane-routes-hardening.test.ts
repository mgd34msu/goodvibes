/**
 * control-plane-routes-hardening.test.ts
 *
 * Handler-level behaviour of the control-plane verbs that sit between an
 * operator surface and the daemon: what leaves on the wire, what a refusal
 * says, and what a retry cannot do twice. Every case drives the real handler
 * through an in-memory stub of its service.
 */
import { describe, expect, test } from 'bun:test';
import {
  createFleetArchivedListHandler,
  createFleetConflictsResolveHandler,
  createFleetListHandler,
  createFleetSnapshotHandler,
  type FleetConflictsDeps,
} from '../platform/src/platform/control-plane/routes/fleet.ts';
import {
  GatewayVerbError,
  readGatewayVerbRefusal,
  withholdCommittedResult,
} from '../platform/src/platform/control-plane/routes/gateway-verb-error.ts';
import { registerCiGatewayMethods } from '../platform/src/platform/control-plane/routes/ci.ts';
import { registerCheckinGatewayMethods } from '../platform/src/platform/control-plane/routes/checkin.ts';
import {
  createDevicesGrantsListHandler,
  createDevicesGrantsRevokeHandler,
} from '../platform/src/platform/control-plane/routes/devices.ts';
import { createCredentialDeleteHandler } from '../platform/src/platform/control-plane/routes/credentials-write.ts';
import {
  createApprovalRaiseHandler,
  readApprovalRaiseRequest,
} from '../platform/src/platform/control-plane/routes/approvals-raise.ts';
import { createCheckpointsRestoreHandler } from '../platform/src/platform/control-plane/routes/checkpoints.ts';
import { createHostedSessionCreateHandler } from '../platform/src/platform/control-plane/routes/hosted-sessions.ts';
import { createEmailExpectationOpenHandler } from '../platform/src/platform/control-plane/routes/email-expectations.ts';
import { ExpectationAuthorityError, ExpectationRefusalError } from '../platform/src/platform/google/verification-expectations.ts';
import { GatewayMethodCatalog } from '../platform/src/platform/control-plane/method-catalog.ts';
import type { GatewayMethodHandler, GatewayMethodInvocation } from '../platform/src/platform/control-plane/method-catalog-shared.ts';
import type { ProcessNode } from '../platform/src/platform/runtime/fleet/types.ts';

const context = { principalId: 'op-1', admin: true } as const;

function call(handler: GatewayMethodHandler, body: unknown = {}, extra: Partial<GatewayMethodInvocation> = {}): Promise<unknown> {
  return Promise.resolve(handler({ context, body, ...extra }));
}

async function refusal(run: () => Promise<unknown>): Promise<GatewayVerbError> {
  try {
    await run();
  } catch (error) {
    if (error instanceof GatewayVerbError) return error;
    throw error;
  }
  throw new Error('expected a GatewayVerbError');
}

// ── fleet ───────────────────────────────────────────────────────────────────

const SECRET_MARKER = 'sk-live-SECRET-MARKER';

function node(id: string, startedAt: number): ProcessNode {
  return {
    id,
    kind: 'background-process',
    state: 'executing-tool',
    label: id,
    startedAt,
    raw: { stdout: [`token=${SECRET_MARKER}`], cmd: `curl -H ${SECRET_MARKER}` },
  } as unknown as ProcessNode;
}

describe('fleet verbs keep the source record off the wire', () => {
  const registry = {
    query: () => ({ capturedAt: 1, nodes: [node('a', 2), node('b', 1)] }),
    listArchived: () => ({ capturedAt: 1, nodes: [node('c', 3)] }),
  };

  test('snapshot, list and archived.list carry no raw record', async () => {
    const snapshot = await call(createFleetSnapshotHandler(registry));
    const list = await call(createFleetListHandler(registry));
    const archived = await call(createFleetArchivedListHandler(registry));
    for (const body of [snapshot, list, archived]) {
      const text = JSON.stringify(body);
      expect(text).not.toContain(SECRET_MARKER);
      expect(text).not.toContain('"raw"');
    }
    expect((snapshot as { nodes: ProcessNode[] }).nodes.map((n) => n.id)).toEqual(['a', 'b']);
    expect((list as { items: ProcessNode[] }).items.map((n) => n.id)).toEqual(['a', 'b']);
  });

  test('the contract views and an agent\'s role stay, so a terminal attached to the daemon can still act on a conflicted unit', async () => {
    const unitRaw = { contract: { id: 'c1' }, unit: { id: 'u1', groupId: 'g1' } };
    const nodes = [
      { id: 'c1:u1', kind: 'contract-unit', state: 'idle', label: 'u', startedAt: 3, raw: unitRaw },
      { id: 'c1', kind: 'contract', state: 'idle', label: 'c', startedAt: 2, raw: { id: 'c1' } },
      { id: 'agent-1', kind: 'agent', state: 'idle', label: 'owner', startedAt: 1, raw: { contractRole: 'owner', prompt: SECRET_MARKER } },
      { id: 'proc-1', kind: 'background-process', state: 'idle', label: 'p', startedAt: 0, raw: { stdout: [SECRET_MARKER] } },
    ] as unknown as ProcessNode[];
    const snapshot = await call(createFleetSnapshotHandler({ query: () => ({ capturedAt: 1, nodes }) })) as { nodes: ProcessNode[] };
    const byId = new Map(snapshot.nodes.map((n) => [n.id, n]));
    expect(byId.get('c1:u1')?.raw).toEqual(unitRaw);
    expect(byId.get('c1')?.raw).toEqual({ id: 'c1' });
    expect(byId.get('agent-1')?.raw).toEqual({ contractRole: 'owner' });
    expect(byId.get('proc-1')?.raw).toBeUndefined();
    expect(JSON.stringify(snapshot)).not.toContain(SECRET_MARKER);
  });
});

describe('fleet.conflicts.resolve starts one resolution session per item', () => {
  function harness(options: { stamped?: string; live?: boolean } = {}): {
    deps: FleetConflictsDeps;
    starts: string[];
    release: () => void;
  } {
    const starts: string[] = [];
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const deps: FleetConflictsDeps = {
      listWorkstreams: () => [{
        id: 'ws-1',
        items: [{
          id: 'item-1', title: 'payments', mergeState: 'conflict', worktreePath: '/kept',
          conflictFiles: ['a.ts'], ...(options.stamped ? { conflictSessionId: options.stamped } : {}),
        }],
      }],
      stampConflictSession: () => true,
      ...(options.live === undefined ? {} : { isSessionLive: () => options.live === true }),
      startResolutionSession: async () => {
        starts.push('start');
        await gate;
        return { sessionId: `sess-${String(starts.length)}` };
      },
    };
    return { deps, starts, release };
  }

  test('a second call while the first is starting is refused and starts nothing', async () => {
    const h = harness();
    const handler = createFleetConflictsResolveHandler(h.deps);
    const first = call(handler, { itemId: 'item-1' });
    const second = await refusal(() => call(handler, { itemId: 'item-1' }));
    expect(second.status).toBe(409);
    expect(second.message).toContain('already starting');
    h.release();
    await first;
    expect(h.starts).toHaveLength(1);
  });

  test('the guard is released afterwards, so a failed start can be retried', async () => {
    let attempt = 0;
    const h = harness();
    const deps: FleetConflictsDeps = {
      ...h.deps,
      startResolutionSession: async () => (++attempt === 1 ? { error: 'agent pool full' } : { sessionId: 'sess-2' }),
    };
    const handler = createFleetConflictsResolveHandler(deps);
    expect((await refusal(() => call(handler, { itemId: 'item-1' }))).message).toContain('agent pool full');
    expect(await call(handler, { itemId: 'item-1' })).toMatchObject({ sessionId: 'sess-2' });
  });

  test('an item whose stamped session is still live is refused with that session id', async () => {
    const h = harness({ stamped: 'sess-live', live: true });
    const error = await refusal(() => call(createFleetConflictsResolveHandler(h.deps), { itemId: 'item-1' }));
    expect(error.status).toBe(409);
    expect(error.message).toContain('sess-live');
    expect(h.starts).toHaveLength(0);
  });

  test('a stamped session that is no longer live can be replaced', async () => {
    const h = harness({ stamped: 'sess-dead', live: false });
    h.release();
    expect(await call(createFleetConflictsResolveHandler(h.deps), { itemId: 'item-1' })).toMatchObject({ sessionId: 'sess-1' });
  });
});

// ── gateway-verb-error ──────────────────────────────────────────────────────

describe('which thrown objects count as wire refusals', () => {
  test('an upstream provider error with a lower-case code stays a server fault', () => {
    const upstream = Object.assign(new Error('Incorrect API key provided: sk-abc'), { status: 401, code: 'invalid_api_key' });
    expect(readGatewayVerbRefusal(upstream)).toBeNull();
  });

  test('a platform-spelled code with an error status is still a refusal', () => {
    const own = Object.assign(new Error('needs confirm'), { status: 403, code: 'REQUIRE_CONFIRM' });
    expect(readGatewayVerbRefusal(own)).toMatchObject({ status: 403, code: 'REQUIRE_CONFIRM' });
  });

  test('a refusal raised after the effect says the effect happened and keeps its status and code', () => {
    let caught: unknown;
    try {
      withholdCommittedResult(new GatewayVerbError('requires current owner access', 'FORBIDDEN', 403), 'The submission was recorded.');
    } catch (error) { caught = error; }
    expect(caught).toBeInstanceOf(GatewayVerbError);
    const error = caught as GatewayVerbError;
    expect(error.status).toBe(403);
    expect(error.code).toBe('FORBIDDEN');
    expect(error.message).toContain('The submission was recorded.');
    expect(error.message).toContain('requires current owner access');
  });

  test('anything that is not a refusal passes through unchanged', () => {
    const boom = new Error('boom');
    expect(() => withholdCommittedResult(boom, 'x')).toThrow(boom);
  });
});

// ── ci and checkin query-string numbers ─────────────────────────────────────

describe('numbers that arrive as query text are read, not dropped', () => {
  test('ci.status reads prNumber "12" as 12 and refuses one that is not a number', async () => {
    const seen: unknown[] = [];
    const catalog = new GatewayMethodCatalog();
    registerCiGatewayMethods(catalog, {
      status: async (input: unknown) => { seen.push(input); return {} as never; },
      listWatches: async () => [],
      createWatch: async () => ({}) as never,
      deleteWatch: async () => true,
      checkWatch: async () => ({}) as never,
    } as never);
    await catalog.invoke('ci.status', { context, query: { repo: 'o/r', prNumber: '12' } });
    expect(seen).toEqual([{ repo: 'o/r', prNumber: 12 }]);
    const bad = await refusal(() => catalog.invoke('ci.status', { context, query: { repo: 'o/r', prNumber: 'twelve' } }) as Promise<unknown>);
    expect(bad.status).toBe(400);
    expect(bad.field).toBe('prNumber');
  });

  test('checkin.receipts.list honours ?limit=2 from the GET binding', async () => {
    const asked: Array<number | undefined> = [];
    const catalog = new GatewayMethodCatalog();
    registerCheckinGatewayMethods(catalog, {
      getConfig: () => ({}) as never,
      setConfig: async () => ({}) as never,
      listReceipts: async (limit?: number) => { asked.push(limit); return []; },
      evaluate: async () => ({}) as never,
    } as never);
    await catalog.invoke('checkin.receipts.list', { context, query: { limit: '2' } });
    expect(asked).toEqual([2]);
  });
});

// ── devices ─────────────────────────────────────────────────────────────────

describe('devices grants', () => {
  function service() {
    const revokes: unknown[] = [];
    return {
      revokes,
      grants: {
        list: async () => [],
        listAudit: async () => [
          { id: 'a1', action: 'grant', grantId: 'g1', nodeId: 'phone-1', capabilityId: 'camera.capture', at: 1, actor: 'op' },
          { id: 'a2', action: 'grant', grantId: 'g2', nodeId: 'tablet-1', capabilityId: 'camera.capture', at: 2, actor: 'op' },
        ],
        revoke: async (input: unknown) => { revokes.push(input); return []; },
      },
    };
  }

  test('an unknown capabilityId is refused and revokes nothing', async () => {
    const svc = service();
    const error = await refusal(() => call(createDevicesGrantsRevokeHandler(svc as never), { nodeId: 'phone-1', capabilityId: 'camera.captur' }));
    expect(error.status).toBe(400);
    expect(error.field).toBe('capabilityId');
    expect(svc.revokes).toHaveLength(0);
  });

  test('the revoke is recorded under the calling principal', async () => {
    const svc = service();
    await call(createDevicesGrantsRevokeHandler(svc as never), { grantId: 'g1' });
    expect(svc.revokes).toEqual([{ grantId: 'g1', actor: 'op-1' }]);
  });

  test('the audit trail is filtered by nodeId like the grants are', async () => {
    const result = await call(createDevicesGrantsListHandler(service() as never), { nodeId: 'phone-1' }) as { audit: Array<{ nodeId: string }> };
    expect(result.audit.map((entry) => entry.nodeId)).toEqual(['phone-1']);
  });
});

// ── credentials ─────────────────────────────────────────────────────────────

describe('credentials.delete', () => {
  const baseDeps = (secrets: { get(key: string): Promise<string | null>; delete(key: string): Promise<void> }, audit: unknown[]) => ({
    secrets,
    config: { get: () => '', setDynamic: () => {}, getRaw: () => undefined },
    additionalSecretKeys: ['provider.openai.apiKey'],
    audit: (entry: unknown) => { audit.push(entry); },
  });

  test('a store failure is a 503 and is audited as refused', async () => {
    const audit: Array<{ outcome: string }> = [];
    const deps = baseDeps({ get: async () => 'stored', delete: async () => { throw new Error('keyring locked'); } }, audit);
    const error = await refusal(() => call(createCredentialDeleteHandler(deps as never), { key: 'provider.openai.apiKey' }));
    expect(error.status).toBe(503);
    expect(audit.map((entry) => entry.outcome)).toEqual(['refused']);
  });

  test('a store that cannot be read before the delete is a 503 and is audited as refused', async () => {
    const audit: Array<{ outcome: string }> = [];
    const deps = baseDeps({ get: async () => { throw new Error('keyring locked'); }, delete: async () => {} }, audit);
    const error = await refusal(() => call(createCredentialDeleteHandler(deps as never), { key: 'provider.openai.apiKey' }));
    expect(error.status).toBe(503);
    expect(audit.map((entry) => entry.outcome)).toEqual(['refused']);
  });

  test('deleting what was never stored succeeds and is audited as absent, not refused', async () => {
    const audit: Array<{ outcome: string }> = [];
    const deps = baseDeps({ get: async () => null, delete: async () => {} }, audit);
    const result = await call(createCredentialDeleteHandler(deps as never), { key: 'provider.openai.apiKey' }) as { cleared: boolean };
    expect(result.cleared).toBe(false);
    expect(audit.map((entry) => entry.outcome)).toEqual(['absent']);
  });
});

// ── approvals.raise ─────────────────────────────────────────────────────────

const VALID_ASK = {
  callId: 'c1',
  tool: 'exec',
  args: { cmd: 'ls' },
  category: 'execute',
  analysis: { riskLevel: 'low', reasons: [], classification: 'read', summary: 'list files' },
};

describe('approvals.raise', () => {
  test('only the fields of a permission ask are stored', () => {
    const request = readApprovalRaiseRequest({ ...VALID_ASK, isAdmin: true, injected: '<script>' });
    expect(Object.keys(request).sort()).toEqual(['analysis', 'args', 'callId', 'category', 'tool']);
  });

  test('a decision that rejects does not fail the call; the record says where the ask stands', async () => {
    const approval = { id: 'ap-1', status: 'pending' };
    const broker = {
      raiseApproval: async () => ({ approval, coalesced: false, decision: Promise.reject(new Error('store closed')) }),
      getApproval: () => approval,
    };
    const result = await call(createApprovalRaiseHandler(broker as never), { request: VALID_ASK, waitMs: 1000 }) as { decided: boolean };
    expect(result.decided).toBe(false);
  });

  test('a caller that disconnects stops waiting without a decision', async () => {
    const controller = new AbortController();
    const approval = { id: 'ap-1', status: 'pending' };
    const broker = {
      raiseApproval: async () => ({ approval, coalesced: false, decision: new Promise<never>(() => {}) }),
      getApproval: () => approval,
    };
    const pending = call(createApprovalRaiseHandler(broker as never), { request: VALID_ASK, waitMs: 60_000 }, { signal: controller.signal });
    controller.abort();
    expect(await pending).toMatchObject({ decided: false });
  });
});

// ── checkpoints ─────────────────────────────────────────────────────────────

describe('checkpoints.restore with a confirmToken', () => {
  test('safetyCheckpoint:false is refused before the token is spent', async () => {
    const consumed: string[] = [];
    const restores: unknown[] = [];
    const handler = createCheckpointsRestoreHandler(
      { restore: async (...args: unknown[]) => { restores.push(args); return {}; } } as never,
      { consume: (token: string) => { consumed.push(token); return true; } } as never,
    );
    const error = await refusal(() => call(handler, { id: 'cp-1', confirmToken: 't1', safetyCheckpoint: false }));
    expect(error.status).toBe(400);
    expect(error.field).toBe('safetyCheckpoint');
    expect(consumed).toEqual([]);
    expect(restores).toEqual([]);
  });

  test('an empty paths list is a 400 before the token is spent and before any restore', async () => {
    const consumed: string[] = [];
    const restores: unknown[] = [];
    const handler = createCheckpointsRestoreHandler(
      { restore: async (...args: unknown[]) => { restores.push(args); return {}; } } as never,
      { consume: (token: string) => { consumed.push(token); return true; } } as never,
    );
    for (const body of [{ id: 'cp-1', confirmToken: 't1', paths: [] }, { id: 'cp-1', confirm: true, paths: [] }]) {
      const error = await refusal(() => call(handler, body));
      expect(error.status).toBe(400);
      expect(error.field).toBe('paths');
    }
    expect(consumed).toEqual([]);
    expect(restores).toEqual([]);
  });
});

// ── hosted sessions ─────────────────────────────────────────────────────────

describe('sessions.hosted.create originSurface', () => {
  test('an invented or path-shaped surface is refused before the session exists', async () => {
    let created = 0;
    const handler = createHostedSessionCreateHandler({ create: async () => { created += 1; return {}; } } as never);
    for (const originSurface of ['nonsense', '../x', 'a/b']) {
      const error = await refusal(() => call(handler, { workspaceRoot: '/w', originSurface }));
      expect(error.status).toBe(400);
      expect(error.field).toBe('originSurface');
    }
    expect(created).toBe(0);
  });

  test('a known surface is passed through', async () => {
    const seen: unknown[] = [];
    const handler = createHostedSessionCreateHandler({ create: async (input: unknown) => { seen.push(input); return {}; } } as never);
    await call(handler, { workspaceRoot: '/w', originSurface: 'agent' });
    expect(seen).toMatchObject([{ originSurface: 'agent' }]);
  });
});

// ── email expectations ──────────────────────────────────────────────────────

describe('email.expectation.open separates a bad request from a daemon fault', () => {
  const body = { serviceDomain: 'example.com', recipientAddress: 'a@b.co', purpose: 'signup' };

  test('a store write failure is not reported as the caller\'s fault', async () => {
    const disk = Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' });
    const handler = createEmailExpectationOpenHandler({ open: async () => { throw disk; } } as never);
    let caught: unknown;
    try { await call(handler, body); } catch (error) { caught = error; }
    expect(caught).toBe(disk);
    expect(caught).not.toBeInstanceOf(GatewayVerbError);
  });

  test('an internal programming error is not reported as a 400', async () => {
    const handler = createEmailExpectationOpenHandler({ open: async () => { throw new TypeError('x is undefined'); } } as never);
    await expect(call(handler, body)).rejects.toBeInstanceOf(TypeError);
  });

  test('the command-authority refusal is a 409 by its type, not by its wording', async () => {
    const handler = createEmailExpectationOpenHandler({ open: async () => { throw new ExpectationAuthorityError('Mail may now command.'); } } as never);
    const error = await refusal(() => call(handler, body));
    expect(error.status).toBe(409);
  });

  test('a plain Error, such as a failed persist, is the daemon\'s own fault and is not reported as a 400', async () => {
    const handler = createEmailExpectationOpenHandler({ open: async () => { throw new Error('rename failed while saving the expectation book'); } } as never);
    await expect(call(handler, body)).rejects.not.toBeInstanceOf(GatewayVerbError);
  });

  test('the book\'s own refusal is still a 400 carrying its wording', async () => {
    const handler = createEmailExpectationOpenHandler({ open: async () => { throw new ExpectationRefusalError('Too many open verification expectations (limit 8).'); } } as never);
    const error = await refusal(() => call(handler, body));
    expect(error.status).toBe(400);
    expect(error.message).toContain('Too many open');
  });
});

// ── profile mutation lifetime ───────────────────────────────────────────────

describe('a profile mutation needs a live authorization answer', () => {
  test('an invocation with no authorization hook is not treated as authorized', async () => {
    const { profileMutationOptions } = await import('../platform/src/platform/control-plane/routes/native-profile-mutation.ts');
    const options = profileMutationOptions({ context, body: {} }, ['write:profile']);
    expect(() => options.assertCurrent?.()).toThrow(/no longer authorized/);
  });

  test('one that answers yes is current, and one that answers no is not', async () => {
    const { profileMutationOptions } = await import('../platform/src/platform/control-plane/routes/native-profile-mutation.ts');
    expect(() => profileMutationOptions({ context, body: {}, isAuthorized: () => true }, ['write:profile']).assertCurrent?.()).not.toThrow();
    expect(() => profileMutationOptions({ context, body: {}, isAuthorized: () => false }, ['write:profile']).assertCurrent?.()).toThrow(/no longer authorized/);
  });
});
