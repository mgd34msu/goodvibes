/**
 * daemon-remote-tool.ts, the model's `remote` tool in a terminal program's own process: the remote runners are the
 * daemon's (runtime/remote/daemon-runners.ts), so each mode runs the daemon's `remote.*` capability through
 * `capabilities.run` instead of the program's own registry. The call was decided by this program's gate as the
 * `remote` tool call; it is sent with the Agent's delegated credential, so the daemon does not decide it again.
 * In the turns the daemon hosts, the `remote` tool already holds the daemon's registry and this one is not used.
 */
import { REMOTE_TRIGGER_TOOL_SCHEMA } from '@goodvibes/engine/platform/platform/tools';
import type { Tool } from '@goodvibes/engine/platform/platform/types';

/** One `capabilities.run` call to the daemon: its answer's body, or why there is none. */
export type RemoteCapabilityPoster = (id: string, inputs: Readonly<Record<string, string>>, signal: AbortSignal | undefined) =>
  Promise<{ readonly ok: true; readonly body: Record<string, unknown> } | { readonly ok: false; readonly error: string }>;

const record = (value: unknown): Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const list = (value: unknown): readonly Record<string, unknown>[] => Array.isArray(value) ? value.map(record) : [];

/** A contract as the in-process tool summarised it. */
function contractSummary(contract: Record<string, unknown>): Record<string, unknown> {
  const ceiling = record(contract['capabilityCeiling']);
  return {
    id: contract['id'], runnerId: contract['runnerId'], label: contract['label'], sourceTransport: contract['sourceTransport'],
    trustClass: contract['trustClass'], template: contract['template'], transportState: record(contract['transport'])['state'] ?? 'local',
    toolCount: Array.isArray(ceiling['allowedTools']) ? ceiling['allowedTools'].length : 0, reviewMode: ceiling['reviewMode'], communicationLane: ceiling['communicationLane'],
  };
}

function poolSummary(pool: Record<string, unknown>): Record<string, unknown> {
  const runnerIds = Array.isArray(pool['runnerIds']) ? pool['runnerIds'] : [];
  return { id: pool['id'], label: pool['label'], runnerCount: runnerIds.length, runnerIds, updatedAt: pool['lastUpdatedAt'] };
}

export function createDaemonRemoteTool(post: RemoteCapabilityPoster): Tool {
  const run = async (id: string, inputs: Readonly<Record<string, string>>, signal: AbortSignal | undefined) => {
    const sent = await post(id, inputs, signal);
    if (!sent.ok) return { success: false as const, error: sent.error };
    return { success: true as const, text: typeof sent.body['text'] === 'string' ? sent.body['text'] : '', data: record(sent.body['data']) };
  };
  return {
    definition: {
      name: 'remote',
      description: 'Manage remote runner pools, contracts, and portable artifacts (the daemon\'s runners).',
      parameters: REMOTE_TRIGGER_TOOL_SCHEMA.parameters,
      sideEffects: ['workflow', 'state', 'read_fs'],
      concurrency: 'serial',
    },
    async execute(args, executeOptions) {
      const signal = executeOptions?.signal;
      const mode = typeof args['mode'] === 'string' ? args['mode'] : '';
      const text = (key: string): string => typeof args[key] === 'string' ? (args[key] as string).trim() : '';
      const view = text('view') === 'full' ? 'full' : 'summary';
      const answer = (done: Awaited<ReturnType<typeof run>>, output: (data: Record<string, unknown>, said: string) => string) =>
        done.success ? { success: true, output: output(done.data, done.text) } : { success: false, error: done.error };
      switch (mode) {
        case 'create-pool': {
          if (!text('poolId')) return { success: false, error: 'create-pool requires poolId.' };
          return answer(await run('remote.create-pool', { pool: text('poolId'), ...(text('label') ? { label: text('label') } : {}) }, signal), (data) => JSON.stringify(data['pool'] ?? data));
        }
        case 'pools':
        case 'contracts':
        case 'artifacts': {
          const done = await run('remote.list', {}, signal);
          return answer(done, (data) => {
            if (typeof data['unreadable'] === 'string') return JSON.stringify({ unreadable: `The runners kept before could not be read: ${data['unreadable']}` });
            const rows = list(data[mode]);
            const shown = view === 'full' ? rows : rows.map(mode === 'pools' ? poolSummary : mode === 'contracts' ? contractSummary : (artifact) => artifact);
            return JSON.stringify({ view, count: rows.length, [mode]: shown });
          });
        }
        case 'assign':
        case 'unassign': {
          if (!text('poolId') || !text('runnerId')) return { success: false, error: `${mode} requires poolId and runnerId.` };
          return answer(await run(`remote.${mode}`, { pool: text('poolId'), runner: text('runnerId') }, signal), (_data, said) => said);
        }
        case 'review': {
          if (!text('artifactId')) return { success: false, error: 'review requires artifactId.' };
          return answer(await run('remote.review', { artifact: text('artifactId') }, signal), (_data, said) => said);
        }
        case 'import-artifact': {
          if (!text('path')) return { success: false, error: 'import-artifact requires path.' };
          return answer(await run('remote.import', { path: text('path') }, signal), (_data, said) => said);
        }
        default:
          return { success: false, error: `Unknown mode: ${mode || '(none)'}` };
      }
    },
  };
}
