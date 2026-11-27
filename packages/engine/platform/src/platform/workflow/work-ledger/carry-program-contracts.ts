/**
 * Contracts a terminal program ran itself (3.5.0's own runner, before work ran only on the daemon) are kept in their
 * project's contract store (`<project>/.goodvibes/contracts`). This version's programs run no contract; the daemon
 * carries each one that had not ended into that project's Work, once: a proposed piece of work with what it was asked
 * for and the steps it had not finished as its plan, waiting in Work for the owner. Approving it there runs it on the
 * daemon (its finished steps are not run again; they are named in what it asks for).
 *
 * The contract files are only read, never written or moved: a rollback to 3.5.0 finds them as it left them and its
 * program resumes them as before. What was carried is kept in the daemon's records (`carried`), so a contract is
 * carried once, whatever happens to its proposal afterwards.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { writeFileAtomic } from '../../utils/atomic-json-store.js';
import { contractCheckpointsDir, contractProgressDir, contractsDir, deserializeContract, storedCheckpointText } from '../../contract/store.js';
import { isTerminalContractStatus, type Contract } from '../../contract/types.js';
import type { WorkPlans } from './work-plans.js';
import { logger } from '../../utils/logger.js';
import { summarizeError } from '../../utils/error-display.js';

export interface CarryProgramContractsDeps {
  readonly projectRoot: string;
  readonly plans: Pick<WorkPlans, 'propose'>;
  /** The daemon's record of the contracts carried from this project (one file per project, in the daemon's records). */
  readonly carriedFile: string;
}

export interface CarryProgramContractsOutcome {
  readonly carried: readonly { readonly contractId: string; readonly proposal: string; readonly title: string; readonly steps: number }[];
  readonly left: readonly { readonly contractId: string; readonly reason: string }[];
}

/**
 * Every contract id the project's store holds: its checkpoint folders (`checkpoints-v7/<id>/`, as 3.5.0 writes them),
 * its version-6 single files (`checkpoints-v6/<id>.json`) and its oldest single-file records (`<id>.json`).
 */
function storedContractIds(projectRoot: string): string[] {
  const ids = new Set<string>();
  const asId = (name: string): string | undefined => name.endsWith('.json') ? name.slice(0, -'.json'.length) : undefined;
  for (const dir of [contractProgressDir(projectRoot), contractCheckpointsDir(projectRoot), contractsDir(projectRoot)]) {
    if (!existsSync(dir)) continue;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name.startsWith('.')) continue;
      if (dir === contractProgressDir(projectRoot)) { if (entry.isDirectory()) ids.add(entry.name); continue; }
      const id = entry.isFile() ? asId(entry.name) : undefined;
      if (id) ids.add(id);
    }
  }
  return [...ids].filter((id) => id.startsWith('ctr-')).sort();
}

function readCarried(file: string): Set<string> {
  try {
    const stored = JSON.parse(readFileSync(file, 'utf8')) as { readonly carried?: unknown };
    return new Set(Array.isArray(stored.carried) ? stored.carried.filter((id): id is string => typeof id === 'string') : []);
  } catch { return new Set(); }
}

/** A program's own contract that had not ended: no durable admission (the daemon's Work has one), not finished. */
function isOpenProgramContract(contract: Contract): boolean {
  return contract.durableAdmission === undefined && !isTerminalContractStatus(contract.status);
}

/** What the carried work asks for, its finished steps named, and its plan: the steps it had not finished, in order. */
function proposalOf(contract: Contract): Parameters<WorkPlans['propose']>[0] {
  // 3.5.0's agent tool appended its own draft ("Planned for the agents: ...") to what was asked: the draft is the plan's
  // business, so what the work asks for is the words before it (its title is their first line).
  const goal = (contract.goal || contract.ask).split(/\n\s*\nPlanned for the agents:/u)[0]!.trim() || (contract.goal || contract.ask).trim();
  const done = contract.units.filter((unit) => unit.status === 'passed');
  const left = contract.units.filter((unit) => unit.status !== 'passed' && unit.status !== 'cancelled');
  const position = new Map(left.map((unit, index) => [unit.id, index + 1]));
  const note = done.length > 0 ? `\n\nAlready done when it was carried from the terminal program: ${done.map((unit) => `"${unit.title}"`).join(', ')}.` : '';
  const criteria = contract.criteria.map((criterion) => criterion.text.trim()).filter(Boolean);
  return {
    goal: `${goal}${note}`,
    criteria: criteria.length > 0 ? criteria : [`${goal.split('\n')[0]} is done`],
    steps: (left.length > 0 ? left : [{ id: 'all', title: goal.split('\n')[0]!.slice(0, 80), brief: goal, dependsOn: [] as string[] }]).map((unit) => ({
      title: unit.title, brief: ('brief' in unit && typeof unit.brief === 'string' && unit.brief) ? unit.brief : unit.title,
      after: (unit.dependsOn ?? []).map((id) => position.get(id)).filter((at): at is number => at !== undefined),
    })),
    how: 'carried from work a terminal program was running itself before this version',
  };
}

/** Carry the project's unfinished program contracts into its Work, once each. */
export function carryProgramContracts(deps: CarryProgramContractsDeps): CarryProgramContractsOutcome {
  const outcome = { carried: [] as { contractId: string; proposal: string; title: string; steps: number }[], left: [] as { contractId: string; reason: string }[] };
  const carried = readCarried(deps.carriedFile);
  let ids: string[];
  try { ids = storedContractIds(deps.projectRoot); } catch (error) {
    logger.warn('[Work] the contracts a program kept in this project could not be listed; they are carried at the next start', { projectRoot: deps.projectRoot, error: summarizeError(error) });
    return outcome;
  }
  const save = () => writeFileAtomic(deps.carriedFile, `${JSON.stringify({ version: 1, carried: [...carried].sort() }, null, 2)}\n`, { mkdirp: true, mode: 0o600 });
  for (const contractId of ids) {
    if (carried.has(contractId)) continue;
    let contract: Contract | null = null;
    try {
      const text = storedCheckpointText(deps.projectRoot, contractId);
      contract = text === null ? null : deserializeContract(text);
    } catch (error) {
      outcome.left.push({ contractId, reason: summarizeError(error) });
      continue;
    }
    if (!contract) { outcome.left.push({ contractId, reason: 'its record could not be read' }); continue; }
    if (!isOpenProgramContract(contract)) continue;
    try {
      const proposed = deps.plans.propose(proposalOf(contract));
      carried.add(contractId);
      save();
      outcome.carried.push({ contractId, proposal: proposed.id, title: proposed.title, steps: proposed.steps });
    } catch (error) {
      outcome.left.push({ contractId, reason: summarizeError(error) });
    }
  }
  if (outcome.carried.length > 0 || outcome.left.length > 0) logger.info('[Work] contracts a program was running were carried into Work', { projectRoot: deps.projectRoot, carried: outcome.carried.length, left: outcome.left.length });
  return outcome;
}
