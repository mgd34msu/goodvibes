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
    /** How much of `file` has arrived, and its size (null when the server sent none). */
    readonly fileReceivedBytes?: number;
    readonly fileTotalBytes?: number | null;
    /** Which of the release's files `file` is (from 1, in download order), and how many it downloads; null or missing when not known. */
    readonly fileNumber?: number | null;
    readonly fileCount?: number | null;
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

type InstallingView = NonNullable<DaemonUpdateStatusView['installing']>;

/** How much of the file now downloading has arrived, in whole percent, or null when its size is not known. */
function filePercent(installing: InstallingView): number | null {
  const total = installing.fileTotalBytes;
  if (typeof total !== 'number' || total <= 0 || typeof installing.fileReceivedBytes !== 'number') return null;
  return Math.min(100, Math.floor((installing.fileReceivedBytes / total) * 100));
}

/** `3 of 12` when the daemon said which of how many release files this is; null otherwise. */
function fileOfCount(installing: InstallingView): string | null {
  const { fileNumber, fileCount } = installing;
  if (typeof fileNumber !== 'number' || typeof fileCount !== 'number' || fileNumber < 1 || fileCount < fileNumber) return null;
  return `${fileNumber} of ${fileCount}`;
}

/** ` (now <file>, 3 of 12, 45% of 120.0 MB)`; the count and the size are left out when not known; empty before the first byte. */
function describeFile(installing: InstallingView): string {
  if (!installing.file) return '';
  const percent = filePercent(installing);
  const ofCount = fileOfCount(installing);
  const size = percent === null ? '' : `, ${percent}% of ${formatBytes(installing.fileTotalBytes ?? 0)}`;
  return ` (now ${installing.file}${ofCount ? `, ${ofCount}` : ''}${size})`;
}

/**
 * The followed download's line: `downloading <file> (3 of 12): 45%` when the daemon says which file
 * of how many (the file's own bytes when its size is not known); otherwise the bytes of the release
 * received so far and the file now downloading.
 */
function progressLine(installing: InstallingView): string {
  const ofCount = fileOfCount(installing);
  if (installing.file && ofCount) {
    const percent = filePercent(installing);
    return `  downloading ${installing.file} (${ofCount}): ${percent === null ? `${formatBytes(installing.fileReceivedBytes ?? 0)} received` : `${percent}%`}`;
  }
  return `  downloading: ${formatBytes(installing.receivedBytes ?? 0)} received${describeFile(installing)}`;
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
    lines.push(`  installing: ${installing.version ?? update.pendingVersion ?? 'a newer release'}, downloading${elapsed}: ${formatBytes(installing.receivedBytes ?? 0)} received${describeFile(installing)}`);
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
export function formatDaemonUpdateCheckLine(check: DaemonUpdateStatusView['check'], offReason: string | undefined, pendingVersion?: string | null, follows = false): string[] {
  if (check === 'installing') {
    return [`  check:    found ${pendingVersion ?? 'a newer release'}; the daemon is installing it now and will restart into it`,
      follows
        ? '            the download is followed here until the daemon has restarted into it'
        : '            run this command again to see how much has downloaded; it stops answering for a short while when it restarts, then shows the new version'];
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

/**
 * An interactive terminal follows a release the daemon is installing: the command stays,
 * prints the download as it grows, and ends when the daemon has restarted into the new
 * version. A slow download is waited for, never given up on.
 */
export interface DaemonUpdateFollow {
  readonly print: (line: string) => void;
  /**
   * Print a line that later progress replaces in place, and return what replaces it; null when
   * this transcript cannot update a line in place (the line was then printed as it is, and
   * later progress is printed as new lines only when the file's percentage has moved by
   * 5 points or a file finished).
   */
  readonly printLive?: ((line: string) => ((next: string) => void) | null) | undefined;
  /** How long between two asks for progress; the default is two seconds. */
  readonly everyMs?: number | undefined;
  readonly wait?: ((ms: number) => Promise<void>) | undefined;
}

const FOLLOW_EVERY_MS = 2_000;
/** In a transcript that cannot update a line in place, a new progress line once a file's percentage has moved this far. */
const PRINTED_PERCENT_STEP = 5;

/**
 * The download's progress as the person sees it: one line updated in place where the transcript
 * can, otherwise a new line only when the file's percentage moved by 5 points, a file finished,
 * or (a file whose size is unknown) a new file began.
 */
function downloadProgress(follow: DaemonUpdateFollow): (installing: InstallingView) => void {
  let live: ((next: string) => void) | null | undefined;
  let printedFile: string | null | undefined;
  let printedPercent: number | null = null;
  return (installing) => {
    const line = progressLine(installing);
    if (live) { live(line); return; }
    if (live === undefined && follow.printLive) {
      live = follow.printLive(line);
      printedFile = installing.file;
      printedPercent = filePercent(installing);
      return;
    }
    const file = installing.file;
    const percent = filePercent(installing);
    const newFile = file !== printedFile;
    const moved = percent !== null && (printedPercent === null || percent - printedPercent >= PRINTED_PERCENT_STEP || (percent === 100 && printedPercent < 100));
    if (printedFile !== undefined && !newFile && !moved) return;
    follow.print(line);
    printedFile = file;
    printedPercent = percent;
  };
}

/** Ask `update.status` again until the daemon runs a version other than `from` (the one it installs, when known). */
async function followDaemonInstall(verbs: DaemonUpdateVerbs, from: string | null | undefined, first: DaemonUpdateStatusView, follow: DaemonUpdateFollow): Promise<string> {
  const target = first.installing?.version ?? first.pendingVersion ?? undefined;
  const failedAtStart = first.failedCheckCount ?? 0;
  const wait = follow.wait ?? ((ms: number) => new Promise<void>((resolve) => { setTimeout(resolve, ms); }));
  let lastBytes = first.installing?.receivedBytes ?? -1;
  let away = false;
  const progress = downloadProgress(follow);
  for (;;) {
    await wait(follow.everyMs ?? FOLLOW_EVERY_MS);
    let now: DaemonUpdateStatusView;
    try {
      now = await verbs.invoke<DaemonUpdateStatusView>('update.status', {});
    } catch {
      // A daemon restarting into the new release stops answering for a while.
      if (!away) follow.print(`  restarting: the daemon is not answering while it restarts${target ? ` into ${target}` : ''}`);
      away = true;
      continue;
    }
    const running = now.currentVersion ?? null;
    if (running && running !== from && (target === undefined || running === target)) {
      return ['Daemon updates', `  running:  ${running} (updated from ${from ?? 'the earlier version'})`, ...formatDaemonUpdateStatusLines(now).filter((line) => !line.startsWith('  updates:'))].join('\n');
    }
    if (now.installing) {
      away = false;
      const bytes = now.installing.receivedBytes ?? 0;
      if (bytes !== lastBytes) {
        lastBytes = bytes;
        progress(now.installing);
      }
      continue;
    }
    // The install ended without a new version running: it failed, was rolled back or stopped for recovery.
    const failed = (now.failedCheckCount ?? 0) > failedAtStart || (target !== undefined && now.rejectedVersion === target) || now.recoveryRequired === true || Boolean(now.transactionRecovery);
    if (failed || (away && running === from)) {
      return [
        'Daemon updates',
        ...(running ? [`  running:  ${running} (not updated)`] : []),
        ...formatDaemonUpdateStatusLines(now),
      ].join('\n');
    }
  }
}

/** `/update daemon [check]`: what the connected daemon says about updating itself, and with `check` one check run now. */
export async function describeDaemonUpdates(verbs: DaemonUpdateVerbs, check: boolean, follow?: DaemonUpdateFollow): Promise<string> {
  const reachable = verbs.probe();
  if (!reachable.available) {
    return ['Daemon updates', `  unavailable: ${reachable.reason}`, '  next: connect this app to a daemon, then check again on the Updates tab of System'].join('\n');
  }
  const method = check ? 'update.check' : 'update.status';
  try {
    const status = await verbs.invoke<DaemonUpdateStatusView>(method, {});
    const installing = status.check === 'installing' || Boolean(status.installing);
    const following = follow !== undefined && installing;
    const lines = [
      'Daemon updates',
      ...(status.currentVersion ? [`  running:  ${status.currentVersion}`] : []),
      ...formatDaemonUpdateStatusLines(status),
      ...(check ? formatDaemonUpdateCheckLine(status.check, status.offReason, status.pendingVersion, following) : []),
      ...(check || installing ? [] : ['  next: /update daemon --check runs one check now']),
    ].join('\n');
    if (!following) return lines;
    follow.print(lines);
    return await followDaemonInstall(verbs, status.currentVersion, status, follow);
  } catch (error) {
    return [
      'Daemon updates',
      `  the daemon did not answer ${method}: ${error instanceof Error ? error.message : String(error)}`,
      '  next: check that the daemon is running and this app is connected to it, then retry',
    ].join('\n');
  }
}
