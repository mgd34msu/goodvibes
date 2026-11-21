/**
 * daemon-update-status.ts, a daemon's own update loop as every terminal
 * surface shows it: `goodvibes-daemon update`, and `/update daemon` in the
 * terminal app and the Agent. The daemon answers `update.status` and
 * `update.check`; this is the one place their answer becomes lines, so a
 * daemon that cannot update itself never looks like one with nothing to
 * update to, wherever it is read. Nothing here is loaded beyond the text.
 */

/**
 * What a daemon answers about keeping itself current (`update.status`, and
 * `update.check` with what the check did), as read from the wire: every field
 * may be missing from an older daemon.
 */
export interface DaemonUpdateStatusView {
  readonly armed?: boolean;
  readonly offReason?: string;
  readonly currentVersion?: string | null;
  readonly checkIntervalMs?: number | null;
  readonly failedCheckCount?: number;
  readonly lastCheckFailure?: string | null;
  readonly pendingVersion?: string | null;
  /** A release being downloaded and installed now, and how much of it has arrived. */
  readonly installing?: {
    readonly version?: string;
    readonly since?: number;
    readonly receivedBytes?: number;
    readonly file?: string | null;
  } | null;
  /** Since when the pending release has waited for work in flight (epoch ms). */
  readonly pendingSince?: number | null;
  /** The fleet ids of the work the pending release waits behind. */
  readonly pendingBlockedBy?: readonly string[];
  readonly rejectedVersion?: string | null;
  readonly recoveryRequired?: boolean;
  readonly transactionRecovery?: {
    readonly operation?: string;
    readonly phase?: string;
    readonly recoveryPaths?: readonly string[];
    readonly recoveryErrors?: readonly string[];
  } | null;
  readonly check?: 'ran' | 'already-in-flight' | 'loop-off' | 'installing';
}

function formatElapsed(milliseconds: number): string {
  const totalSeconds = Math.max(0, Math.floor(milliseconds / 1000));
  const days = Math.floor(totalSeconds / 86_400);
  const hours = Math.floor((totalSeconds % 86_400) / 3_600);
  const minutes = Math.floor((totalSeconds % 3_600) / 60);
  const seconds = totalSeconds % 60;
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}

function formatBytes(bytes: number): string {
  if (bytes >= 1_000_000) return `${(bytes / 1_000_000).toFixed(1)} MB`;
  if (bytes >= 1_000) return `${(bytes / 1_000).toFixed(1)} kB`;
  return `${bytes} bytes`;
}

/** The daemon's update state in lines: on or off and why, failing checks, a release waiting and what holds it, a rejected release, a recovery fence. */
export function formatDaemonUpdateStatusLines(update: DaemonUpdateStatusView, now: number = Date.now()): string[] {
  const lines: string[] = [];
  if (update.armed === true) {
    const every = typeof update.checkIntervalMs === 'number' ? `, checking every ${formatElapsed(update.checkIntervalMs)}` : '';
    lines.push(`  updates:  on${every}`);
  } else {
    lines.push(`  updates:  off${update.offReason ? `: ${update.offReason}` : ''}`);
  }
  const failed = update.failedCheckCount ?? 0;
  if (failed > 0) {
    lines.push(`  failing:  ${failed} check${failed === 1 ? '' : 's'} in a row failed${update.lastCheckFailure ? `: ${update.lastCheckFailure}` : ''}`);
  }
  const installing = update.installing;
  if (installing) {
    const elapsed = typeof installing.since === 'number' ? ` for ${formatElapsed(now - installing.since)}` : '';
    const file = installing.file ? ` (now ${installing.file})` : '';
    lines.push(`  installing: ${installing.version ?? update.pendingVersion ?? 'a newer release'}, downloading${elapsed}: ${formatBytes(installing.receivedBytes ?? 0)} received${file}`);
  }
  // A release being installed now is said by the check line or the installing line; it is not waiting.
  if (update.pendingVersion && update.check !== 'installing' && !installing) {
    const since = typeof update.pendingSince === 'number' ? ` (waiting ${formatElapsed(now - update.pendingSince)})` : '';
    const blockers = update.pendingBlockedBy ?? [];
    const held = blockers.length > 0
      ? `; it downloads and installs when this work finishes: ${blockers.join(', ')}`
      : '; it downloads and installs when no work is in flight';
    lines.push(`  pending:  ${update.pendingVersion} was found${since}${held}`);
  }
  if (update.rejectedVersion) {
    lines.push(`  rejected: ${update.rejectedVersion} crash looped and was rolled back; the update loop will not install that version again`);
  }
  const recovery = update.transactionRecovery;
  if (update.recoveryRequired === true || recovery) {
    lines.push(`  recovery: an interrupted ${recovery?.operation ?? 'update'} stopped the update loop; it stays off until the kept files are dealt with`);
    for (const path of recovery?.recoveryPaths ?? []) lines.push(`            kept: ${path}`);
    for (const error of recovery?.recoveryErrors ?? []) lines.push(`            error: ${error}`);
  }
  return lines;
}

/** What an on-demand `update.check` did, so "nothing found" is never read as "nothing ran". */
export function formatDaemonUpdateCheckLine(check: DaemonUpdateStatusView['check'], offReason: string | undefined, pendingVersion?: string | null): string[] {
  if (check === 'installing') {
    return [`  check:    found ${pendingVersion ?? 'a newer release'}; the daemon is installing it now and will restart into it`,
      '            run this command again to see how much has downloaded; it stops answering for a short while when it restarts, then shows the new version'];
  }
  if (check === 'ran') return ['  check:    ran now; the lines above are its result'];
  if (check === 'already-in-flight') return ['  check:    another check was already running, so none was started; the lines above are as of now'];
  if (check === 'loop-off') return [`  check:    not run, the update loop is off${offReason ? `: ${offReason}` : ''}`];
  return [];
}

/** The daemon a terminal app is connected to, as the `/update daemon` view reaches it. */
export interface DaemonUpdateVerbs {
  probe(): { readonly available: true } | { readonly available: false; readonly reason: string };
  invoke<T = unknown>(methodId: string, input?: unknown): Promise<T>;
}

/** `/update daemon [check]`: what the connected daemon says about updating itself, and with `check` one check run now. */
export async function describeDaemonUpdates(verbs: DaemonUpdateVerbs, check: boolean): Promise<string> {
  const reachable = verbs.probe();
  if (!reachable.available) {
    return ['Daemon updates', `  unavailable: ${reachable.reason}`, '  next: connect this app to a daemon, then run /update daemon again'].join('\n');
  }
  const method = check ? 'update.check' : 'update.status';
  try {
    const status = await verbs.invoke<DaemonUpdateStatusView>(method, {});
    return [
      'Daemon updates',
      ...(status.currentVersion ? [`  running:  ${status.currentVersion}`] : []),
      ...formatDaemonUpdateStatusLines(status),
      ...(check ? formatDaemonUpdateCheckLine(status.check, status.offReason, status.pendingVersion) : []),
      ...(check ? [] : ['  next: /update daemon --check runs one check now']),
    ].join('\n');
  } catch (error) {
    return [
      'Daemon updates',
      `  the daemon did not answer ${method}: ${error instanceof Error ? error.message : String(error)}`,
      '  next: check that the daemon is running and this app is connected to it, then retry',
    ].join('\n');
  }
}
