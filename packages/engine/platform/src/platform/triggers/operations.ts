/**
 * operations.ts, the one set of trigger operations every caller uses: the
 * `trigger` agent tool, the `watchers.triggers.*` operator methods and the
 * `/triggers` command.
 *
 * `localTriggerOperations` runs them on the supervisor in this process (the
 * daemon, or any host that composes one). `remoteTriggerOperations` runs the
 * same operations on the host's supervisor through its operator methods, for
 * an app that leaves triggers to the daemon (`triggers: 'host'`). Both answer
 * with the same plain views, and a refusal is a `RefusalError` (locally) or the
 * daemon's coded refusal (remotely).
 */

import { RefusalError, refusal } from '@goodvibes-jev/engine/errors';
import type { TriggerManager } from './manager.js';
import type { RegisterGrantInput } from './grants.js';
import type { TriggerActionGrant, TriggerRecord, TriggerRunRecord } from './types.js';

/** What a caller reads about one trigger: never its observations or a command's output. */
export type TriggerSummary = Readonly<Record<string, unknown>>;

export interface TriggerListView {
  readonly ownership: 'local' | 'other-process' | 'unclaimed';
  readonly triggers: readonly TriggerSummary[];
}

export interface TriggerHistoryView {
  readonly trigger: TriggerSummary;
  readonly runs: readonly Readonly<Record<string, unknown>>[];
}

export interface TriggerGrantView {
  readonly id: string;
  readonly description: string;
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd?: string | undefined;
  readonly digest: string;
  readonly confirmedBy: string;
  readonly confirmedAt: string;
}

/** The default and the largest number of runs `history` returns. */
export const TRIGGER_HISTORY_DEFAULT_LIMIT = 20;
export const TRIGGER_HISTORY_MAX_LIMIT = 200;

export interface TriggerOperations {
  list(): Promise<TriggerListView>;
  /** Creates a trigger from a definition `{ id, label, description?, spec, action?, ownerSessionId? }`; the action defaults to an agent turn. */
  create(definition: Readonly<Record<string, unknown>>): Promise<TriggerSummary>;
  history(id: string, limit?: number): Promise<TriggerHistoryView>;
  cancel(id: string): Promise<TriggerSummary>;
  /** Closes an open breaker; refused with the reason when the trigger is not in a state that can be reset. */
  reset(id: string): Promise<TriggerSummary>;
}

/** Grant registration is the owner's own act: offered to the owner's command and the owner-only operator method, never to the agent tool. */
export interface TriggerGrantOperations {
  registerGrant(input: Omit<RegisterGrantInput, 'now'>): Promise<TriggerGrantView>;
  listGrants(): Promise<readonly TriggerGrantView[]>;
}

/** What an agent reads about one trigger. */
export function summarizeTrigger(record: TriggerRecord): TriggerSummary {
  const spec = record.definition.spec;
  const watching = spec.kind === 'condition'
    ? `${spec.probe.kind} probe, ${spec.rule.kind} rule${spec.intervalMs !== undefined ? `, every ${spec.intervalMs}ms` : ''}`
    : `${[spec.command, ...(spec.args ?? [])].join(' ')}${spec.kind === 'stream' ? ` (lines matching ${spec.match.pattern})` : ''}`;
  return {
    id: record.definition.id,
    label: record.definition.label,
    kind: spec.kind,
    watching,
    state: record.state,
    firedCount: record.firedCount,
    ...(record.lastFiredAt !== undefined ? { lastFiredAt: new Date(record.lastFiredAt).toISOString() } : {}),
    ...(record.nextCheckAt !== undefined ? { nextCheckAt: new Date(record.nextCheckAt).toISOString() } : {}),
    ...(record.lastError !== undefined ? { lastError: record.lastError } : {}),
    ...(record.droppedLines > 0 ? { droppedLines: record.droppedLines } : {}),
    ...(record.owedStreamBatches && record.owedStreamBatches.length > 0 ? { owedBatches: record.owedStreamBatches.length } : {}),
    ...(record.state === 'circuit-open' ? { next: 'reset the trigger once the cause is fixed' } : {}),
  };
}

export function summarizeTriggerRun(run: TriggerRunRecord): Readonly<Record<string, unknown>> {
  return {
    at: new Date(run.at).toISOString(),
    outcome: run.outcome,
    ...(run.detail !== undefined ? { detail: run.detail } : {}),
    ...(run.actionResult !== undefined ? { actionResult: run.actionResult } : {}),
    ...(run.termination ? { termination: { state: run.termination.state, reason: run.termination.reason, exitCode: run.termination.exitCode, signal: run.termination.signal, observed: run.termination.observed } } : {}),
  };
}

export function summarizeTriggerGrant(grant: TriggerActionGrant): TriggerGrantView {
  return {
    id: grant.id,
    description: grant.description,
    command: grant.command,
    args: [...grant.args],
    ...(grant.cwd !== undefined ? { cwd: grant.cwd } : {}),
    digest: grant.digest,
    confirmedBy: grant.confirmedBy,
    confirmedAt: new Date(grant.confirmedAt).toISOString(),
  };
}

function notFound(id: string): RefusalError {
  return new RefusalError(refusal({ code: 'TRIGGER_NOT_FOUND', state: `no trigger has the id "${id}"`, reason: `There is no trigger "${id}"`,
    next: ['List the triggers to see their ids'], status: 404 }));
}

function historyLimit(limit: number | undefined): number {
  return limit !== undefined && Number.isInteger(limit) && limit > 0 ? Math.min(limit, TRIGGER_HISTORY_MAX_LIMIT) : TRIGGER_HISTORY_DEFAULT_LIMIT;
}

/** The operations on the supervisor in this process. */
export function localTriggerOperations(manager: TriggerManager): TriggerOperations & TriggerGrantOperations {
  return {
    async list() {
      return { ownership: manager.executionOwnership, triggers: manager.list().map(summarizeTrigger) };
    },
    async create(definition) {
      const record = await manager.create({ ...definition, action: definition['action'] ?? { kind: 'agent-turn' } });
      return summarizeTrigger(record);
    },
    async history(id, limit) {
      const record = manager.get(id);
      if (!record) throw notFound(id);
      return { trigger: summarizeTrigger(record), runs: record.runs.slice(-historyLimit(limit)).map(summarizeTriggerRun) };
    },
    async cancel(id) {
      const record = manager.cancel(id);
      if (!record) throw notFound(id);
      return summarizeTrigger(record);
    },
    async reset(id) {
      const refusedBecause = manager.resetRefusal(id);
      if (refusedBecause) {
        throw new RefusalError(refusal({ code: 'TRIGGER_RESET_REFUSED', state: `trigger "${id}" cannot be reset now`, reason: `The trigger was not reset: ${refusedBecause}`,
          next: ['List the triggers to see its state'], status: 409 }));
      }
      const record = manager.reset(id);
      if (!record) throw notFound(id);
      return summarizeTrigger(record);
    },
    async registerGrant(input) {
      return summarizeTriggerGrant(manager.registerGrant(input));
    },
    async listGrants() {
      return manager.listGrants().map(summarizeTriggerGrant);
    },
  };
}

/** The two calls a remote host needs: whether it is reachable, and one verb. */
export interface TriggerHostVerbs {
  probe(): { readonly available: true } | { readonly available: false; readonly reason: string };
  invoke<T = unknown>(methodId: string, input?: unknown): Promise<T>;
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

/** The same operations on the host's supervisor, through its `watchers.triggers.*` methods. */
export function remoteTriggerOperations(verbs: TriggerHostVerbs): TriggerOperations & TriggerGrantOperations {
  const call = async (methodId: string, input: Record<string, unknown>): Promise<Record<string, unknown>> => {
    const reach = verbs.probe();
    if (!reach.available) throw new Error(`Triggers are supervised by the daemon, which is not reachable: ${reach.reason}`);
    return record(await verbs.invoke(methodId, input));
  };
  return {
    async list() {
      const body = await call('watchers.triggers.list', {});
      const ownership = body['ownership'];
      return {
        ownership: ownership === 'local' || ownership === 'other-process' ? ownership : 'unclaimed',
        triggers: Array.isArray(body['triggers']) ? body['triggers'].map(record) : [],
      };
    },
    async create(definition) {
      return record((await call('watchers.triggers.create', { definition: { ...definition } }))['trigger']);
    },
    async history(id, limit) {
      const body = await call('watchers.triggers.history', { id, ...(limit !== undefined ? { limit } : {}) });
      return { trigger: record(body['trigger']), runs: Array.isArray(body['runs']) ? body['runs'].map(record) : [] };
    },
    async cancel(id) {
      return record((await call('watchers.triggers.cancel', { id }))['trigger']);
    },
    async reset(id) {
      return record((await call('watchers.triggers.reset', { id }))['trigger']);
    },
    async registerGrant(input) {
      const body = await call('watchers.triggers.grant.register', {
        id: input.id, description: input.description, command: input.command,
        ...(input.args !== undefined ? { args: [...input.args] } : {}),
        ...(input.cwd !== undefined ? { cwd: input.cwd } : {}),
      });
      return record(body['grant']) as unknown as TriggerGrantView;
    },
    async listGrants() {
      const body = await call('watchers.triggers.grant.list', {});
      return Array.isArray(body['grants']) ? body['grants'].map((grant) => record(grant) as unknown as TriggerGrantView) : [];
    },
  };
}
