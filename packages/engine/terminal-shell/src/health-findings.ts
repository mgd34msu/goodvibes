import { drainSnapshotReads } from './onboarding-snapshot-reads.js';
import type { ServiceRegistry } from '@goodvibes-jev/engine/platform/platform/config';
/** Shared deterministic health findings; products supply labels and repair authority. */
export async function collectServiceReadiness(
  registry: Pick<ServiceRegistry, 'getAll' | 'inspect'>,
  separator: string,
): Promise<{ readonly configured: number; readonly issues: string[] }> {
  const keys = Object.keys(registry.getAll());
  const inspections = await drainSnapshotReads(keys.map(async (key) => registry.inspect(key)));
  const issues = inspections
    .filter((inspection) => inspection !== null)
    .flatMap((inspection) => {
      const lines: string[] = [];
      if (!inspection.hasPrimaryCredential) lines.push(inspection.config.name + separator + 'missing primary credential');
      if (inspection.config.authType === 'basic' && !inspection.hasPasswordCredential)
        lines.push(inspection.config.name + separator + 'missing password credential');
      if (!inspection.config.baseUrl) lines.push(inspection.config.name + separator + 'no baseUrl configured');
      return lines;
    });
  return { configured: keys.length, issues };
}
export function collectSettingsHealthIssues(
  settings: {
    readonly conflictCount: number;
    readonly recentFailureCount: number;
    readonly hasStagedManagedBundle: boolean;
    readonly managedLockCount: number;
  },
  managedBundleMessage: string,
): string[] {
  const issues: string[] = [];
  if (settings.conflictCount > 0) issues.push(`${settings.conflictCount} conflicting setting import(s) need review`);
  if (settings.recentFailureCount > 0) issues.push(`${settings.recentFailureCount} recent sync/managed failure(s) recorded`);
  if (settings.hasStagedManagedBundle) issues.push(managedBundleMessage);
  if (settings.managedLockCount > 0) issues.push(`${settings.managedLockCount} managed lock(s) currently enforced`);
  return issues;
}
export function collectRemoteRecoveryIssues<State extends string, Heartbeat extends string>(
  sessions: readonly {
    readonly runnerId: string;
    readonly transportState: State;
    readonly heartbeat: { readonly status: Heartbeat };
    readonly lastError?: string | null | undefined;
  }[],
  format: (id: string, kind: 'transport' | 'heartbeat' | 'error', value: State | Heartbeat | string) => string,
): string[] {
  return sessions.flatMap((session) => {
    const lines: string[] = [];
    if (session.transportState === 'degraded' || session.transportState === 'reconnecting' || session.transportState === 'terminal_failure')
      lines.push(format(session.runnerId, 'transport', session.transportState));
    if (session.heartbeat.status !== 'fresh') lines.push(format(session.runnerId, 'heartbeat', session.heartbeat.status));
    if (session.lastError) lines.push(format(session.runnerId, 'error', session.lastError));
    return lines;
  });
}
export function collectMcpLifecycleIssues(
  servers: readonly {
    readonly name: string;
    readonly status: string;
    readonly schemaFreshness: string;
    readonly lastError?: string | null | undefined;
  }[],
  format: (name: string, kind: 'status' | 'schema' | 'error', value: string) => string,
): string[] {
  return servers.flatMap((server) => {
    const lines: string[] = [];
    if (server.status !== 'connected' && server.status !== 'configured') lines.push(format(server.name, 'status', server.status));
    if (server.schemaFreshness !== 'fresh') lines.push(format(server.name, 'schema', server.schemaFreshness));
    if (server.lastError) lines.push(format(server.name, 'error', server.lastError));
    return lines;
  });
}
export function collectContinuityIssues(
  continuity: {
    readonly lastSessionPointer?: string | null | undefined;
    readonly recoveryFilePresent: boolean;
    readonly sessionId?: string | null | undefined;
  },
  returnMode: string,
): string[] {
  const issues: string[] = [];
  if (!continuity.lastSessionPointer) issues.push('no last-session pointer is recorded');
  if (continuity.recoveryFilePresent) issues.push(`recovery file present for ${continuity.sessionId || '(unknown session)'}`);
  if (returnMode === 'off') issues.push('return-context summaries are disabled');
  return issues;
}
export function formatHealthStatusValue(value: string): string {
  return value === 'quarantined' ? 'needs review' : value.replace(/[_-]+/g, ' ');
}
