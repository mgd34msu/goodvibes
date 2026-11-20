/**
 * Contracts and deterministic progress for contract-progress-restart.test.ts
 * and its second process (contract-progress-child.ts). A contract is built in the shape the runner
 * saves; `progressStep` advances it the way a run does.
 */
import { randomUUID } from 'node:crypto';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { CONTRACT_INPUT_EXCLUSIONS, type ContractInputSnapshot } from '../platform/src/platform/contract/input-snapshot.js';
import {
  CURRENT_CONTRACT_SCHEMA_VERSION,
  newContractId,
  type Contract,
  type ContractGroup,
  type ContractUnit,
  type Criterion,
  type UnitCheck,
} from '../platform/src/platform/contract/index.js';
import { emptyWorkItemUsage } from '../platform/src/platform/orchestration/types.js';
import { ContractStore, contractCheckpointDir, serializeContract } from '../platform/src/platform/contract/store.js';

function criterion(overrides: Partial<Criterion> & Pick<Criterion, 'id'>): Criterion {
  return {
    text: 'The parser accepts every documented input form', origin: 'stated', quote: 'accept every documented input form',
    serves: [], disposition: 'judged', status: 'unread', readings: [], ...overrides,
  };
}

function unit(id: string): ContractUnit {
  return {
    id, groupId: 'g1', title: `Unit ${id}`, goal: 'Parse every documented input form', brief: 'Write src/parser.ts and its tests.',
    role: 'implement', dependsOn: [], files: ['src/parser.ts'], attempts: 1,
    criteria: [criterion({ id: `${id}.c1`, origin: 'derived', serves: ['c1'], quote: undefined })],
    status: 'pending', agentIds: [], checks: [], nudges: [], fixRounds: 0, freshAgents: 0, transportRetries: 0, touchedPaths: [],
    usage: emptyWorkItemUsage(),
  };
}

function group(unitIds: string[]): ContractGroup {
  return {
    id: 'g1', title: 'Parsing', goal: 'The parser works', kind: 'work', dependsOn: [], criteria: [], unitIds, status: 'running',
    checks: [], fixRounds: 0, usage: emptyWorkItemUsage(),
  };
}

/** A version-2 input receipt listing `files` files: the per-file manifest every save must keep. */
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
  const planned = Array.from({ length: units }, (_, index) => unit(`u${index + 1}`));
  return {
    id: newContractId(), schemaVersion: CURRENT_CONTRACT_SCHEMA_VERSION, sessionId: 'session-1', origin: 'cli',
    ask: 'Add a parser that can accept every documented input form.', ownerAgentId: 'agent-owner', projectRoot: '/work/project',
    isolation: 'shared', goal: 'A parser for every documented input form', criteria: [criterion({ id: 'c1' })],
    groups: [group(planned.map((entry) => entry.id))], units: planned, status: 'running', checks: [], fixRounds: 0, escalations: [],
    decisions: [], usage: emptyWorkItemUsage(), judgmentUsage: { calls: 0, inputTokens: 0, outputTokens: 0 }, plannerAgentIds: [],
    createdAt: 1_000, inputSnapshot: manifest(files),
  };
}

function passingCheck(id: string, at: number): UnitCheck {
  return { id, at, trigger: 'turn-end', goal: { probabilityUnmet: 0.05, verdict: 'met', outcome: 'act' }, quality: {}, result: 'pass', decisionIds: [] };
}

/**
 * Save `step` of a run: the next unit in turn gets an agent and is running,
 * or passes with a check; a decision is appended; usage moves. The same steps
 * from the same start always give the same contract.
 */
export function progressStep(contract: Contract, step: number): void {
  const current = contract.units[(step - 1) % contract.units.length]!;
  if (step % 3 === 0) {
    current.checks.push(passingCheck(`${current.id}.k${current.checks.length + 1}`, step));
    current.status = 'passed';
    current.activeAgentId = undefined;
    current.answer = `done at step ${step}`;
  } else {
    current.status = 'running';
    current.agentIds.push(`agent-${step}`);
    current.activeAgentId = `agent-${step}`;
    current.touchedPaths.push(`src/file-${step}.ts`);
  }
  contract.decisions.push({ id: `d${step}`, at: step, action: step % 3 === 0 ? 'checked' : 'spawned', targetId: current.id, reason: `step ${step}`, decisionIds: [] });
  contract.usage = { ...contract.usage, inputTokens: contract.usage.inputTokens + step, llmCallCount: step };
  contract.statusLine = `step ${step}`;
}

export function storeAt(root: string): ContractStore {
  return new ContractStore({ projectRoot: root, sweepIntervalMs: 0 });
}

/** A contract as a checkpoint holds it, to compare what was saved with what a restart reads. */
export function saved(contract: Contract): unknown {
  return (JSON.parse(serializeContract(contract, 0)!) as { contract: unknown }).contract;
}

/** The contract a store's load read; an absent or refused checkpoint stops the case. */
export function loaded(store: ContractStore, id: string): Contract {
  const read = store.load(id);
  if (read.kind !== 'present') throw new Error(`the contract did not load: ${JSON.stringify(read)}`);
  return read.value;
}

/** What a restarted process reads: a new store's load. */
export function restart(root: string, id: string): Contract {
  return loaded(storeAt(root), id);
}

export function paths(root: string, id: string) {
  const dir = contractCheckpointDir(root, id);
  return { dir, log: join(dir, 'progress.log') };
}

export function quarantined(dir: string): string[] {
  return existsSync(dir) ? readdirSync(dir).filter(name => name.includes('.corrupt-')) : [];
}

/** The first line a child process prints on standard output. */
export async function firstLine(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader(), decoder = new TextDecoder();
  let text = '';
  while (!text.includes('\n')) {
    const { value, done } = await reader.read();
    if (done) break;
    text += decoder.decode(value);
  }
  reader.releaseLock();
  return text.slice(0, text.indexOf('\n'));
}
