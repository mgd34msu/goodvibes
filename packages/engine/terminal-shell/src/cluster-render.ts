/**
 * cluster-render.ts, turning a daemon's `cluster` answers into lines a
 * person reads.
 *
 * Every function here is pure: structured data in, strings out. The verb
 * layer decides what is true; this decides how to say it. That split is what
 * lets `--json` print the same data with no second code path, and what lets a
 * CLI, a TUI's `/cluster`, and a web UI render the same answers each in their
 * own way.
 */
import { stripDangerousAnsi } from './ansi-sanitize.js';
import { generateQrMatrix, renderQrToString } from '@goodvibes/engine/platform/platform/pairing/qr-generator';
import type {
  RotateKeyResult,
  CreateGroupResult,
  DiscoveredGroup,
  ForgetNodeResult,
  GroupStatusReport,
  JoinGroupResult,
  JoinKeyResult,
  NodesResult,
} from '@goodvibes/engine/platform/platform/cluster';

/**
 * Text another machine chose, made safe to print: escape sequences and control characters are
 * removed, so a hostile advertisement cannot write to the operator's terminal or clipboard.
 * The cluster commands apply it to every string of a daemon's answer where the answer enters
 * (cluster-commands.ts), so the renderers below receive printable text.
 */
export function printableText(value: string): string {
  return stripDangerousAnsi(value).replace(/[\u0000-\u001f\u007f-\u009f]/g, '');
}

/** A name made printable and bounded, so a long name cannot blow up the table width. */
export function printableName(value: string, max = 64): string {
  const plain = printableText(value);
  return plain.length > max ? `${plain.slice(0, max - 1)}…` : plain;
}

/** How long ago, in words. Never a raw timestamp, nobody reads epoch millis. */
export function describeAge(at: number, now: number): string {
  const seconds = Math.max(0, Math.round((now - at) / 1_000));
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

function pad(value: string, width: number): string {
  return value.length >= width ? value : value + ' '.repeat(width - value.length);
}

/**
 * `cluster status`.
 *
 * Leads with the thing the operator came for, the role of THIS machine and
 * which surfaces it holds, and finishes with the one sentence of advice, if
 * there is anything to do.
 */
export function renderStatus(report: GroupStatusReport, now: number): string[] {
  if (report.membership !== 'member') {
    return [
      report.membership === 'no-group' && report.removedFrom
        ? `this machine is not in a group: another member told it the group removed it ${describeAge(report.removedFrom.at, now)}`
        : report.membership === 'no-group'
        ? 'this machine is not in a group'
        : 'this machine has group key material that could not be read',
      `machine: ${report.nodeName} (${report.nodeId})`,
      `version: ${report.version}`,
      ...(report.electionAuthentication === 'unavailable'
        ? ['election traffic: none sent or taken, cluster.secret names a stored secret that cannot be read; '
          + 'store the phrase with `secrets set` and point cluster.secret at it, or clear cluster.secret']
        : []),
      ...(report.advice ? ['', report.advice] : []),
    ];
  }
  const lines = [
    `group:    ${report.groupName ?? '(unnamed)'}  [${report.groupId ?? 'unknown'}]`,
    `machine:  ${report.nodeName} (${report.nodeId})`,
    `members:  ${report.memberCount}`,
    `version:  ${report.version}`,
  ];

  if (report.surfaces === null) {
    lines.push('surfaces: not reported by this daemon');
  } else if (report.surfaces.length === 0) {
    lines.push('surfaces: none held by this machine right now');
  } else {
    lines.push('surfaces held by this machine:');
    for (const holding of report.surfaces) {
      lines.push(`  ${holding.surfaceId}: ${holding.reason}`);
    }
  }

  lines.push(
    '',
    `group key: generation ${report.keyGeneration ?? 0}, rotates every ${report.rotationHours}h`,
    `           ${report.keyGenerationsHeld} of at most ${report.keyGenerationCap} generations kept; `
      + `accepting ${report.acceptedGenerations.join(' and ') || 'none'}`,
  );
  if (report.removedNodeCount > 0) {
    lines.push(`removed machines on record: ${report.removedNodeCount}`);
  }
  if (report.authority) {
    const authority = report.authority;
    lines.push(`authority: revision ${authority.revision}, digest ${authority.digest.slice(0, 12)}`
      + (authority.behindOn.length === 0 ? ', the same on every member heard'
        : authority.behind ? `, behind ${authority.behindOn.join(', ')}; taking their record now`
          : `, differs on ${authority.behindOn.join(', ')}; they are taking it`));
    if (authority.droppedOnReturn) {
      const dropped = authority.droppedOnReturn;
      lines.push(`  on returning after longer than cluster.revocationRetentionMinutes, ${dropped.count} entr${dropped.count === 1 ? 'y' : 'ies'} the group had removed were dropped here, not brought back`
        + ` (${new Date(dropped.at).toISOString()}): ${dropped.keys.join(', ')}${dropped.count > dropped.keys.length ? ', ...' : ''}`);
    }
    for (const username of authority.userConflicts ?? []) {
      lines.push(`  user "${username}" exists as separate accounts made on different machines; each machine keeps its own, and changes to it stay on that machine.`
        + ` Keep one: \`cluster publish user:${username} --yes\` on the machine whose account the group should keep, or \`cluster accept user:${username} --yes\` to give up this machine's`);
    }
  }
  if (report.replication) {
    const replication = report.replication;
    lines.push(
      '',
      `shared settings: ${replication.entries} setting${replication.entries === 1 ? '' : 's'} and `
        + `${replication.secrets} credential${replication.secrets === 1 ? '' : 's'} at revision ${replication.revision}`,
    );
    if (replication.tombstones > 0) {
      lines.push(`                 ${replication.tombstones} deleted setting(s) still on record`);
    }
    if (replication.lastAppliedFrom) {
      lines.push(
        `                 last change from ${replication.lastAppliedFrom}`
          + (replication.lastAppliedAt ? ` ${describeAge(replication.lastAppliedAt, now)}` : ''),
      );
    }
    if (replication.awaitingSync) {
      lines.push('                 differs from another machine or is still catching up; settings are being exchanged');
    }
    if (replication.credentialsMissing > 0) {
      lines.push(`                 ${replication.credentialsMissing} credential(s) known to the group have not arrived here yet; asked for again every minute`);
    }
    if (replication.changesNotApplied > 0) {
      lines.push(`                 ${replication.changesNotApplied} change(s) from the group not applied here yet; retried every 30 seconds`);
    }
    if (replication.localChangesHeld > 0) {
      lines.push(`                 ${replication.localChangesHeld} change(s) made here are held until this machine has the group's settings, then sent`);
    }
    // Absent from a daemon built before local differences were reported.
    const differences = replication.localDifferences ?? [];
    if (differences.length > 0) {
      lines.push(`                 ${differences.length} shared setting(s) differ here from the group's and were kept:`);
      for (const difference of differences) {
        lines.push(`                   ${difference.path} (the group holds ${printableName(difference.origin)}'s value)`);
      }
      lines.push('                 `cluster publish <setting>` sends this machine\'s value to the group; `cluster accept <setting>` takes the group\'s');
    }
  }
  if (report.electionTiming) {
    const timing = report.electionTiming;
    lines.push(
      '',
      `election:  heartbeat ${timing.heartbeatSeconds}s, master timeout ${timing.masterTimeoutSeconds}s, boot probe ${timing.bootProbeSeconds}s`,
      // The stored value is what config get shows; say which one runs instead.
      ...timing.adjustments.map((adjustment) => `           ${adjustment.key} is set to ${adjustment.configured}s but runs as ${adjustment.effective}s: ${adjustment.reason}`),
    );
  }
  if (report.wire) {
    lines.push(
      `traffic:   ${report.wire.sent} sent, ${report.wire.received} received; dropped `
        + `${report.wire.droppedOtherGroup} from other groups, ${report.wire.droppedBadSignature} unverified, `
        + `${report.wire.droppedOldGeneration} on an old key, ${report.wire.droppedMalformed} malformed`
        + (report.wire.droppedNoGroup > 0
          ? `; ${report.wire.droppedNoGroup} not sent because this machine is in no group`
          : ''),
    );
  }
  if (report.advice) lines.push('', report.advice);
  // Deliberately absent, and it should stay absent: the join key, the group
  // key, any generation of it, this machine's private keys, and the VALUE of
  // any replicated credential. `cluster key` is the only path to the join key
  // and nothing shows the rest at all.
  return lines;
}

/** `cluster nodes`. */
export function renderNodes(result: NodesResult, now: number): string[] {
  const lines = [`group: ${result.groupName}  [${result.groupId}]`, ''];
  if (result.members.length === 0) {
    lines.push('no machines in this group yet');
  } else {
    const width = Math.max(...result.members.map((member) => printableName(member.displayName).length), 12);
    lines.push(`${pad('MACHINE', width)}  ${pad('NODE ID', 38)}  LAST SEEN`);
    for (const member of result.members) {
      const suffix = member.isThisMachine ? '  (this machine)' : '';
      // Not heard since start: lastSeenAt is when this daemon started listening, not a sighting of the machine.
      const seen = member.heardSinceStart === false
        ? `not heard since this daemon started (${describeAge(member.lastSeenAt, now)})`
        : describeAge(member.lastSeenAt, now);
      lines.push(
        `${pad(printableName(member.displayName), width)}  ${pad(member.nodeId, 38)}  ${seen}${suffix}`,
      );
    }
  }
  if (result.removed.length > 0) {
    lines.push('', 'removed from this group:');
    for (const entry of result.removed) {
      lines.push(`  ${entry.nodeId}  ${describeAge(entry.removedAt, now)}  (${entry.reason})`);
    }
  }
  return lines;
}

/** `cluster create`. */
export function renderCreated(result: CreateGroupResult): string[] {
  return [
    `created the group "${result.groupName}"  [${result.groupId}]`,
    '',
    result.generatedKey
      ? 'a join key was generated for you. Run `cluster key` on this machine at any'
      : 'your join phrase is in use. Run `cluster key` on this machine at any',
    'time to see it again, it is not a one-time reveal.',
    '',
    'to add another machine: run `cluster join` on it and give it this key.',
    '',
    `the group name ("${result.groupName}") is visible to anything on this network that`,
    'is listening for goodvibes groups. Change it any time with `cluster rename`.',
  ];
}

/** `cluster join`. */
export function renderJoined(result: JoinGroupResult): string[] {
  return [
    `joined "${result.groupName}"  [${result.groupId}]`,
    `the group now has ${result.memberCount} machine${result.memberCount === 1 ? '' : 's'}.`,
  ];
}

/** `cluster forget`. */
export function renderForgotten(result: ForgetNodeResult): string[] {
  return [
    `removed ${printableName(result.displayName)} (${result.nodeId}) from the group`,
    `the group key was replaced immediately, so that machine's copy no longer works.`,
    `${result.memberCount} machine${result.memberCount === 1 ? '' : 's'} remain${result.memberCount === 1 ? 's' : ''}.`,
  ];
}

/** The groups seen advertising themselves on this network. */
export function renderDiscovered(groups: readonly DiscoveredGroup[], now: number): string[] {
  if (groups.length === 0) {
    return [
      'no goodvibes groups are advertising themselves on this network',
      '',
      'if the machine you want to join is switched on and has clustering enabled,',
      'check that both machines are on the same network and that it is not blocking',
      'multicast. You can also join by id directly: cluster join --group <id>, and give',
      'the key when asked (or pipe it in: echo "$JOIN_KEY" | cluster join --group <id> --key -)',
    ];
  }
  const width = Math.max(...groups.map((group) => printableName(group.displayName).length), 10);
  const lines = [`${pad('GROUP', width)}  ${pad('ID', 18)}  MACHINES  VERSION  SEEN`];
  for (const group of groups) {
    lines.push(
      `${pad(printableName(group.displayName), width)}  ${pad(printableName(group.groupId, 18), 18)}  ${pad(String(group.nodeCount), 8)}  `
        + `${pad(printableName(group.version, 7), 7)}  ${describeAge(group.lastSeenAt, now)}`,
    );
  }
  return lines;
}

/**
 * Ask the terminal to put the join key on the clipboard, using OSC 52.
 *
 * OSC 52 is the only clipboard mechanism that works through SSH, which is the
 * case that matters: the operator is on a headless box in a cupboard. It is
 * also not universally supported and gives no acknowledgement, so this NEVER
 * claims success, it says what it attempted, and the key is printed either
 * way. Silently doing nothing would be the worst of the three options.
 *
 * The introducer and the terminator are written as `\x1b` and `\x07` rather
 * than as the bytes themselves: a literal control character in source survives
 * nothing, not a copy between files, not an editor, not a diff, and without
 * them this returns a printable string a terminal shows to the operator
 * instead of an escape sequence it acts on.
 */
export function clipboardEscapeSequence(value: string): string {
  // The introducer and terminator are spelled as escapes, not written as raw
  // control bytes: a literal ESC/BEL in source survives nothing that treats the
  // file as text, and a sequence missing either one is not an escape sequence
  // at all, it is the payload printed to the screen.
  return `\u001b]52;c;${Buffer.from(value, 'utf8').toString('base64')}\u0007`;
}

export interface JoinKeyRendering {
  /** Lines to print. */
  readonly lines: string[];
  /** The raw escape sequence to write, or null when the output is not a terminal. */
  readonly clipboardSequence: string | null;
}

export function renderJoinKey(result: JoinKeyResult, isTerminal: boolean): JoinKeyRendering {
  return {
    lines: [
      `join key for "${result.groupName}"  [${result.groupId}]`,
      '',
      `  ${result.joinKey}`,
      '',
      ...(isTerminal
        ? ['copied to the clipboard, if this terminal accepts clipboard writes over its connection.',
          'if nothing was copied, the key is printed above.']
        : ['(not a terminal, so no clipboard copy was attempted)']),
      '',
      `to add a machine: run  cluster join --group ${result.groupId}  on it and give the key above when asked`,
      `(in a script, pipe it in: echo "$JOIN_KEY" | cluster join --group ${result.groupId} --key -)`,
    ],
    clipboardSequence: isTerminal ? clipboardEscapeSequence(result.joinKey) : null,
  };
}

/** `cluster rotate`. */
export function renderRotated(result: RotateKeyResult): string[] {
  return [
    `the group key is now generation ${result.keyGeneration}`,
    result.immediate
      ? 'the previous key stopped being accepted immediately, and the key the group signs with'
      : 'the previous key stays accepted for a few minutes so nothing is interrupted while',
    result.immediate
      ? 'was replaced too. A machine that is asleep right now takes the new key from the group when it wakes.'
      : `the other ${Math.max(0, result.memberCount - 1)} machine(s) pick the new one up.`,
    '',
    `accepting generation${result.acceptedGenerations.length === 1 ? '' : 's'} `
      + `${result.acceptedGenerations.join(' and ')}`,
  ];
}

/**
 * The join key as a QR code, for typing it into a phone or a second terminal.
 *
 * This reuses the platform's own QR renderer verbatim, the same one a pairing
 * flow already prints to a terminal, rather than introducing any new
 * machinery for it. Opt-in behind `--qr`, because a QR block is tall and most
 * of the time the operator is copying the key with the mouse or the clipboard.
 */
export function renderJoinKeyQr(joinKey: string): string[] {
  return [renderQrToString(generateQrMatrix(joinKey))];
}

/** A refusal, in the shape every failing subcommand prints. */
export function renderFailure(error: string, fix: string): string[] {
  return [`cluster: ${error}`, `  ${fix}`];
}
