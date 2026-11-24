/**
 * cluster-commands.ts, `goodvibes-daemon cluster …`, and a front-end's own
 * `/cluster` command.
 *
 * The authoritative surface for LAN groups. A homelab node is headless: the
 * operator SSHes in, and everything they can do to a group they must be able
 * to do here.
 *
 * This module contains NO logic of its own. It parses arguments, calls a
 * daemon verb over the convention in cluster-remote-daemon-target.ts, and
 * renders the answer. The daemon decides everything else, which is what
 * makes this command, a front-end's `/cluster`, and a web UI three renderings
 * of one implementation.
 *
 * Every failure exits non-zero with a plain-language message naming the fix.
 */
import { createInterface } from 'node:readline/promises';
import { askSecretOnStdin } from './cli-hidden-input.js';
import type { ConfigManager } from '@goodvibes/engine/platform/platform/config';
import type {
  RotateKeyResult,
  CreateGroupResult,
  DiscoveredGroup,
  ForgetNodeResult,
  GroupStatusReport,
  JoinGroupResult,
  JoinKeyResult,
  NodesResult,
  SettingDecisionResult,
} from '@goodvibes/engine/platform/platform/cluster';
import {
  callDaemonVerb,
  resolveRemoteDaemonTarget,
  type DaemonFailureCode,
  type DaemonFetch,
  type DaemonVerbOutcome,
} from './cluster-remote-daemon-target.js';
import { judgmentPort } from '@goodvibes/engine/errors';
import { clusterJoinGroup } from './batteries/cluster-join-group.js';
import { decisionOrClassic } from '@goodvibes/engine/platform/platform/runtime/decision-policy';
import {
  describeAge,
  printableName,
  printableText,
  renderCreated,
  renderDiscovered,
  renderFailure,
  renderForgotten,
  renderJoinKey,
  renderJoinKeyQr,
  renderJoined,
  renderNodes,
  renderRotated,
  renderStatus,
} from './cluster-render.js';

export const CLUSTER_SUBCOMMANDS = [
  'status', 'create', 'join', 'key', 'nodes', 'forget', 'rotate', 'leave', 'rename', 'groups', 'publish', 'accept',
] as const;
export type ClusterSubcommand = (typeof CLUSTER_SUBCOMMANDS)[number];

export function isClusterSubcommand(value: string | undefined): value is ClusterSubcommand {
  return typeof value === 'string' && (CLUSTER_SUBCOMMANDS as readonly string[]).includes(value);
}

/** What the parser produced, or why it could not. */
export interface ParsedClusterCommand {
  readonly subcommand: ClusterSubcommand | null;
  readonly positional: string | null;
  readonly name: string | null;
  readonly passphrase: string | null;
  readonly group: string | null;
  readonly key: string | null;
  readonly host: string | null;
  readonly port: number | null;
  readonly token: string | null;
  readonly json: boolean;
  readonly yes: boolean;
  /** `key` only: also render the join key as a QR code. */
  readonly qr: boolean;
  /** `rotate` only: stop accepting the outgoing key at once. */
  readonly now: boolean;
  readonly errors: readonly string[];
}

const VALUE_FLAGS = new Set(['--name', '--passphrase', '--group', '--key', '--host', '--port', '--token']);

/**
 * Parse `cluster <subcommand> [flags]`.
 *
 * Unknown flags are an ERROR rather than being ignored. A typo in `--group`
 * that silently became "no group given" would send the operator to the
 * interactive picker with no explanation of why their arguments vanished.
 */
export function parseClusterCommand(argv: readonly string[]): ParsedClusterCommand {
  const errors: string[] = [];
  let subcommand: ClusterSubcommand | null = null;
  let positional: string | null = null;
  const values = new Map<string, string>();
  let json = false;
  let yes = false;
  let qr = false;
  let now = false;

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index] ?? '';
    if (token === '--json') { json = true; continue; }
    if (token === '-y' || token === '--yes') { yes = true; continue; }
    if (token === '--qr') { qr = true; continue; }
    if (token === '--now') { now = true; continue; }
    if (VALUE_FLAGS.has(token)) {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith('--')) {
        errors.push(`${token} needs a value`);
        continue;
      }
      values.set(token, value);
      index += 1;
      continue;
    }
    const inline = /^(--[a-z]+)=(.*)$/.exec(token);
    if (inline && VALUE_FLAGS.has(inline[1] ?? '')) {
      values.set(inline[1] as string, inline[2] ?? '');
      continue;
    }
    if (token.startsWith('-')) {
      errors.push(`'${token}' is not a flag this command understands`);
      continue;
    }
    if (subcommand === null) {
      if (!isClusterSubcommand(token)) {
        errors.push(`'${token}' is not a cluster command, try one of: ${CLUSTER_SUBCOMMANDS.join(', ')}`);
        continue;
      }
      subcommand = token;
      continue;
    }
    if (positional === null) {
      positional = token;
      continue;
    }
    errors.push(`'${token}' is one argument too many`);
  }

  const portText = values.get('--port');
  let port: number | null = null;
  if (portText !== undefined) {
    const parsed = Number(portText);
    if (!Number.isInteger(parsed) || parsed <= 0 || parsed > 65_535) {
      errors.push(`--port must be a number between 1 and 65535, not '${portText}'`);
    } else {
      port = parsed;
    }
  }
  if (subcommand === 'forget' && positional === null) {
    errors.push('forget needs the machine to remove, run `cluster nodes` to see them');
  }
  if ((subcommand === 'publish' || subcommand === 'accept') && positional === null) {
    errors.push(`${subcommand} needs the shared setting it is about, run \`cluster status\` to see which differ here`);
  }
  if (subcommand === 'rename' && positional === null && values.get('--name') === undefined) {
    errors.push('rename needs the new name, `cluster rename "the workshop"`');
  }

  return {
    subcommand,
    positional,
    name: values.get('--name') ?? null,
    passphrase: values.get('--passphrase') ?? null,
    group: values.get('--group') ?? null,
    key: values.get('--key') ?? null,
    host: values.get('--host') ?? null,
    port,
    token: values.get('--token') ?? null,
    json,
    yes,
    qr,
    now,
    errors,
  };
}

/** What the caller prints and exits with. */
export interface ClusterCommandResult {
  readonly lines: readonly string[];
  readonly exitCode: number;
  /** Written raw to stdout, the OSC 52 clipboard attempt, when there is one. */
  readonly rawOutput?: string | undefined;
}

export interface RunClusterCommandInput {
  readonly argv: readonly string[];
  readonly configManager: Pick<ConfigManager, 'get'>;
  readonly daemonHomeDir: string;
  readonly now?: (() => number) | undefined;
  readonly isTerminal?: boolean | undefined;
  /** Asks the daemon with the configured outbound TLS trust (`createNetworkFetch`); never the bare global fetch. */
  readonly fetchImpl: DaemonFetch;
  readonly readToken?: ((daemonHomeDir: string) => string | undefined) | undefined;
  /** The client's home, whose per-origin record holds the tokens for other daemons (a terminal app's `/cluster`). */
  readonly homeDirectory?: string | undefined;
  /** Injected in tests; the real one reads stdin. */
  readonly prompt?: ((question: string) => Promise<string>) | undefined;
  /** Like `prompt`, for a secret: the real one does not echo what is typed. Defaults to `prompt` when that is injected. */
  readonly promptSecret?: ((question: string) => Promise<string>) | undefined;
  /**
   * Reads everything piped to standard input, for a secret given as `-`
   * (`--key -`, `--passphrase -`, `--token -`) or a join key piped to `cluster join`.
   * Absent where standard input is not the command's own (a terminal app's `/cluster`).
   */
  readonly readStdin?: (() => Promise<string>) | undefined;
  /** Whether standard input is a terminal; a secret is read from it only when something is piped in. */
  readonly stdinIsTty?: boolean | undefined;
}

/** The flags whose value `-` means the first line of standard input, so the secret stays off the command line. */
const STDIN_SECRET_FLAGS = ['key', 'passphrase', 'token'] as const;

/** The first line of what was piped in, without its line ending. */
function firstLine(text: string): string {
  return (text.split(/\r?\n/, 1)[0] ?? '').trim();
}

/**
 * Replaces a secret given as `-` with the first line of standard input. At most
 * one flag can take it, and only when something is piped in.
 */
async function readStdinSecrets(parsed: ParsedClusterCommand, input: RunClusterCommandInput): Promise<ParsedClusterCommand | string> {
  const fromStdin = STDIN_SECRET_FLAGS.filter((flag) => parsed[flag] === '-');
  if (fromStdin.length === 0) return parsed;
  if (fromStdin.length > 1) return `only one of ${fromStdin.map((flag) => `--${flag}`).join(', ')} can be read from standard input`;
  const flag = fromStdin[0]!;
  if (!input.readStdin || input.stdinIsTty === true) {
    return `--${flag} - reads the ${flag} from standard input, and nothing is piped in; pipe it in, or leave --${flag} out to be asked without it showing`;
  }
  const value = firstLine(await input.readStdin());
  if (!value) return `--${flag} - read nothing from standard input; pipe the ${flag} in as its first line`;
  return { ...parsed, [flag]: value };
}

/**
 * Why a cluster command failed, for a script or an agent: the daemon call's
 * codes, plus the refusals this command makes before calling anything.
 */
export type ClusterFailureCode = DaemonFailureCode | 'usage' | 'not-confirmed' | 'not-interactive' | 'no-group-found';

function failure(code: ClusterFailureCode, error: string, fix: string, json: boolean): ClusterCommandResult {
  return {
    lines: json
      ? [JSON.stringify({ ok: false, code, error, fix }, null, 2)]
      : renderFailure(error, fix),
    exitCode: 1,
  };
}

function refused(outcome: { readonly code: DaemonFailureCode; readonly error: string; readonly fix: string }, json: boolean): ClusterCommandResult {
  return failure(outcome.code, outcome.error, outcome.fix, json);
}

/**
 * Every string in a daemon's answer made printable, in one walk. Group and
 * machine names, reasons and the daemon's own refusal text are chosen by
 * other machines on the network; stripping them here, where the answer
 * enters, means no renderer and no `--json` line can print them raw.
 */
function printableAnswer<T>(value: T): T {
  if (typeof value === 'string') return printableText(value) as T;
  if (Array.isArray(value)) return value.map((item: unknown) => printableAnswer(item)) as T;
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) out[key] = printableAnswer(item);
    return out as T;
  }
  return value;
}

function success(data: unknown, lines: readonly string[], json: boolean, rawOutput?: string): ClusterCommandResult {
  return {
    lines: json ? [JSON.stringify({ ok: true, data }, null, 2)] : lines,
    exitCode: 0,
    ...(rawOutput ? { rawOutput } : {}),
  };
}

/** Ask a question on stdin. Only ever called when stdin is a terminal. */
async function askOnStdin(question: string, toStderr = false): Promise<string> {
  // With --json the answer goes to stdout as one JSON document, so the questions go to stderr.
  const rl = createInterface({ input: process.stdin, output: toStderr ? process.stderr : process.stdout });
  try {
    return (await rl.question(question)).trim();
  } finally {
    rl.close();
  }
}

/**
 * What a verb is about to do that cannot be undone, or null for one that can be
 * repeated safely. The CLI asks with it at the terminal; `/cluster` asks with it
 * through the slash-command confirmation.
 */
export function describeIrreversibleClusterCommand(parsed: ParsedClusterCommand): string | null {
  switch (parsed.subcommand) {
    case 'leave': return 'this removes this machine from its group';
    case 'forget': return `this removes ${parsed.positional ?? 'that machine'} from the group and replaces the group key immediately`;
    case 'rotate': return parsed.now ? 'this stops accepting the old group key immediately, so any machine that has not picked up the new one is cut off' : null;
    case 'publish': return parsed.positional?.startsWith('user:')
      ? `this makes this machine's account of ${parsed.positional.slice('user:'.length)} the group's and ends the other accounts of that name, with their sign-ins`
      : `this replaces ${parsed.positional ?? 'that setting'} on every machine in the group with this machine's value`;
    case 'accept': return parsed.positional?.startsWith('user:')
      ? `this gives up this machine's account of ${parsed.positional.slice('user:'.length)} for the group's, ending its sign-ins`
      : `this replaces this machine's value of ${parsed.positional ?? 'that setting'} with the group's`;
    default: return null;
  }
}

export async function runClusterCommand(input: RunClusterCommandInput): Promise<ClusterCommandResult> {
  const typed = parseClusterCommand(input.argv);
  if (typed.errors.length > 0) {
    return failure('usage', typed.errors[0] as string, `usage: goodvibes-daemon cluster <${CLUSTER_SUBCOMMANDS.join('|')}>`, typed.json);
  }
  const withSecrets = await readStdinSecrets(typed, input);
  if (typeof withSecrets === 'string') {
    return failure('usage', withSecrets, 'echo "$JOIN_KEY" | goodvibes-daemon cluster join --group <id> --key -', typed.json);
  }
  const parsed = withSecrets;
  if (!parsed.subcommand) {
    return failure(
      'usage',
      'no cluster command was given',
      `usage: goodvibes-daemon cluster <${CLUSTER_SUBCOMMANDS.join('|')}>`,
      parsed.json,
    );
  }

  const resolved = resolveRemoteDaemonTarget({
    flags: {
      ...(parsed.host !== null ? { host: parsed.host } : {}),
      ...(parsed.port !== null ? { port: parsed.port } : {}),
      ...(parsed.token !== null ? { token: parsed.token } : {}),
    },
    configManager: input.configManager,
    daemonHomeDir: input.daemonHomeDir,
    ...(input.readToken ? { readToken: input.readToken } : {}),
    ...(input.homeDirectory ? { homeDirectory: input.homeDirectory } : {}),
  });
  if (!resolved.ok) return refused(resolved, parsed.json);

  const now = input.now?.() ?? Date.now();
  const isTerminal = input.isTerminal ?? Boolean(process.stdout.isTTY);
  const call = async <T>(path: string, method: 'GET' | 'POST' = 'GET', body?: unknown): Promise<DaemonVerbOutcome<T>> =>
    printableAnswer(await callDaemonVerb<T>(resolved.target, path, { method, ...(body === undefined ? {} : { body }) }, input.fetchImpl));

  /**
   * A group action the daemon refuses because sharing is off: the one ask,
   * opening on No (it changes how the daemon takes work), then the same action
   * again with the owner's yes, which the daemon keeps, turns sharing on for and
   * finishes after it restarts. --yes is the same answer for a script.
   */
  const callTurningSharingOn = async <T>(path: string, body: Record<string, unknown>): Promise<DaemonVerbOutcome<T>> => {
    const first = await call<T>(path, 'POST', body);
    if (first.ok || first.daemonCode !== 'CLUSTER_SHARING_OFF') return first;
    const canAsk = input.prompt !== undefined || (isTerminal && Boolean(process.stdin.isTTY) && !parsed.json);
    const yes = parsed.yes || (canAsk && /^y(es)?$/i.test(await (input.prompt ?? ((question: string) => askOnStdin(question, parsed.json)))(
      `${ACTION_TURN_ON_SHARING_QUESTION} [y/N] `)));
    if (!yes) return first;
    return call<T>(path, 'POST', { ...body, turnOnSharing: true });
  };
  /** A kept action says what happens next (the restart, or why the person restarts it), not a result it does not have yet. */
  const pendingLines = (data: { readonly pending?: true; readonly warning?: string }): readonly string[] | null =>
    data.pending === true ? [data.warning ?? 'Sharing is on; this finishes when the daemon next starts.'] : null;

  const irreversible = describeIrreversibleClusterCommand(parsed);
  if (irreversible !== null && !parsed.yes) {
    // Only a person at a terminal can be asked; a script, a --json run or a slash command must say --yes.
    const answer = isTerminal && !parsed.json
      ? (await (input.prompt ?? askOnStdin)(`${irreversible}. Type yes to continue: `)).toLowerCase()
      : '';
    if (answer !== 'yes') {
      return failure(
        'not-confirmed',
        `cluster ${parsed.subcommand} was not run: ${irreversible}, and it was not confirmed`,
        `nothing was changed. Run it again with --yes to confirm: cluster ${parsed.subcommand}${parsed.positional ? ` ${parsed.positional}` : ''}${parsed.now ? ' --now' : ''} --yes`,
        parsed.json,
      );
    }
  }

  switch (parsed.subcommand) {
    case 'status': {
      const result = await call<GroupStatusReport>('/api/cluster/status');
      return result.ok
        ? success(result.data, renderStatus(result.data, now), parsed.json)
        : refused(result, parsed.json);
    }
    case 'nodes': {
      const result = await call<NodesResult>('/api/cluster/nodes');
      return result.ok
        ? success(result.data, renderNodes(result.data, now), parsed.json)
        : refused(result, parsed.json);
    }
    case 'groups': {
      const result = await call<readonly DiscoveredGroup[]>('/api/cluster/groups');
      return result.ok
        ? success(result.data, renderDiscovered(result.data, now), parsed.json)
        : refused(result, parsed.json);
    }
    case 'key': {
      const result = await call<JoinKeyResult>('/api/cluster/key');
      if (!result.ok) return refused(result, parsed.json);
      const rendered = renderJoinKey(result.data, isTerminal && !parsed.json);
      const lines = parsed.qr
        ? [...rendered.lines, '', ...renderJoinKeyQr(result.data.joinKey)]
        : rendered.lines;
      return success(result.data, lines, parsed.json, rendered.clipboardSequence ?? undefined);
    }
    case 'create': {
      const result = await call<CreateGroupResult>('/api/cluster/create', 'POST', {
        ...(parsed.name !== null ? { name: parsed.name } : {}),
        ...(parsed.passphrase !== null ? { passphrase: parsed.passphrase } : {}),
      });
      return result.ok
        ? success(result.data, renderCreated(result.data), parsed.json)
        : refused(result, parsed.json);
    }
    case 'rotate': {
      const result = await callTurningSharingOn<RotateKeyResult>('/api/cluster/rotate', { immediate: parsed.now });
      return result.ok
        ? success(result.data, pendingLines(result.data) ?? renderRotated(result.data), parsed.json)
        : refused(result, parsed.json);
    }
    case 'leave': {
      const result = await call<{ groupId: string; groupName: string }>('/api/cluster/leave', 'POST');
      return result.ok
        ? success(result.data, [`left "${result.data.groupName}" [${result.data.groupId}]`,
          'this machine no longer coordinates with it. The other machines still list it,',
          'run `cluster forget` on one of them to tidy up.'], parsed.json)
        : refused(result, parsed.json);
    }
    case 'rename': {
      const name = parsed.name ?? parsed.positional ?? '';
      const result = await callTurningSharingOn<{ groupId: string; groupName: string; pending?: true; warning?: string }>('/api/cluster/rename', { name });
      return result.ok
        ? success(result.data, pendingLines(result.data) ?? [`the group is now called "${result.data.groupName}"`,
          'this name is visible to anything on this network, and every machine in the',
          'group will pick it up shortly.'], parsed.json)
        : refused(result, parsed.json);
    }
    case 'publish':
    case 'accept': {
      const result = await callTurningSharingOn<SettingDecisionResult>(`/api/cluster/${parsed.subcommand}`, { path: parsed.positional });
      if (!result.ok) return refused(result, parsed.json);
      const kept = pendingLines(result.data);
      if (kept !== null) return success(result.data, kept, parsed.json);
      const user = result.data.path.startsWith('user:') ? result.data.path.slice('user:'.length) : null;
      const said = user !== null
        ? (result.data.decision === 'accepted'
          ? `this machine's account of "${user}" was given up; the group's account is the one on every machine now, and sign-ins of the account given up end`
          : `this machine's account of "${user}" is the group's on every machine now; sign-ins of the other accounts of that name end`)
        : result.data.decision === 'accepted'
        ? `this machine now runs the group's value of ${result.data.path}`
        : result.data.decision === 'held'
          ? `this machine's value of ${result.data.path} is held and sent to the group once this machine has the group's settings`
          : `this machine's value of ${result.data.path} was sent to every machine in the group`;
      return success(result.data, [said], parsed.json);
    }
    case 'forget': {
      const result = await callTurningSharingOn<ForgetNodeResult>('/api/cluster/forget', { nodeId: parsed.positional });
      return result.ok
        ? success(result.data, pendingLines(result.data) ?? renderForgotten(result.data), parsed.json)
        : refused(result, parsed.json);
    }
    case 'join':
      return runJoin(parsed, call, now, input, isTerminal, parsed !== typed);
  }
}

/**
 * `cluster join`.
 *
 * Two shapes, and both matter. With `--group` and the key piped in (`--key -`,
 * or `--key` left out with standard input piped) it is a scriptable one-liner,
 * which is what provisioning a machine from a config-management tool needs. Without them it lists the groups advertising themselves on this
 * network and asks, which is what a person adding their second machine needs,
 * because they do not know the group id and should not have to.
 */
async function runJoin(
  parsed: ParsedClusterCommand,
  call: <T>(path: string, method?: 'GET' | 'POST', body?: unknown) => Promise<DaemonVerbOutcome<T>>,
  now: number,
  input: RunClusterCommandInput,
  isTerminal: boolean,
  stdinTaken: boolean,
): Promise<ClusterCommandResult> {
  let groupId = parsed.group;
  let joinKey = parsed.key;

  // A join key piped in is read from standard input, so it never sits on the command line.
  // Not when another secret was already read from it with `-`.
  if (groupId !== null && joinKey === null && !stdinTaken && input.prompt === undefined && input.readStdin && input.stdinIsTty === false) {
    joinKey = firstLine(await input.readStdin());
    if (!joinKey) {
      return failure('usage', 'no join key was given and standard input held none',
        'pipe the join key in: echo "$JOIN_KEY" | cluster join --group <id> --key -', parsed.json);
    }
  }

  if (groupId === null || joinKey === null) {
    const interactive = input.prompt !== undefined || (isTerminal && Boolean(process.stdin.isTTY));
    if (!interactive) {
      return failure(
        'not-interactive',
        'a group and a join key are both needed, and this is not an interactive terminal',
        'pipe the key in: echo "$JOIN_KEY" | cluster join --group <id> --key - (or, less safely, --key <join key>, which shows it to other users of this machine)',
        parsed.json,
      );
    }
    const ask = input.prompt ?? ((question: string) => askOnStdin(question, parsed.json));
    const askSecret = input.promptSecret ?? input.prompt ?? ((question: string) => askSecretOnStdin(question, parsed.json));

    if (groupId === null) {
      const found = await call<readonly DiscoveredGroup[]>('/api/cluster/groups');
      if (!found.ok) return refused(found, parsed.json);
      if (found.data.length === 0) {
        return failure(
          'no-group-found',
          'no goodvibes groups are advertising themselves on this network',
          'check the other machine is switched on with clustering enabled, or join by id: '
            + 'echo "$JOIN_KEY" | cluster join --group <id> --key -',
          parsed.json,
        );
      }
      const listing = renderDiscovered(found.data, now);
      for (const line of listing) (parsed.json ? process.stderr : process.stdout).write(`${line}\n`);
      const answer = await ask('\nwhich group? (name or id, blank to cancel): ');
      if (answer.length === 0) return { lines: ['cancelled'], exitCode: 130 };
      const chosen = found.data.find((group) => group.groupId === answer)
        ?? uniqueIdPrefix(found.data, answer)
        ?? await readJoinGroup(answer, found.data, now);
      if (!chosen) {
        return failure('no-group-found', `no group on this network matches '${answer}'`, 'run `cluster groups` to see them again', parsed.json);
      }
      groupId = chosen.groupId;
    }

    if (joinKey === null) {
      joinKey = await askSecret('join key (run `cluster key` on a machine already in the group): ');
      if (joinKey.length === 0) return { lines: ['cancelled'], exitCode: 130 };
    }
  }

  let result = await call<JoinGroupResult>('/api/cluster/join', 'POST', { groupId, joinKey });
  if (!result.ok && result.daemonCode === 'CLUSTER_SHARING_OFF') {
    // Sharing is off on this machine: one ask, opening on No (it changes how the daemon takes work).
    // --yes is the same answer for a script; a run that cannot ask says how to give it.
    const canAsk = input.prompt !== undefined || (isTerminal && Boolean(process.stdin.isTTY) && !parsed.json);
    const yes = parsed.yes || (canAsk && /^y(es)?$/i.test(await (input.prompt ?? ((question: string) => askOnStdin(question, parsed.json)))(
      `${JOIN_TURN_ON_SHARING_QUESTION} [y/N] `)));
    if (!yes) return refused(result, parsed.json);
    result = await call<JoinGroupResult>('/api/cluster/join', 'POST', { groupId, joinKey, turnOnSharing: true });
  }
  return result.ok
    ? success(result.data, renderJoined(result.data), parsed.json)
    : refused(result, parsed.json);
}

/** The one ask a join puts when sharing is off on this machine; it opens on No. */
export const JOIN_TURN_ON_SHARING_QUESTION = 'Sharing inbound work with your other machines is off on this machine. Turn it on, so this machine takes work with the group? The daemon restarts to bring the group up.';
/** The same ask for forget, rotate, rename, publish and accept, which need the group up; it opens on No. */
export const ACTION_TURN_ON_SHARING_QUESTION = 'Sharing inbound work with your other machines is off on this machine, so this cannot reach the group. Turn it on, so this machine takes work with the group? The daemon restarts to bring the group up, and this finishes then.';

/** The decision site the join group reading is logged under. */
export const CLUSTER_JOIN_GROUP_SITE = 'terminal-shell.cluster-join';

/** A prefix that starts exactly one group's id abbreviates that id, the way a short commit hash does. */
function uniqueIdPrefix(groups: readonly DiscoveredGroup[], answer: string): DiscoveredGroup | undefined {
  const matches = groups.filter((group) => group.groupId.startsWith(answer));
  return matches.length === 1 ? matches[0] : undefined;
}

/**
 * Which group a typed name or description refers to: the
 * `terminal-shell.cluster-join-group` reading, taken only when it acts.
 */
async function readJoinGroup(answer: string, groups: readonly DiscoveredGroup[], now: number): Promise<DiscoveredGroup | undefined> {
  return decisionOrClassic(() => readDecisionJoinGroup(answer, groups, now), () => {
    const matches = groups.filter(group => group.groupId === answer || group.displayName === answer);
    return matches.length === 1 ? matches[0] : undefined;
  });
}
async function readDecisionJoinGroup(answer: string, groups: readonly DiscoveredGroup[], now: number): Promise<DiscoveredGroup | undefined> {
  const candidates = groups.map((group) => ({
    id: group.groupId,
    content: {
      groupId: group.groupId,
      displayName: printableName(group.displayName),
      machines: group.nodeCount,
      version: group.version,
      seen: describeAge(group.lastSeenAt, now),
    },
  }));
  const selection = await clusterJoinGroup.select(judgmentPort(CLUSTER_JOIN_GROUP_SITE), { answer }, candidates, { site: CLUSTER_JOIN_GROUP_SITE });
  const picked = selection.outcome === 'act' ? groups.find((group) => group.groupId === selection.chosen) : undefined;
  selection.recordAction(picked === undefined ? 'no group taken' : `joining ${picked.groupId}`);
  return picked;
}
