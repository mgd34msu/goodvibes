import { afterEach, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createNativeHostedTurnHost, NATIVE_HOSTED_TURN_SCOPES } from '../platform/src/platform/hosted-sessions/native-turn-host.ts';
import type { NativeHostedTurnLookup, NativeHostedTurnSnapshot } from '../platform/src/platform/hosted-sessions/native-turn-wire.ts';
import type { NativeConversationTurnSource } from '../platform/src/platform/workflow/work-ledger/native-intake-client.ts';
import type { NativePairedExecutionAuthority, NativePairedExecutionSnapshot } from '../platform/src/platform/workflow/work-ledger/native-execution.ts';

const cleanups: (() => void)[] = [];
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup(); });

type BrokerInput = { id: string; body: string; correlationId: string; state: string; metadata: Record<string, unknown> };

/** The host over in-memory stand-ins for the broker and the session manager; only the journal is real. */
function world() {
  const root = mkdtempSync(join(tmpdir(), 'native-settlement-'));
  const workspace = join(root, 'workspace'); mkdirSync(workspace);
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const projectId = `project-${randomUUID()}`, inputId = randomUUID();
  const source: NativeConversationTurnSource = { kind: 'turn', projectId, requestId: `request-${inputId}`,
    sourceRef: { version: 1, inputId, sourceId: `source-${inputId}`, sourceRevision: 'revision-1', sessionId: 'native-source-session' },
    route: 'answer', text: 'hello' };
  const snapshot: NativePairedExecutionSnapshot = { kind: 'pairing-token', principalId: 'principal', authorityId: 'principal', tokenId: 'token', authorityRevision: 'token', scopes: [...NATIVE_HOSTED_TURN_SCOPES] };
  const live = { revision: 'token' };
  const current = (): NativePairedExecutionSnapshot => ({ ...snapshot, authorityRevision: live.revision });
  const authority: NativePairedExecutionAuthority = {
    current,
    async withCurrent(_expected, callback) { return callback(current); },
  };
  const session = { id: 'hosted-1', originSurface: 'webui', workspaceRoot: workspace, status: 'idle' };
  const inputs: BrokerInput[] = [];
  const brokerCalls = { settleFailures: 0, afterReserve: (): void => {} };
  const broker = {
    async reserveNativeTurnInput() {
      const input: BrokerInput = { id: 'sin-1', body: source.text, correlationId: 'session-input:sin-1', state: 'delivered', metadata: {} };
      inputs.push(input);
      brokerCalls.afterReserve();
      return structuredClone(input);
    },
    getInputsSince: () => structuredClone(inputs),
    async settleNativeTurnInput(_session: string, id: string, _permit: unknown, state: 'completed' | 'cancelled' | 'failed') {
      if (brokerCalls.settleFailures > 0) { brokerCalls.settleFailures--; throw new Error('Synthetic durable settle failure'); }
      const input = inputs.find(item => item.id === id)!;
      input.state = state;
      return structuredClone(input);
    },
  };
  const manager = {
    create: async () => session,
    get: () => session,
    deliverNative: async () => {},
    cancelNative: () => false,
    kill: async () => {},
    captureNativeContinuation: async () => { throw new Error('unused'); },
    assertNativeContinuation: () => {},
    waitForNativeAvailability: async () => {},
  };
  const host = createNativeHostedTurnHost({ projectId, projectRoot: workspace, journalPath: join(root, 'journal.json'),
    intake: { get: async () => structuredClone(source), admit: async () => structuredClone(source) },
    manager: manager as never, broker: broker as never });
  cleanups.push(() => { void host.close(); });
  const request = { projectId, inputId, sourceRevision: source.sourceRef.sourceRevision };
  const access = { isAuthorized: () => true };
  const snap = (value: NativeHostedTurnLookup): NativeHostedTurnSnapshot => {
    if ('kind' in value) throw new Error('Expected a native hosted turn');
    return value;
  };
  return { host, request, authority, access, inputs, brokerCalls, snap, live,
    async settled() {
      for (let attempt = 0; attempt < 1_000; attempt++) {
        const value = snap(await host.status(request, authority, access));
        if (['completed', 'cancelled', 'recovery-required'].includes(value.state)) return value;
        await new Promise(resolve => setImmediate(resolve));
      }
      throw new Error('The turn never settled');
    } };
}

test('a turn whose broker settlement failed twice can be cancelled once settling works again', async () => {
  const w = world();
  w.brokerCalls.settleFailures = 2;
  w.snap(await w.host.start(w.request, w.authority, w.access));
  expect((await w.settled()).state).toBe('recovery-required');
  expect(w.inputs[0]!.state).toBe('delivered');
  const cancelled = w.snap(await w.host.cancel(w.request, w.authority, w.access));
  expect(cancelled.state).toBe('cancelled');
  expect(w.inputs[0]!.state).toBe('cancelled');
});

test('cancel stays recovery-required while the settlement keeps failing', async () => {
  const w = world();
  w.brokerCalls.settleFailures = 3;
  w.snap(await w.host.start(w.request, w.authority, w.access));
  expect((await w.settled()).state).toBe('recovery-required');
  expect(w.snap(await w.host.cancel(w.request, w.authority, w.access)).state).toBe('recovery-required');
  expect(w.inputs[0]!.state).toBe('delivered');
  expect(w.snap(await w.host.cancel(w.request, w.authority, w.access)).state).toBe('cancelled');
});

test('a preparation that failed after reserving the input can be cancelled once settling works again', async () => {
  const w = world();
  // The pairing moves right after the reservation, so preparation fails before any turn is dispatched,
  // and the broker cannot settle the reservation while the failure is handled.
  w.brokerCalls.afterReserve = () => { w.live.revision = 'rotated'; w.brokerCalls.settleFailures = 1; };
  await expect(w.host.start(w.request, w.authority, w.access)).rejects.toThrow();
  expect(w.inputs[0]!.state).toBe('delivered');
  w.live.revision = 'token';
  const cancelled = w.snap(await w.host.cancel(w.request, w.authority, w.access));
  expect(cancelled.state).toBe('cancelled');
  expect(w.inputs[0]!.state).toBe('cancelled');
});
