/**
 * capability-cli.ts, the script form of find and run, the same in every
 * program's command line (`goodvibes`, `goodvibes-agent`, `goodvibes-daemon`):
 *
 *   <program> do <capability id> [--input key=value ...] [--output json]
 *   <program> find "<words>" [--output json]
 *
 * Both are the daemon's methods (`capabilities.run`, `capabilities.find`),
 * called with this program's daemon credential. A command a person or his
 * script typed is the request, so `do` runs at once, carrying the person's
 * claim, which the daemon keeps only from a person's credential. A
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
import { resolveRemoteDaemonTarget, type DaemonFetch } from './cluster-remote-daemon-target.js';
import { CAPABILITY_DO_USAGE, CAPABILITY_FIND_USAGE, type CapabilityCliVerb } from './capability-cli-help.js';

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
  else input.stderr(`${input.program} ${input.verb}: ${outcome.error}${outcome.fix ? `\n  ${outcome.fix}` : ''}`);
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
  // A command typed (or a script the owner wrote) is the request.
  const outcome = await input.invoke('capabilities.run', {
    id: parsed.id, inputs: parsed.inputs, workingDirectory: input.workingDirectory, ...(input.caller ? { program: input.caller } : {}),
  }, { explicitUserRequest: true });
  if (!outcome.ok) return failure(input, outcome);
  const data = outcome.data as { readonly text?: string };
  if (input.json) input.stdout(JSON.stringify({ ok: true, ...(outcome.data as object) }));
  else input.stdout(data.text || `${parsed.id}: done.`);
  return 0;
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
  return async (methodId, input, options) => {
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
    const outcome = await callDaemonMethod<unknown>(resolved.target, methodId, { input, ...(options.explicitUserRequest ? {} : { readOnly: true }) }, claimed);
    return outcome.ok ? outcome : { ok: false, code: outcome.daemonCode ?? outcome.code, error: outcome.error, fix: outcome.fix };
  };
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
