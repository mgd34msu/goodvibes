/**
 * work-agents-lists.ts, the terminal side of the Work place's remote runners
 * and recorded runs (work-agents-entries.ts holds their lists and actions):
 * the Recorded runs source a program supplies from its replay engine, and the
 * live lists the remote capabilities' inputs choose from, read through the
 * program's daemon binding. Moved here from work-agents-entries.ts, unchanged,
 * so the declaration holds no terminal code and the web UI draws it too
 * (places/browser.ts).
 */
import {
  REMOTE_ARTIFACTS_LIST, REMOTE_CONNECTIONS_LIST, REMOTE_POOL_RUNNERS_LIST, REMOTE_POOLS_LIST, REMOTE_RUNNERS_LIST, REMOTE_SUPERVISED_LIST, REPLAY_RUNS_LIST,
} from '@goodvibes/engine/platform/platform/capabilities';
import { replayLedgerOf, type DeterministicReplayEngine } from '@goodvibes/engine/platform/platform/core';
import { defineList, type ListRow } from '../command-actions/lists.js';
import { runDaemonCapability, type DaemonCapabilityBinding } from '../command-actions/capability-actions.js';
import type { CommandActionContext } from '../command-actions/types.js';
import type { PlaceProgramSource } from './place-host.js';
import {
  LIVE_RUNNER, RECORDED_RUNS_SOURCE, RUNNER_STATE_WORDS, handedBackItems, listedRunners, poolItems, runnerItems,
  ARCHETYPES_SOURCE, CONTRACTS_SOURCE, YOUR_AGENTS_SOURCE,
} from './work-agents-entries.js';
import type { AgentContractServices, AgentTeamServices } from '@goodvibes/engine/platform/platform/capabilities';

const text = (value: unknown): string => typeof value === 'string' ? value : '';
const record = (value: unknown): Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
/** Text from another machine (a runner's label, task or error), with control characters taken out. */
const plain = (value: unknown): string => text(value).replace(/[\u0000-\u001f\u007f-\u009f]+/g, ' ').trim();

/** What a program's replay engine says for the Recorded runs list: the runs, newest first, and the one loaded. */
export function recordedRunsOf(engine: DeterministicReplayEngine): { readonly runs: readonly string[]; readonly loaded?: string | undefined; readonly rev?: number | undefined; readonly total?: number | undefined } {
  const snap = engine.getSnapshot();
  const runs = [...(replayLedgerOf(engine)?.listRunIds() ?? [])].reverse();
  return snap.status === 'idle' || !snap.runId ? { runs } : { runs, loaded: snap.runId, rev: snap.currentRev, total: snap.totalRevisions };
}

/**
 * The Recorded runs list's source, for a program that records its turns: read from its replay engine, and told
 * when the program says a turn ended (its own turn-end signal) so a run recorded while the place is open shows.
 */
export function recordedRunsPlaceSource(engine: DeterministicReplayEngine | undefined, onTurnEnd?: (listener: () => void) => () => void): Readonly<Record<string, PlaceProgramSource>> {
  if (!engine) return {};
  return { [RECORDED_RUNS_SOURCE]: { read: () => recordedRunsOf(engine), subscribe: (onChange) => onTurnEnd?.(onChange) ?? (() => {}) } };
}

/** What a program that runs its own agents gives the Work place (builtin/agents.ts services, from its session). */
export interface AgentsPlaceServices {
  readonly agentTeam?: Pick<AgentTeamServices, 'archetypes'> | undefined;
  readonly agentContracts?: Pick<AgentContractServices, 'list' | 'running'> | undefined;
}

/**
 * The Your agents, Work contracts and Archetypes lists' sources, for a program that runs agents of its own (the
 * terminal app): read from its session's services, and told on every change to its agents (`onAgentsChange`).
 */
export function agentsPlaceSources(services: (() => AgentsPlaceServices | undefined) | undefined, onAgentsChange?: (listener: () => void) => () => void): Readonly<Record<string, PlaceProgramSource>> {
  const now = services?.();
  if (!now?.agentTeam && !now?.agentContracts) return {};
  const subscribe = (onChange: () => void): (() => void) => onAgentsChange?.(onChange) ?? (() => {});
  return {
    ...(now.agentContracts ? {
      [YOUR_AGENTS_SOURCE]: { read: () => services?.()?.agentContracts?.running() ?? [], subscribe },
      [CONTRACTS_SOURCE]: { read: () => services?.()?.agentContracts?.list() ?? [], subscribe },
    } : {}),
    ...(now.agentTeam ? { [ARCHETYPES_SOURCE]: { read: () => services?.()?.agentTeam?.archetypes() ?? [], subscribe: () => () => {} } } : {}),
  };
}

/** The recorded runs a load or a compare chooses from: the program's own (only the terminal app records them). */
defineList<CommandActionContext>({
  name: REPLAY_RUNS_LIST,
  async read(ctx) {
    const engine = (ctx as { readonly platform?: { readonly replayEngine?: DeterministicReplayEngine | undefined } }).platform?.replayEngine;
    return engine ? recordedRunsOf(engine).runs.map((id): ListRow => ({ value: id, label: id })) : [];
  },
  operator: { terminalOnly: 'Recorded runs are kept by the terminal app.' },
});

// ---------------------------------------------------------------------------
// The live lists the remote capabilities' inputs choose from.
// ---------------------------------------------------------------------------

let binding: DaemonCapabilityBinding<CommandActionContext> | undefined;

/** Each program gives the binding its slash actions use (capability-binding.ts), so a form's lists read the daemon. */
export function bindWorkAgentLists(next: DaemonCapabilityBinding<never>): void {
  binding = next as unknown as DaemonCapabilityBinding<CommandActionContext>;
}

async function readRunners(ctx: CommandActionContext): Promise<unknown> {
  if (!binding) return {};
  return runDaemonCapability('remote.list', {}, ctx, binding);
}

const OPERATOR = (from: string, value: string, label: string, state?: string) => ({
  method: 'capabilities.run', input: { id: 'remote.list' }, rows: { from: `data.${from}`, value, label, ...(state ? { state } : {}) },
});

defineList<CommandActionContext>({
  name: REMOTE_RUNNERS_LIST,
  async read(ctx) {
    return runnerItems(await readRunners(ctx)).map((runner): ListRow => ({ value: runner.id, label: runner.label, detail: `${runner.template}${runner.pool ? `, pool ${runner.pool}` : ''}`, state: RUNNER_STATE_WORDS[runner.state] }));
  },
  operator: OPERATOR('contracts', 'runnerId', 'label'),
});
defineList<CommandActionContext>({
  name: REMOTE_CONNECTIONS_LIST,
  async read(ctx) {
    return runnerItems(await readRunners(ctx)).filter((runner) => LIVE_RUNNER.includes(runner.state)).map((runner): ListRow => ({ value: runner.id, label: runner.label, state: runner.transport }));
  },
  operator: OPERATOR('connections', 'id', 'label', 'transportState'),
});
defineList<CommandActionContext>({
  name: REMOTE_SUPERVISED_LIST,
  async read(ctx) {
    const supervised = listedRunners(await readRunners(ctx))['supervised'];
    return (Array.isArray(supervised) ? supervised : []).map(record).map((session): ListRow => ({ value: text(session['runnerId']), label: plain(session['label']) || text(session['runnerId']), state: `${text(session['transportState'])}, heartbeat ${text(session['heartbeat'])}` }));
  },
  operator: OPERATOR('supervised', 'runnerId', 'label'),
});
defineList<CommandActionContext>({
  name: REMOTE_POOLS_LIST,
  async read(ctx) {
    return poolItems(await readRunners(ctx)).map((pool): ListRow => ({ value: pool.id, label: pool.label, state: `${pool.runners.length} runner${pool.runners.length === 1 ? '' : 's'}` }));
  },
  operator: OPERATOR('pools', 'id', 'label'),
});
defineList<CommandActionContext>({
  name: REMOTE_POOL_RUNNERS_LIST,
  async read(ctx, earlier) {
    const pool = poolItems(await readRunners(ctx)).find((entry) => entry.id === earlier.pool);
    return (pool?.runners ?? []).map((runnerId): ListRow => ({ value: runnerId, label: runnerId }));
  },
  operator: { method: 'capabilities.run', input: { id: 'remote.list' }, rows: { from: 'data.pools', where: { field: 'id', equals: '{pool}' }, each: 'runnerIds', value: '.', label: '.' } },
});
defineList<CommandActionContext>({
  name: REMOTE_ARTIFACTS_LIST,
  async read(ctx) {
    return handedBackItems(await readRunners(ctx)).map((artifact): ListRow => ({ value: artifact.id, label: artifact.summary || artifact.id, detail: `runner ${artifact.runner}; tools: ${artifact.tools.join(', ') || 'none'}; task: ${artifact.task}`, state: artifact.state }));
  },
  operator: OPERATOR('artifacts', 'id', 'summary', 'status'),
});
