/**
 * capability-cli.ts, the script form of find and run, the same in every
 * program's command line (`goodvibes`, `goodvibes-agent`, `goodvibes-daemon`):
 *
 *   <program> do <capability id> [--input key=value ...] [--output json]
 *   <program> find "<words>" [--output json]
 *
 * Both are the daemon's methods (`capabilities.run`, `capabilities.find`),
 * called with this program's daemon credential, the command-line client kind
 * (`x-goodvibes-client: cli`) and a registration of the command-line kind
 * (`cli`, platform daemon/program-registrations.ts): a command line is never a
 * person's press, whatever its environment, its terminal or its marks say, so
 * `do` never carries the person's claim. It runs no-risk reads; an act that
 * weakens a protection (installing something that runs by itself included),
 * cannot be undone, spends money, writes a secret or is the owner's own is
 * decided by the daemon under the owner's permission mode (platform
 * capabilities/command-line-hold.ts): YOLO runs it, Jev decides gives it to
 * Jev, Ask me asks the owner on the approval card and this command waits on their one
 * answer. It answers no question addressed to the owner and approves nothing.
 * Nothing is asked at the terminal: anything that can drive a terminal
 * (`tmux send-keys`, `ssh -tt localhost`, `script`) can type there, and a
 * command a model's command tool ran can clear any mark it was given. A
 * capability that acts on a conversation is refused in one line: it needs a
 * program holding a conversation.
 *
 * Exit codes (docs/exit-codes.md): 0 done, 1 it ran and did not succeed (a
 * refusal included), 2 the command line was wrong.
 */
import { resolveGoodVibesDaemonHome } from '@goodvibes/engine/platform/platform/config/goodvibes-home';
import { createNetworkFetch } from '@goodvibes/engine/platform/platform/runtime/network/outbound';
import type { ConfigManager } from '@goodvibes/engine/platform/platform/config';
import { callDaemonMethod } from './raw-reply-route.js';
import { cliWithFileWorkHere } from './bundle-file-work.js';
import { configuredDaemonIsThisMachine } from '@goodvibes/engine/platform/platform/runtime/client/daemon-target-resolver';
import { resolveRemoteDaemonTarget, type DaemonFetch } from './cluster-remote-daemon-target.js';
import { CAPABILITY_DO_USAGE, CAPABILITY_FIND_USAGE, type CapabilityCliVerb } from './capability-cli-help.js';
import { CALL_PROGRAM_KEY_HEADER, COMMAND_LINE_CLIENT, markCommandLineCall, programRegistrationFor } from '@goodvibes/engine/platform/platform/runtime/client';
import { WAITING_LINES_HEADER } from '@goodvibes/engine/daemon-api/control-routes';

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
  // Every call this process makes names the command-line client kind, and carries the registration of the program whose
  // command line it is (the terminal app's, the Agent's, or the daemon's own: the product's programs, verified by the
  // daemon's program socket). The daemon still holds a command line's risky call for the owner whatever it claims
  // (capabilities/command-line-hold.ts).
  markCommandLineCall(input.caller ?? 'daemon');
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
  // A command line is never a person's press (the header above): the person's claim is never sent. An act that weakens
  // a protection, cannot be undone, spends money, writes a secret or is the owner's own is decided by the daemon under
  // the owner's permission mode (capabilities/command-line-hold.ts); under Ask me this call waits on their one answer.
  const outcome = await input.invoke('capabilities.run', {
    id: parsed.id, inputs: parsed.inputs, workingDirectory: input.workingDirectory, ...(input.caller ? { program: input.caller } : {}),
  }, { explicitUserRequest: false });
  if (!outcome.ok) return failure(input, outcome);
  const data = outcome.data as { readonly text?: string };
  if (input.json) input.stdout(JSON.stringify({ ok: true, ...(outcome.data as object) }));
  else {
    // A value the person must see once (a capability's `reveals`) comes back only to the person who typed the line:
    // it is printed for them on its own line, with what it is, after the capability's words.
    const reveal = (outcome.data as { readonly reveal?: { readonly label?: unknown; readonly value?: unknown; readonly note?: unknown } }).reveal;
    const shown = reveal && typeof reveal.value === 'string'
      ? ['', `${typeof reveal.label === 'string' ? reveal.label : 'Shown once'}:`, reveal.value, ...(typeof reveal.note === 'string' ? [reveal.note] : [])]
      : [];
    input.stdout([data.text || `${parsed.id}: done.`, ...shown].join('\n'));
  }
  return 0;
}

/**
 * A `do`'s answer sent as lines (daemon-api control-routes.ts `WAITING_LINES_HEADER`): each card raised for the act is
 * said at once, in one line on standard error (what is asked and where to answer it), while the `do` keeps waiting; the
 * last line is the act's own answer, returned as the answer it would have been. Any other answer is returned as it came.
 */
export async function waitingLinesRead(response: Response): Promise<Response> {
  if (!(response.headers.get('content-type') ?? '').startsWith('application/x-ndjson') || !response.body) return response;
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let pending = '';
  let last: { readonly status: number; readonly body: unknown } | undefined;
  const take = (text: string): void => {
    if (!text.trim()) return;
    let value: { readonly waiting?: { readonly question?: unknown; readonly where?: unknown }; readonly status?: unknown; readonly body?: unknown };
    try { value = JSON.parse(text) as typeof value; } catch { return; }
    if (value.waiting) {
      const question = typeof value.waiting.question === 'string' ? value.waiting.question.replace(/\s+/g, ' ').trim() : 'this act';
      const where = typeof value.waiting.where === 'string' ? value.waiting.where : 'answer it in GoodVibes';
      process.stderr.write(`Waiting for your answer: ${question.replace(/[.?!]?$/, '.')} ${where.charAt(0).toUpperCase()}${where.slice(1).replace(/[.]?$/, '.')}\n`);
    } else if (typeof value.status === 'number') {
      last = { status: value.status, body: value.body };
    }
  };
  for (;;) {
    const { done, value } = await reader.read();
    if (value) pending += decoder.decode(value, { stream: true });
    let at = pending.indexOf('\n');
    while (at >= 0) { take(pending.slice(0, at)); pending = pending.slice(at + 1); at = pending.indexOf('\n'); }
    if (done) break;
  }
  take(pending);
  if (!last) return new Response(JSON.stringify({ error: 'the daemon\'s answer ended before the act did', code: 'INTERNAL_ERROR' }), { status: 502, headers: { 'content-type': 'application/json' } });
  return new Response(typeof last.body === 'string' ? last.body : JSON.stringify(last.body), { status: last.status, headers: { 'content-type': 'application/json' } });
}

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
    // This program's registration with the daemon of this machine (none for another machine's, or one that issues none).
    const registration = await programRegistrationFor(resolved.target.baseUrl, resolved.target.token);
    // Named as the command line it is (`x-goodvibes-client: cli`), with the person's claim only where `do` gives it.
    const claimed: DaemonFetch = (url, init) => base(url, { ...init, headers: { ...(init?.headers as Record<string, string> | undefined),
      'x-goodvibes-client': COMMAND_LINE_CLIENT, ...(registration ? { [CALL_PROGRAM_KEY_HEADER]: registration } : {}),
      ...(options.explicitUserRequest ? { 'x-goodvibes-explicit-user-request': 'true' } : {}),
      // A `do` is told, in the same answer, when its act starts waiting on a card (one line on standard error).
      ...(methodId === 'capabilities.run' ? { [WAITING_LINES_HEADER]: '1' } : {}) } }).then(waitingLinesRead);
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
    // Only find only reads: a lost answer to it is safe to repeat; a `do` may have run, whoever asked. A `do` has no time
    // limit of its own: its act may wait on the owner's card, answered in a program or the web; Ctrl+C withdraws it.
    const outcome = await callDaemonMethod<unknown>(resolved.target, methodId, { input, ...(methodId === 'capabilities.find' ? { readOnly: true } : {}),
      ...(methodId === 'capabilities.run' ? { timeoutMs: 0 } : {}) }, reading);
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
