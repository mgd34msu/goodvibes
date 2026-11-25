/**
 * remote-health.ts, what the health and setup checks of both terminal programs say about the remote runners: the
 * daemon's runners (runtime/remote/daemon-runners.ts), read once through `remote.list`, never the program's own
 * registry. A daemon that cannot be asked, or a runner file it cannot read, is said as such, never as "none".
 */
import { runDaemonCapability, type DaemonCapabilityBinding } from './command-actions/capability-actions.js';
import type { CommandActionContext } from './command-actions/types.js';
import { collectRemoteRecoveryIssues } from './health-findings.js';

export interface RemoteRunnersHealth {
  /** Why the runners could not be read (the daemon unreachable, or its runner file unreadable); absent when read. */
  readonly unreadable?: string | undefined;
  readonly runners: readonly { readonly runnerId: string; readonly label: string; readonly trustClass: string }[];
  readonly supervised: number;
  readonly connections: number;
  readonly degraded: number;
  readonly pools: number;
  readonly artifacts: number;
  /** One line per runner that needs attention: `<runner>: <what>`. */
  readonly issues: readonly string[];
}

const record = (value: unknown): Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const rows = (value: unknown): readonly Record<string, unknown>[] => Array.isArray(value) ? value.map(record) : [];
const text = (value: unknown): string => typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f-\u009f]+/g, ' ').trim() : '';

const NOTHING = { runners: [], supervised: 0, connections: 0, degraded: 0, pools: 0, artifacts: 0, issues: [] } as const;

/** Read the daemon's runners for a health or setup check, through this program's capability binding. */
export async function readRemoteRunnersHealth<Ctx extends CommandActionContext>(
  ctx: Ctx, binding: DaemonCapabilityBinding<Ctx>,
  format: (id: string, kind: 'transport' | 'heartbeat' | 'error', value: string) => string = (id, kind, value) => `${id}: ${kind === 'error' ? value : `${kind} ${value}`}`,
): Promise<RemoteRunnersHealth> {
  let data: Record<string, unknown>;
  try {
    data = record(record(await runDaemonCapability('remote.list', {}, ctx, binding)).data);
  } catch (error) {
    return { ...NOTHING, unreadable: `the daemon could not be asked (${error instanceof Error ? error.message : String(error)})` };
  }
  const lastErrors = new Map(rows(data['connections']).map((connection) => [text(connection['id']), text(connection['lastError'])]));
  const supervised = rows(data['supervised']).map((session) => ({
    runnerId: text(session['runnerId']), transportState: text(session['transportState']),
    heartbeat: { status: text(session['heartbeat']) || 'fresh' }, lastError: lastErrors.get(text(session['runnerId'])) || undefined,
  }));
  return {
    ...(typeof data['unreadable'] === 'string' ? { unreadable: `the runners the daemon kept could not be read (${text(data['unreadable'])})` } : {}),
    runners: rows(data['contracts']).map((contract) => ({ runnerId: text(contract['runnerId']), label: text(contract['label']) || text(contract['runnerId']), trustClass: text(contract['trustClass']) })),
    supervised: supervised.length,
    connections: rows(data['connections']).length,
    degraded: supervised.filter((session) => session.transportState === 'degraded' || session.transportState === 'reconnecting').length,
    pools: rows(data['pools']).length,
    artifacts: rows(data['artifacts']).length,
    issues: collectRemoteRecoveryIssues(supervised, format),
  };
}
