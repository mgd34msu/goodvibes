/** Contracts and deterministic progress for the checkpoint proofs (checkpoint-progress.test.ts and its child process). */
import { randomUUID } from 'node:crypto';
import { CONTRACT_INPUT_EXCLUSIONS, type ContractInputSnapshot } from '../../platform/src/platform/contract/input-snapshot.js';
import type { Contract, UnitCheck } from '../../platform/src/platform/contract/types.js';
import { makeContract, makeCriterion, makeGroup, makeUnit } from './fixtures.js';

/** A version-2 input receipt listing `files` files: the per-file manifest a save must not write again. */
export function manifest(files: number): ContractInputSnapshot {
  return {
    version: 2, id: randomUUID(), sourceRoot: '/work/project', sourceIdentity: '1:2', gitIdentity: 'git:1', ownerHead: 'a'.repeat(40),
    ownerRef: 'refs/heads/main', indexFingerprint: 'b'.repeat(64), inputTree: 'c'.repeat(40), inputCommit: 'd'.repeat(40), capturedAt: 1,
    dirty: false, exclusions: [...CONTRACT_INPUT_EXCLUSIONS],
    files: Array.from({ length: files }, (_, index) => ({
      path: `src/module-${index}/file-${index}.ts`, kind: 'file' as const, mode: '100644' as const,
      oid: index.toString(16).padStart(64, '0'), identity: `1:${index}:33188:100:1:1`,
    })),
  };
}

/** A running contract with `units` pending units in one group and a captured input of `files` files. */
export function progressContract(units: number, files: number): Contract {
  const planned = Array.from({ length: units }, (_, index) => makeUnit({
    id: `u${index + 1}`, criteria: [makeCriterion({ id: `u${index + 1}.c1`, origin: 'derived', serves: ['c1'], quote: undefined })],
  }));
  return makeContract({ units: planned, groups: [makeGroup({ unitIds: planned.map(unit => unit.id) })], inputSnapshot: manifest(files) });
}

export function passingCheck(id: string, at: number): UnitCheck {
  return {
    id, at, trigger: 'turn-end', goal: { probabilityUnmet: 0.05, verdict: 'met', outcome: 'act' },
    quality: {}, result: 'pass', decisionIds: [],
  };
}

/**
 * Save `step` of a run: the next unit in turn gets an agent and is running,
 * or passes with a check; a decision is appended; usage moves. The same steps
 * from the same start always give the same contract.
 */
export function progressStep(contract: Contract, step: number): void {
  const unit = contract.units[(step - 1) % contract.units.length]!;
  if (step % 3 === 0) {
    unit.checks.push(passingCheck(`${unit.id}.k${unit.checks.length + 1}`, step));
    unit.status = 'passed';
    unit.activeAgentId = undefined;
    unit.answer = `done at step ${step}`;
  } else {
    unit.status = 'running';
    unit.agentIds.push(`agent-${step}`);
    unit.activeAgentId = `agent-${step}`;
    unit.touchedPaths.push(`src/file-${step}.ts`);
  }
  contract.decisions.push({ id: `d${step}`, at: step, action: step % 3 === 0 ? 'checked' : 'spawned', targetId: unit.id, reason: `step ${step}`, decisionIds: [] });
  contract.usage = { ...contract.usage, inputTokens: contract.usage.inputTokens + step, llmCallCount: step };
  contract.statusLine = `step ${step}`;
}
