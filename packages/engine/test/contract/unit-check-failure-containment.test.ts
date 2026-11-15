/**
 * A unit check that throws outside its judgment block must fail the contract
 * with a reason and release the agent's hold, instead of becoming an unhandled
 * rejection with the agent waiting on a hold nobody resolves; a check that is
 * aborted mid-evidence frees the unit's check slot so later mid-run checks run.
 */
import { afterEach, expect, spyOn, test } from 'bun:test';
import { configReader } from './plan-support.js';
import { createUnitCheckLoop, type UnitCheckLoopDeps } from '../../platform/src/platform/contract/agent-hooks.js';
import { readContractConfig } from '../../platform/src/platform/contract/config.js';
import { ContractRun, type RunEnv } from '../../platform/src/platform/contract/run-context.js';
import type { ContractFailureKind } from '../../platform/src/platform/contract/types.js';
import type { AgentRecord } from '../../platform/src/platform/tools/agent/index.js';
import { logger } from '../../platform/src/platform/utils/logger.js';
import { makeContract, makeGroup, makeUnit } from './fixtures.js';

const undo: Array<() => void> = [];
afterEach(() => { for (const restore of undo.splice(0)) restore(); });

function quiet(): void {
  for (const level of ['info', 'warn', 'error'] as const) {
    const spy = spyOn(logger, level).mockImplementation(() => {});
    undo.push(() => spy.mockRestore());
  }
}

function fixture(options: { config?: RunEnv['config']; failContract?: (run: ContractRun, kind: ContractFailureKind, reason: string) => void; readOwnerEvidence?: UnitCheckLoopDeps['readOwnerEvidence'] } = {}) {
  quiet();
  const unit = makeUnit({ id: 'u1', groupId: 'g1', role: 'research', status: 'running', activeAgentId: 'agent-1' });
  const contract = makeContract({ units: [unit], groups: [makeGroup({ id: 'g1', unitIds: ['u1'], status: 'running' })] });
  const unexpected = (): never => { throw new Error('unexpected control call'); };
  const run = new ContractRun(contract, { now: () => 1_000, config: options.config ?? (() => readContractConfig(configReader())), emit: () => {}, touchAgent: () => {} },
    { passGroup: unexpected, finishPassed: unexpected, fail: unexpected, cancel: unexpected });
  const failures: Array<{ kind: ContractFailureKind; reason: string }> = [];
  const noop = (): void => {};
  const deps = {
    ...(options.readOwnerEvidence === undefined ? {} : { readOwnerEvidence: options.readOwnerEvidence }),
    findRun: (id: string) => (id === run.id ? run : undefined),
    agentManager: { getStatus: () => null, wakeWithSteer: () => ({ woke: false, reason: 'unused' }) },
    messageBus: { send: unexpected },
    configManager: configReader(),
    runtimeBus: {},
    watchdog: { touch: noop },
    escalations: { unitStalled: async () => {}, unitAwaitsOwner: async () => {} },
    failContract: options.failContract ?? ((target: ContractRun, kind: ContractFailureKind, reason: string) => {
      failures.push({ kind, reason });
      target.endOpenUnits('cancelled', reason);
    }),
    unitPassed: unexpected,
    respawnUnit: unexpected,
    sessionUnit: () => null,
  } as unknown as UnitCheckLoopDeps;
  const loop = createUnitCheckLoop(deps);
  const record = { id: 'agent-1', contractId: contract.id, contractUnitId: 'u1' } as unknown as AgentRecord;
  return { run, unit, loop, record, failures };
}

test('a check that throws fails the contract with the reason and the held agent is released', async () => {
  const f = fixture({ config: () => { throw new Error('configuration became unreadable'); } });
  const outcome = await f.loop.hooks.holdCompletion(f.record);
  expect(outcome).toEqual({ kind: 'release' });
  expect(f.failures).toHaveLength(1);
  expect(f.failures[0]!.reason).toContain('the check of unit u1 stopped unexpectedly');
  expect(f.run.runtime(f.unit).hold).toBeNull();
});

test('runCheck never rejects, so a detached caller cannot raise an unhandled rejection', async () => {
  const f = fixture({ config: () => { throw new Error('configuration became unreadable'); } });
  f.unit.status = 'held';
  await expect(f.loop.runCheck(f.run, f.unit, 'completion')).resolves.toBeUndefined();
  expect(f.failures).toHaveLength(1);
});

test('the hold is released even when failing the contract itself throws', async () => {
  const f = fixture({
    config: () => { throw new Error('configuration became unreadable'); },
    failContract: () => { throw new Error('contract already past failing'); },
  });
  const outcome = await f.loop.hooks.holdCompletion(f.record);
  expect(outcome).toEqual({ kind: 'release' });
});

test('a check that stopped because the unit was aborted mid-evidence frees the check slot', async () => {
  const f = fixture({ readOwnerEvidence: () => { f.run.runtime(f.unit).abort.abort(); return undefined; } });
  const runtime = f.run.runtime(f.unit);
  await f.loop.runCheck(f.run, f.unit, 'turn-end');
  expect(runtime.check).toBeNull();
  expect(f.failures).toEqual([]);
});
