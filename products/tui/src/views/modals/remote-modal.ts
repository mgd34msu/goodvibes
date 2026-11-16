import type { ConfigModalActionContext, ConfigModalRow, ConfigModalSurface, ConfigModalView } from '../../input/config-modal-types.ts';
import type { UiReadModel, UiRemoteSnapshot } from '../../runtime/ui-read-models.ts';
import { toneStyle, statusGlyph, pad, postureLine, kv, runModalCommand, type Tone } from './modal-surface-helpers.ts';

const RUNNER_ROW = 'runner:';
const STEP_ROW = 'step:';

function stateTone(state: string): Tone {
  switch (state) {
    case 'connected':
    case 'syncing':
      return 'good';
    case 'degraded':
    case 'reconnecting':
    case 'authenticating':
    case 'initializing':
      return 'warn';
    case 'terminal_failure':
      return 'bad';
    default:
      return 'dim';
  }
}

/**
 * Remote config-modal surface (migrated from the `remote` view). The read-model
 * snapshot is synchronous; a subscribe() keeps live transport/heartbeat values
 * refreshing between key presses. Connections and Contracts list the runners,
 * keyed by the runner id `/remote` accepts (a connection's runner id is its
 * agent id). The Recovery tab shows each tracked runner's suggested steps in the
 * modal; Enter on a runner jumps to its steps, and Enter on a step closes the
 * modal and runs that command so its output is in view. Nothing here changes a
 * transport by itself: every step is a command the user chose.
 */
class RemoteModalSurface implements ConfigModalSurface {
  readonly name = 'remote-modal';
  readonly title = 'Remote';
  private requestRender: () => void = () => {};
  private unsub: (() => void) | null = null;

  constructor(private readonly readModel?: UiReadModel<UiRemoteSnapshot>) {}

  // One Enter: on a runner row it shows that runner's steps, on a step row it runs it.
  readonly actions = [
    {
      key: 'enter', id: 'activate', label: 'recovery steps / run step',
      enabledFor: (row: ConfigModalRow | null, tabId: string) => tabId === 'recovery' ? Boolean(row?.id.startsWith(STEP_ROW)) : Boolean(row?.id.startsWith(RUNNER_ROW)),
    },
  ];

  onOpen(requestRender: () => void): void {
    this.requestRender = requestRender;
    if (this.readModel && !this.unsub) this.unsub = this.readModel.subscribe(() => this.requestRender());
  }

  onClose(): void {
    this.unsub?.();
    this.unsub = null;
  }

  buildView(): ConfigModalView {
    const snapshot = this.readModel?.getSnapshot();
    if (!snapshot) {
      return {
        title: 'Remote',
        degraded: 'Runtime store not wired into this runtime.',
        tabs: [{ id: 'connections', label: 'Connections', rows: [], emptyText: 'Try /remote setup.' }],
      };
    }
    const { daemon, acp, contracts, artifacts, supervisor, distributed } = snapshot;
    const peersConnected = distributed.peers.filter((p) => p.status === 'connected').length;
    const header = [
      postureLine([
        `daemon ${daemon.transportState.toUpperCase()}`,
        kv('running', daemon.isRunning ? 'yes' : 'no'),
        kv('reconnects', daemon.reconnectAttempts),
        kv('jobs', daemon.runningJobCount),
      ]),
      postureLine([
        `acp ${acp.transportState.toUpperCase()}`,
        kv('conns', acp.activeConnections.length),
        kv('contracts', contracts.length),
        kv('artifacts', artifacts.length),
        kv('sessions', supervisor.sessions.length),
        kv('peers', `${peersConnected}/${distributed.peers.length}`),
      ]),
    ];

    const connectionRows = acp.activeConnections.map((c) => ({
      id: `${RUNNER_ROW}${c.agentId}`,
      label: `${statusGlyph(stateTone(c.transportState))} ${pad(c.agentId, 20)} ${pad(c.transportState.toUpperCase(), 14)} msgs=${c.messageCount} errs=${c.errorCount}  ${c.label ?? ''}`,
      style: toneStyle(stateTone(c.transportState)),
    }));

    const contractRows = contracts.map((ct) => ({
      id: `${RUNNER_ROW}${ct.runnerId}`,
      label: `${statusGlyph(stateTone(ct.transport.state))} ${pad(ct.runnerId, 20)} ${pad(ct.transport.state.toUpperCase(), 14)} ${ct.template ?? ''}`,
      style: toneStyle(stateTone(ct.transport.state)),
    }));

    // Runners that need attention first; each runner's steps are selectable rows.
    const sessions = [...supervisor.sessions].sort((a, b) => Number(b.recovery.length > 0) - Number(a.recovery.length > 0));
    const recoveryRows: ConfigModalRow[] = sessions.flatMap((session): ConfigModalRow[] => [
      {
        id: `${RUNNER_ROW}${session.runnerId}`,
        label: `${statusGlyph(stateTone(session.transportState))} ${pad(session.label, 20)} ${pad(session.transportState.toUpperCase(), 14)} heartbeat=${session.heartbeat.status}${session.lastError ? `  last error: ${session.lastError}` : ''}`,
        style: toneStyle(stateTone(session.transportState)),
        selectable: false,
        header: true,
      },
      ...(session.recovery.length === 0
        ? [{ id: `none:${session.runnerId}`, label: `  nothing to do: ${session.heartbeat.detail}`, selectable: false }]
        : session.recovery.map((step, index): ConfigModalRow => ({ id: `${STEP_ROW}${session.runnerId}:${index}`, label: `  ${step.command}  ${step.reason}` }))),
    ]);

    return {
      title: 'Remote',
      tabs: [
        { id: 'connections', label: 'Connections', header, rows: connectionRows, emptyText: 'No active ACP or remote subagent connections.', hints: ['Enter recovery steps'] },
        { id: 'contracts', label: 'Contracts', header, rows: contractRows, emptyText: 'No registered remote runner contracts.', hints: ['Enter recovery steps'] },
        { id: 'recovery', label: 'Recovery', header, rows: recoveryRows, emptyText: 'No remote runners are tracked.', hints: ['Enter run the step (closes this view to show its output)'] },
      ],
    };
  }

  onAction(id: string, ctx: ConfigModalActionContext): void {
    if (id !== 'activate') return;
    const rowId = ctx.row?.id ?? '';
    if (rowId.startsWith(RUNNER_ROW)) {
      const runnerId = rowId.slice(RUNNER_ROW.length);
      const session = this.readModel?.getSnapshot().supervisor.sessions.find((entry) => entry.runnerId === runnerId);
      if (!session || session.recovery.length === 0) {
        ctx.setStatus(session ? `${session.label}: no recovery steps; ${session.heartbeat.detail}` : `${runnerId} is not tracked by the remote supervisor.`);
        return;
      }
      ctx.jumpToRow?.('recovery', `${STEP_ROW}${runnerId}:0`);
      ctx.setStatus(`${session.recovery.length} step(s) for ${session.label}; Enter runs the selected one.`);
      this.requestRender();
      return;
    }
    if (rowId.startsWith(STEP_ROW)) {
      const match = /^step:(.+):(\d+)$/.exec(rowId);
      const session = match ? this.readModel?.getSnapshot().supervisor.sessions.find((entry) => entry.runnerId === match[1]) : undefined;
      const step = match && session ? session.recovery[Number(match[2])] : undefined;
      const parts = step?.command.trim().replace(/^\//, '').split(/\s+/) ?? [];
      const [name, ...args] = parts;
      if (!step || !name) { ctx.setStatus('That step is no longer suggested; the list has been refreshed.'); this.requestRender(); return; }
      // The step's output is printed to the conversation; close first so it is visible.
      ctx.close();
      runModalCommand(ctx, name, args, step.command);
    }
  }
}

export function createRemoteModalSurface(readModel?: UiReadModel<UiRemoteSnapshot>): ConfigModalSurface {
  return new RemoteModalSurface(readModel);
}
