import type { CommandContext, CommandRegistry } from '../command-registry.ts';
import { getOperatorRpc, describeOperatorRpcError } from './operator-rpc.ts';
import { renderWorkstreamGraphLines } from '../../views/workstream-graph-render.ts';
import { defineCommand, defineList, type ListRow } from '@goodvibes-jev/engine/terminal-shell/command-actions';
import { listInput, readAction } from '@goodvibes-jev/engine/terminal-shell/described-command-kit';
import { commandRefusal } from '@goodvibes-jev/engine/terminal-shell/command-confirmation';

// ---------------------------------------------------------------------------
// /graph, a workstream's task graph (fleet.graph.get) rendered legibly.
//
// The observability-layer surface: nodes, edges, per-node states (ready /
// running / blocked-with-"waiting on: X" / stalled / orphaned) and the elastic
// pool posture ("N ready, M running, at cap (fleet.maxSize=N)"), the shape of
// the dependency graph WITHOUT opening any transcript. Described once
// (command-actions/): one action, its workstream chosen from the daemon's.
// ---------------------------------------------------------------------------

function renderWidth(): number {
  const cols = typeof process !== 'undefined' && process.stdout && process.stdout.columns ? process.stdout.columns : 80;
  return Math.max(40, cols - 2);
}

function rpcOf(ctx: CommandContext) {
  const rpc = getOperatorRpc(ctx);
  if (!rpc.available) throw commandRefusal(rpc.reason);
  return rpc;
}

const FLEET_WORKSTREAMS = defineList<CommandContext>({
  name: 'fleet.workstreams',
  async read(ctx) {
    const rpc = getOperatorRpc(ctx);
    if (!rpc.available) return [];
    const page = await rpc.platformClient.operator.invoke('fleet.list', { kinds: ['contract'] });
    return page.items.map((node): ListRow => ({ value: node.id, label: node.label ?? node.task ?? node.id, ...(node.state ? { state: String(node.state) } : {}) }));
  },
  operator: { method: 'fleet.list', input: {}, rows: { from: 'items', value: 'id', label: 'label', state: 'state' } },
});

export function registerGraphRuntimeCommands(registry: CommandRegistry): void {
  registry.register(defineCommand<CommandContext>({
    name: 'graph',
    title: 'Workstream task graph',
    summary: 'See how a workstream\'s steps depend on each other and where it is stuck',
    group: 'Work',
    actions: [
      readAction<CommandContext>({
        id: 'graph', label: 'See a workstream\'s task graph', word: '',
        inputs: [listInput({ id: 'workstream', label: 'Workstream', help: 'The workstreams the daemon knows', list: FLEET_WORKSTREAMS, other: 'a workstream id from /workstream list' })],
        sentence: 'Shows {workstream}\'s steps, what each waits on, which are stuck, and how many run at once.',
        example: { workstream: 'c-4f9c21' },
        operator: { method: 'fleet.graph.get', fields: { workstreamId: 'workstream' } },
        async run(values, ctx) {
          try {
            const snapshot = await rpcOf(ctx).platformClient.operator.invoke('fleet.graph.get', { workstreamId: values.workstream! });
            return renderWorkstreamGraphLines(snapshot, renderWidth()).join('\n');
          } catch (error) {
            throw commandRefusal(describeOperatorRpcError(error));
          }
        },
      }),
    ],
  }));
}
