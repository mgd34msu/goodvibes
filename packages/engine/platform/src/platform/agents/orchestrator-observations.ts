import { activateClassicFallback, isClassicOperation } from '../runtime/decision-policy.js';
/** Run-owned semantic observations. Neither reading grants tool authority. */
import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { captureJudgmentPort } from '@goodvibes/engine/errors';
import type { JudgmentPort } from '@goodvibes/judgment';
import { assertJudgmentInput, captureOwnedJson } from '../gate/judgment-input.js';
import type { AgentRecord } from '../tools/agent/index.js';
import type { AgentOrchestratorRunContext } from './orchestrator-run-context.js';
import { declaredTestRunner } from '../utils/project-test-runner.js';
import { TEST_FRAMEWORK_OPTIONS } from '../tools/batteries/project-tooling.js';
import { projectTestFramework, repeatStuck } from './batteries/orchestrator-observations.js';

/** A run that is no longer the record's current run: it stops without publishing anything. */
export class OrchestratorObservationHeldError extends Error {
  readonly recoverable = true;
  constructor() { super('Agent semantic observation is unavailable or stale; this run is held and may be retried when its source is current.'); this.name = 'OrchestratorObservationHeldError'; }
}
/**
 * The project's test framework, read once per manifest. A prompt hint: it is a
 * value and authorises nothing. `assertCurrent` is a no-op kept for the prompt
 * builder's signature.
 */
export interface ProjectFrameworkObservation { readonly framework?: string | undefined; readonly assertCurrent: () => void }
export interface RetainedToolObservation { readonly signature: string; readonly requested: unknown; readonly executed: { readonly name: string; readonly arguments: string }; readonly result: unknown }

function object(value: unknown): value is Record<string, unknown> { return !!value && typeof value === 'object' && !Array.isArray(value); }
function checkedPort(base: JudgmentPort): JudgmentPort {
  const model = base.model;
  let actualModel: string | undefined;
  if (!model?.trim()) throw new OrchestratorObservationHeldError();
  return { model, ...(base.recorder ? { recorder: base.recorder } : {}), async ask(request) {
    const result = await base.ask({ ...request, model });
    if (!object(result) || !object(result.answers) || result.requestedModel !== model || typeof result.model !== 'string' || !result.model.trim()
      || (actualModel !== undefined && actualModel !== result.model)) throw new OrchestratorObservationHeldError();
    const answers = captureOwnedJson(result.answers);
    if (!object(answers)) throw new OrchestratorObservationHeldError();
    for (const [name, question] of Object.entries(request.questions)) {
      const answer = answers[name];
      if (!object(answer) || answer.type !== question.type) throw new OrchestratorObservationHeldError();
      if (question.type === 'noul' && (typeof answer.noul !== 'number' || !Number.isFinite(answer.noul) || answer.noul < 0 || answer.noul > 1)) throw new OrchestratorObservationHeldError();
      if (question.type === 'choice' && (typeof answer.choice !== 'string' || !Object.hasOwn(question.criteria, answer.choice))) throw new OrchestratorObservationHeldError();
    }
    if (result.decisionId !== undefined && (typeof result.decisionId !== 'string' || !result.decisionId.trim())) throw new OrchestratorObservationHeldError();
    actualModel = result.model;
    return { ...result, answers: answers as typeof result.answers };
  } };
}

const noop = (): void => {};
const NO_FRAMEWORK: ProjectFrameworkObservation = Object.freeze({ assertCurrent: noop });
function frameworkObservation(framework: string | undefined): ProjectFrameworkObservation {
  return framework === undefined ? NO_FRAMEWORK : Object.freeze({ framework, assertCurrent: noop });
}

/** A reading of a manifest; `cancelled` when the run whose signal it ran under was cancelled mid-reading. */
interface FrameworkReading { readonly framework: string | undefined; readonly settled: boolean; readonly cancelled?: true }

/**
 * One reading per manifest: a batch of spawns in one project shares the first
 * spawn's reading, and a later spawn reuses it until `package.json` changes
 * (device, inode, size and modification time). An entry lives while its
 * working directory has runs: the orchestrator forgets a non-default working
 * directory's entry (forgetProjectFramework) when its last run ends.
 */
const frameworkByManifest = new Map<string, { readonly identity: string; readonly reading: Promise<FrameworkReading> }>();

/** Forgets the reading of `workingDirectory`'s manifest, once no run works there. */
export function forgetProjectFramework(workingDirectory: string): void {
  frameworkByManifest.delete(join(workingDirectory, 'package.json'));
}

async function readProjectFramework(path: string, signal: AbortSignal | undefined): Promise<FrameworkReading> {
  let text: string;
  try { text = readFileSync(path, 'utf8'); } catch { return { framework: undefined, settled: true }; }
  try {
    assertJudgmentInput({ manifest: text });
    const state = captureOwnedJson(JSON.parse(text));
    assertJudgmentInput(state);
    if (!object(state)) return { framework: undefined, settled: true };
    const declared = declaredTestRunner(state);
    if (declared !== undefined) return { framework: declared, settled: true };
    if (isClassicOperation()) return { framework: undefined, settled: false };
    const authority = captureJudgmentPort('agents.project-test-framework', { signal });
    const run = await projectTestFramework.run(checkedPort(authority.port), state as never, { site: 'agents.project-test-framework', signal: authority.signal });
    const reading = run.readings.framework;
    if (reading.outcome !== 'act' || !Object.hasOwn(TEST_FRAMEWORK_OPTIONS, reading.choice)) return { framework: undefined, settled: false };
    if (reading.choice === 'none') return { framework: undefined, settled: true };
    run.recordAction('include project framework');
    return { framework: reading.choice === 'bun' ? 'bun:test' : reading.choice, settled: true };
  } catch (error) {
    // The run this reading ran under was cancelled: say so, so a live run sharing it reads again.
    if (signal?.aborted === true) return { framework: undefined, settled: false, cancelled: true };
    activateClassicFallback(error);
    return { framework: undefined, settled: false };
  }
}

export async function prepareProjectFramework(context: AgentOrchestratorRunContext, record: AgentRecord): Promise<ProjectFrameworkObservation> {
  const path = join(context.workingDirectory, 'package.json');
  let identity: string;
  try {
    const stats = statSync(path, { bigint: true });
    identity = [stats.dev, stats.ino, stats.size, stats.mtimeNs].join(':');
  } catch { return NO_FRAMEWORK; }
  const signal = context.getCancellationSignal?.(record.id);
  const cached = frameworkByManifest.get(path);
  if (cached?.identity === identity) {
    const shared = await cached.reading;
    if (shared.cancelled !== true || signal?.aborted === true) return frameworkObservation(shared.framework);
    // The spawn that owned the shared reading was cancelled mid-reading, and this
    // one is live: the entry is dropped and this spawn reads again as a fresh one
    // would, so the first sibling to get here re-reads and the rest share that.
    if (frameworkByManifest.get(path) === cached) frameworkByManifest.delete(path);
    return prepareProjectFramework(context, record);
  }
  const reading = readProjectFramework(path, signal);
  const entry = { identity, reading };
  frameworkByManifest.set(path, entry);
  const result = await reading;
  // An uncertain, unavailable or cancelled reading is asked again by the next spawn.
  if (!result.settled && frameworkByManifest.get(path) === entry) frameworkByManifest.delete(path);
  return frameworkObservation(result.framework);
}

/** Failure reason of a run ended because one call kept returning the same result. */
export const REPEATED_CALL = 'repeated_call' as const;

/** Whether repeated calls in a turn's own history look stuck; undefined when no reading settled. Any turn's repeat rule reads it (`runTurn`). */
export async function readRepeatStuck(history: readonly RetainedToolObservation[], repeatedSignature: string | undefined, signal: AbortSignal | undefined): Promise<{ readonly stuck: boolean } | undefined> {
  if (isClassicOperation()) return undefined;
  try {
    assertJudgmentInput({ calls: history, repeatedSignature });
    const state = captureOwnedJson({ calls: history, repeatedSignature });
    const authority = captureJudgmentPort('agents.repeat-stuck', { signal });
    const run = await repeatStuck.run(checkedPort(authority.port), state as never, { site: 'agents.repeat-stuck', signal: authority.signal });
    const reading = run.readings.stuck;
    if (reading.outcome !== 'act' || (reading.verdict !== 'yes' && reading.verdict !== 'no')) return undefined;
    const stuck = reading.verdict === 'yes';
    run.recordAction(stuck ? 'repeated calls are stuck' : 'repeated calls show progress');
    return Object.freeze({ stuck });
  } catch (error) {
    activateClassicFallback(error);
    signal?.throwIfAborted();
    return undefined;
  }
}
