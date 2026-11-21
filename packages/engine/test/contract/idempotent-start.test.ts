// Proves: A retried contract start (a lost reply, a restart) starts a second contract, so the work is done and paid for twice.
// Red when: The idempotency record is not consulted or not durable, a reused key with a different request is accepted, or one caller's key answers another caller.
import { afterEach, expect, test } from 'bun:test';
import { rmSync } from 'node:fs';
import { RefusalError } from '@goodvibes/engine/errors';
import { makeHarness, makeRepo, oneUnitPlan, type Harness } from './runner-support.js';
import { createContractOperatorService } from '../../platform/src/platform/contract/operator-service.ts';
import { createHostedContractWorkAdapter, type HostedContractWorkAdapterDeps } from '../../platform/src/platform/hosted-sessions/contract-work-adapter.ts';

const roots: string[] = [];
const harnesses: Harness[] = [];
afterEach(async () => {
  for (const h of harnesses.splice(0)) {
    const ids = h.runner.list({ includeTerminal: true }).map((row) => row.id);
    await Promise.resolve(h.dispose()).catch(() => undefined);
    await Promise.all(ids.map((id) => h.runner.join(id).catch(() => undefined)));
  }
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function harness(root: string): Harness {
  // One contract runs at a time (the setting's floor) and its unit never finishes, so each start stays where it was put.
  const value = makeHarness({ root, contract: { maxActiveContracts: 1 }, plan: oneUnitPlan(), scripts: { u1: () => [{ text: '', stop: { kind: 'hang' } }] } });
  harnesses.push(value);
  return value;
}

const input = (projectRoot: string, ask = 'Keep the original requested work') =>
  ({ ask, sessionId: 'retry-session', origin: 'external' as const, projectRoot, isolation: 'shared' as const });

test('a retried start with the same caller and key returns the first contract, also after a restart, and starts no second one', async () => {
  const root = makeRepo(); roots.push(root);
  const first = harness(root);
  const started = await first.runner.startIdempotent!(input(root), { principalId: 'p1', key: 'k1' });
  expect(started.replayed).toBe(false);
  const retry = await first.runner.startIdempotent!(input(root), { principalId: 'p1', key: 'k1' });
  expect(retry).toMatchObject({ replayed: true, ownerAgentId: started.ownerAgentId });
  expect(retry.contract.id).toBe(started.contract.id);
  expect(first.runner.list({ includeTerminal: true })).toHaveLength(1);

  let refused: unknown;
  try { await first.runner.startIdempotent!(input(root, 'A different request'), { principalId: 'p1', key: 'k1' }); }
  catch (error) { refused = error; }
  expect(refused).toBeInstanceOf(RefusalError);
  expect((refused as RefusalError).refusal).toMatchObject({ code: 'IDEMPOTENCY_KEY_REUSED', status: 409 });

  const other = await first.runner.startIdempotent!(input(root), { principalId: 'p2', key: 'k1' });
  expect(other.replayed).toBe(false);
  expect(other.contract.id).not.toBe(started.contract.id);

  await first.dispose();
  const restarted = harness(root);
  const afterRestart = await restarted.runner.startIdempotent!(input(root), { principalId: 'p1', key: 'k1' });
  expect(afterRestart.replayed).toBe(true);
  expect(afterRestart.contract.id).toBe(started.contract.id);
});

/**
 * contracts.dispatch goes through its own adapter, which makes a hosted session
 * and starts the contract there; the key reaches the durable record only if the
 * adapter and the operator service pass it on. The session manager is a stand-in
 * that only names sessions: the key's record is the runner's store, which is real.
 */
test('a retried dispatch with the same caller and key after a restart returns the first contract and starts no second one', async () => {
  const root = makeRepo(); roots.push(root);
  const created: string[] = [];
  const hostedSessions = {
    create: async () => { const id = `dispatch-session-${created.length + 1}`; created.push(id); return { id }; },
    hosts: () => true,
    kill: async () => undefined,
  } as unknown as HostedContractWorkAdapterDeps['hostedSessions'];
  const daemon = (h: Harness) => {
    const service = createContractOperatorService({ runner: h.runner, workingDirectory: root });
    const adapter = createHostedContractWorkAdapter({ runner: service, hostedSessions, workspaceRoot: root });
    return { service, adapter };
  };
  const ask = { ask: 'Keep the original requested work', workspaceRoot: root, principalId: 'p1', idempotencyKey: 'k1' };

  const first = harness(root);
  const before = daemon(first);
  const started = await before.service.dispatch(ask);
  before.adapter.close();
  await first.dispose();

  const restarted = harness(root);
  // As the daemon does at start: contracts left on disk are taken up again.
  await restarted.runner.resumeAll();
  const after = daemon(restarted);
  const retried = await after.service.dispatch(ask);
  after.adapter.close();
  expect(retried.contract.id).toBe(started.contract.id);
  expect(created).toEqual(['dispatch-session-1']);
});
