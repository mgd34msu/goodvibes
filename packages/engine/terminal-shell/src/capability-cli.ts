/**
 * capability-cli.ts, the script form of find and run, the same in every
 * program's command line (`goodvibes`, `goodvibes-agent`, `goodvibes-daemon`):
 *
 *   <program> do <capability id> [--input key=value ...] [--output json]
 *   <program> find "<words>" [--output json]
 *
 * Both are the daemon's methods (`capabilities.run`, `capabilities.find`),
 * called with this program's daemon credential. A command a person typed at
 * a terminal is the request, so `do` runs at once, carrying the person's
 * claim, which the daemon keeps only from a person's credential; an act that
 * weakens a protection, cannot be undone, spends money, writes a secret or is
 * the owner's own is first asked once at the terminal device, opening on No
 * (capability-cli-confirm.ts; no flag skips it); a process
 * with no controlling terminal (cron, a service) or a command a model's command
 * tool ran carries no claim, and its call is decided by the daemon under the
 * owner's mode (`personAtTerminal`). A
 * capability that acts on a conversation is refused in one line: it needs a
 * program holding a conversation.
 *
 * A credential that cannot state a person asked (a token minted for
 * automation) has its call put to the owner: `do` says so with the
 * approval's id and exits 3, and `<program> do <approval id>` reads what
 * came of it (3 again while he has not answered).
 *
 * Exit codes (docs/exit-codes.md): 0 done, 1 it ran and did not succeed (a
 * refusal included), 2 the command line was wrong, 3 waiting for the owner.
 */
import { closeSync, openSync } from 'node:fs';
import { resolveGoodVibesDaemonHome } from '@goodvibes/engine/platform/platform/config/goodvibes-home';
import { createNetworkFetch } from '@goodvibes/engine/platform/platform/runtime/network/outbound';
import type { ConfigManager } from '@goodvibes/engine/platform/platform/config';
import { callDaemonMethod } from './raw-reply-route.js';
import { cliWithFileWorkHere } from './bundle-file-work.js';
import { configuredDaemonIsThisMachine } from '@goodvibes/engine/platform/platform/runtime/client/daemon-target-resolver';
import { resolveRemoteDaemonTarget, type DaemonFetch } from './cluster-remote-daemon-target.js';
import { CAPABILITY_DO_USAGE, CAPABILITY_FIND_USAGE, type CapabilityCliVerb } from './capability-cli-help.js';
import { askAtTerminal, doQuestion } from './capability-cli-confirm.js';

/**
 * The mark a model's command tool puts on every command it runs (platform tools/exec/model-command-mark.ts, the same
 * name; written here so `do` does not load the tool modules to read one name).
 */
const MODEL_COMMAND_MARK = 'GOODVIBES_COMMAND_FROM_MODEL';

export { CAPABILITY_CLI_HELP, CAPABILITY_CLI_VERBS, CAPABILITY_DO_USAGE, CAPABILITY_FIND_USAGE, type CapabilityCliVerb } from './capability-cli-help.js';

/** One call of a daemon method, as the program reaches its daemon: the answer, or the refusal in words. */
export type CapabilityCliInvoke = (methodId: string, input: Record<string, unknown>, options: { readonly explicitUserRequest: boolean }) =>
  Promise<{ readonly ok: true; readonly data: unknown } | { readonly ok: false; readonly code: string; readonly error: string; readonly fix: string }>;

export interface CapabilityCliInput {
  readonly program: string;
  readonly verb: CapabilityCliVerb;
  /** The words after the verb, options included. */
  readonly args: readonly string[];
  readonly json: boolean;
  readonly invoke: CapabilityCliInvoke;
  /** The project the capability acts on (a hooks file, a project secret store). */
  readonly workingDirectory: string;
  readonly caller?: 'tui' | 'agent' | undefined;
  /** The command a refusal is said under, when another form runs `do` for the person (`goodvibes support-bundle`). */
  readonly said?: string | undefined;
  readonly stdout: (text: string) => void;
  readonly stderr: (text: string) => void;
  /** Whether a person is at a terminal typing this: read from the process when not given (personAtTerminal). */
  readonly personAtTerminal?: boolean | undefined;
}

/**
 * Whether the process has a controlling terminal: it can open the terminal device (`/dev/tty` opens only for a
 * process with one, whatever its standard input is). A cron job, a service, a process started without a terminal has
 * none. Windows has no such device: there the console streams say it.
 */
function hasControllingTerminal(): boolean {
  if (process.platform === 'win32') return process.stdin.isTTY === true || process.stdout.isTTY === true;
  try {
    closeSync(openSync('/dev/tty', 'r'));
    return true;
  } catch {
    return false;
  }
}

/**
 * Whether `do` may say a person asked: when the process has a controlling terminal (a person at a terminal, whether or
 * not its standard input is a pipe: `echo x | goodvibes do ...` typed by a person is still the person) and carries no
 * mark of a model's command tool (which marks every command it runs, MODEL_COMMAND_MARK, also one it gives a
 * pseudo-terminal of its own). Without a terminal (cron, a service, a model's command) the call is an outside caller's,
 * decided by the daemon under the owner's mode.
 */
function personAtTerminal(input: Pick<CapabilityCliInput, 'personAtTerminal'>): boolean {
  if (input.personAtTerminal !== undefined) return input.personAtTerminal;
  const marked = process.env[MODEL_COMMAND_MARK];
  return (marked === undefined || marked === '') && hasControllingTerminal();
}

interface FoundRow {
  readonly id: string;
  readonly does: string;
  readonly runsIn: string;
  readonly risk: string;
  readonly inputs: readonly { readonly name: string; readonly kind: string; readonly required: boolean; readonly choices?: readonly string[] | undefined; readonly default?: string | undefined }[];
}

function usage(input: CapabilityCliInput, problem: string): number {
  const line = input.verb === 'do' ? CAPABILITY_DO_USAGE : CAPABILITY_FIND_USAGE;
  if (input.json) input.stdout(JSON.stringify({ ok: false, code: 'PARSE_ERROR', error: problem, fix: `Usage: ${input.program} ${line}` }));
  else { input.stderr(`${input.program} ${input.verb}: ${problem}`); input.stderr(`Usage: ${input.program} ${line}`); }
  return 2;
}

/** `--input key=value` pairs (also `--input=key=value`); a repeated key is joined with a newline, as a repeating option is. */
function parseDoArgs(args: readonly string[]): { readonly id: string; readonly inputs: Record<string, string> } | { readonly problem: string } {
  let id: string | undefined;
  const inputs: Record<string, string> = {};
  for (let index = 0; index < args.length; index += 1) {
    const word = args[index]!;
    let pair: string | undefined;
    if (word === '--input' || word === '-i') {
      pair = args[index + 1];
      index += 1;
      if (pair === undefined) return { problem: '--input needs key=value after it' };
    } else if (word.startsWith('--input=')) {
      pair = word.slice('--input='.length);
    } else if (word.startsWith('-')) {
      return { problem: `${word} is not an option of do; it takes --input key=value` };
    } else if (id === undefined) {
      id = word;
      continue;
    } else {
      return { problem: `unexpected word "${word}": give each input as --input key=value` };
    }
    const eq = pair.indexOf('=');
    if (eq <= 0) return { problem: `--input ${pair} is not key=value` };
    const key = pair.slice(0, eq).trim();
    const value = pair.slice(eq + 1);
    inputs[key] = inputs[key] === undefined ? value : `${inputs[key]}\n${value}`;
  }
  if (!id) return { problem: 'name the capability to run (capability ids come from find)' };
  return { id, inputs };
}

function failure(input: CapabilityCliInput, outcome: { readonly error: string; readonly fix: string; readonly code: string }): number {
  if (input.json) input.stdout(JSON.stringify({ ok: false, code: outcome.code, error: outcome.error, fix: outcome.fix }));
  else input.stderr(`${input.said ?? `${input.program} ${input.verb}`}: ${outcome.error}${outcome.fix ? `\n  ${outcome.fix}` : ''}`);
  return 1;
}

function inputLine(entry: FoundRow['inputs'][number]): string {
  const choices = entry.choices && entry.choices.length > 0 ? ` (${entry.choices.join('|')})` : '';
  const optional = entry.required ? '' : entry.default ? `, default ${entry.default}` : ', optional';
  return `--input ${entry.name}=<${entry.kind}>${choices}${optional}`;
}

export async function runCapabilityCli(input: CapabilityCliInput): Promise<number> {
  if (input.verb === 'find') {
    if (input.args.some((word) => word.startsWith('--'))) return usage(input, 'find takes only the words of what you need (and --output json)');
    const need = input.args.join(' ').trim();
    if (!need) return usage(input, 'say what you need in words');
    const outcome = await input.invoke('capabilities.find', { need }, { explicitUserRequest: false });
    if (!outcome.ok) return failure(input, outcome);
    const data = outcome.data as { readonly group: string; readonly groupChosenBy: string; readonly capabilities: readonly FoundRow[] };
    if (input.json) { input.stdout(JSON.stringify({ ok: true, ...data })); return 0; }
    const lines = [`In ${data.group}:`];
    for (const found of data.capabilities) {
      lines.push(`  ${found.id}  ${found.does}${found.runsIn === 'daemon' ? '' : found.runsIn === 'session' ? ' (in a conversation)' : ' (in a terminal program)'}${found.risk !== 'none' ? `  [${found.risk}]` : ''}`);
      for (const entry of found.inputs) lines.push(`      ${inputLine(entry)}`);
    }
    lines.push(`Run one: ${input.program} do <id> --input name=value`);
    input.stdout(lines.join('\n'));
    return 0;
  }
  const parsed = parseDoArgs(input.args);
  if ('problem' in parsed) return usage(input, parsed.problem);
  // An approval's id in place of a capability's: what came of a call that waited for the owner.
  const held = HELD_CALL_ID.test(parsed.id);
  if (held && Object.keys(parsed.inputs).length > 0) return usage(input, `${parsed.id} is a call that waited for the owner: it takes no --input`);
  // A command a person typed at a terminal is the request, a pipe into it included. Anything else (no controlling
  // terminal, or a command a model's command tool ran) is an outside caller's call, decided by the daemon under the
  // owner's mode (personAtTerminal).
  const person = personAtTerminal(input);
  // At a terminal, an act that weakens a protection, cannot be undone, spends money, writes a secret or is the owner's
  // own is asked once, as a place asks it, at the terminal device itself, opening on No (capability-cli-confirm.ts):
  // a script someone else left for the person's shell cannot do it unseen. No flag skips it.
  if (person && !held && input.personAtTerminal === undefined) {
    const question = await doQuestion(parsed.id, parsed.inputs);
    if (question !== undefined && !askAtTerminal(question)) {
      return failure(input, { code: 'NOT_CONFIRMED', error: `${parsed.id} was not run: it was not answered yes at the terminal. Nothing ran.`,
        fix: 'Run it again and type y at the question, or do it from its place in the program.' });
    }
  }
  const outcome = await input.invoke('capabilities.run', held ? { approvalId: parsed.id } : {
    id: parsed.id, inputs: parsed.inputs, workingDirectory: input.workingDirectory, ...(input.caller ? { program: input.caller } : {}),
  }, { explicitUserRequest: person });
  if (!outcome.ok) return failure(input, outcome);
  const data = outcome.data as { readonly text?: string; readonly code?: string; readonly approvalId?: string; readonly state?: string };
  // Put to the owner (a credential that cannot state a person asked): nothing ran yet, and the outcome is read by its id.
  if (data.code === 'OWNER_APPROVAL_PENDING' && typeof data.approvalId === 'string') {
    const read = `${input.program} do ${data.approvalId}`;
    if (input.json) input.stdout(JSON.stringify({ ok: false, ...(outcome.data as object), fix: `Read what came of it: ${read}` }));
    else input.stdout(`${data.state ?? `Waiting for the owner (${data.approvalId}).`}.\n  Read what came of it: ${read}`);
    return 3;
  }
  if (input.json) input.stdout(JSON.stringify({ ok: true, ...(outcome.data as object) }));
  else {
    // A value the person must see once (a capability's `reveals`) comes back only to the person who typed the line:
    // it is printed for him on its own line, with what it is, after the capability's words.
    const reveal = (outcome.data as { readonly reveal?: { readonly label?: unknown; readonly value?: unknown; readonly note?: unknown } }).reveal;
    const shown = reveal && typeof reveal.value === 'string'
      ? ['', `${typeof reveal.label === 'string' ? reveal.label : 'Shown once'}:`, reveal.value, ...(typeof reveal.note === 'string' ? [reveal.note] : [])]
      : [];
    input.stdout([data.text || `${parsed.id}: done.`, ...shown].join('\n'));
  }
  return 0;
}

/** The id of a question the daemon put to the owner (`approval-` and eight hex digits); a capability id has a dot. */
const HELD_CALL_ID = /^approval-[0-9a-f]{8}$/;

/** The invoke of a program that reaches its daemon by address and operator token (the terminal app, the daemon's own command line). */
export function daemonTargetInvoke(runtime: {
  readonly configManager: ConfigManager;
  readonly homeDirectory: string;
  readonly daemonHomeDirectory?: string | undefined;
}, target: {
  readonly fetchImpl?: DaemonFetch | undefined;
  /** --host, --port and --token, where the program takes them. */
  readonly flags?: { readonly host?: string | undefined; readonly port?: number | undefined; readonly token?: string | undefined } | undefined;
  readonly readToken?: ((daemonHomeDir: string) => string | undefined) | undefined;
} = {}): CapabilityCliInvoke {
  const fetchImpl = target.fetchImpl;
  // A daemon on another machine (named by --host, or the configured one): a bundle's or a moved setup's file is read and
  // written on this computer (bundle-file-work.ts).
  const remote = (): boolean => target.flags?.host !== undefined || !configuredDaemonIsThisMachine(runtime.configManager);
  return cliWithFileWorkHere(async (methodId, input, options) => {
    const flags = target.flags ?? {};
    const resolved = resolveRemoteDaemonTarget({
      flags: {
        ...(flags.host === undefined ? {} : { host: flags.host }),
        ...(flags.port === undefined ? {} : { port: flags.port }),
        ...(flags.token === undefined ? {} : { token: flags.token }),
      },
      configManager: runtime.configManager,
      daemonHomeDir: runtime.daemonHomeDirectory ?? resolveGoodVibesDaemonHome(runtime.homeDirectory),
      ...(target.readToken ? { readToken: target.readToken } : {}),
    });
    if (!resolved.ok) return resolved;
    const base = fetchImpl ?? createNetworkFetch(globalThis.fetch, runtime.configManager);
    const claimed: DaemonFetch = options.explicitUserRequest
      ? (url, init) => base(url, { ...init, headers: { ...(init?.headers as Record<string, string> | undefined), 'x-goodvibes-explicit-user-request': 'true' } })
      : base;
    // The daemon's own refusal, as it said it: the same words `do` prints in all three programs, never restated
    // ("the daemon on this machine refused the request: ...") or joined with its next step into one line.
    let refusal: { readonly error: string; readonly next?: string | undefined; readonly code?: string | undefined } | undefined;
    const reading: DaemonFetch = async (url, init) => {
      const response = await claimed(url, init);
      if (!response.ok && url.includes('/api/control-plane/methods/')) {
        const body = await response.clone().json().catch(() => null) as { error?: unknown; next?: unknown; code?: unknown } | null;
        if (body && typeof body.error === 'string') {
          const next = Array.isArray(body.next) && typeof body.next[0] === 'string' ? body.next[0] : undefined;
          refusal = { error: body.error, ...(next ? { next } : {}), ...(typeof body.code === 'string' ? { code: body.code } : {}) };
        }
      }
      return response;
    };
    // Only find only reads: a lost answer to it is safe to repeat; a `do` may have run, whoever asked.
    const outcome = await callDaemonMethod<unknown>(resolved.target, methodId, { input, ...(methodId === 'capabilities.find' ? { readOnly: true } : {}) }, reading);
    if (outcome.ok) return outcome;
    // A credential the daemon does not accept is not a refusal of the call: its own words (which credential) stay.
    if (refusal && refusal.code !== 'AUTH_REQUIRED') return { ok: false, code: refusal.code ?? outcome.daemonCode ?? outcome.code, error: refusal.error, fix: refusal.next ?? '' };
    return { ok: false, code: outcome.daemonCode ?? outcome.code, error: outcome.error, fix: outcome.fix };
  }, remote, process.cwd());
}

/** `do` and `find` on a program's command line, printed on its standard output and error. */
export function runCapabilityCommand(options: {
  readonly program: string;
  readonly verb: CapabilityCliVerb;
  readonly args: readonly string[];
  readonly json: boolean;
  readonly invoke: CapabilityCliInvoke;
  readonly workingDirectory: string;
  readonly caller?: 'tui' | 'agent' | undefined;
}): Promise<number> {
  return runCapabilityCli({
    ...options,
    stdout: (text) => { process.stdout.write(`${text}\n`); },
    stderr: (text) => { process.stderr.write(`${text}\n`); },
  });
}
