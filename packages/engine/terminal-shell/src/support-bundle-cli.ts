/**
 * support-bundle-cli.ts, the command-line form of the support bundle in both programs (`goodvibes support-bundle`,
 * `goodvibes-agent bundle`):
 *
 *   export [path]                                  bundle.export (a file already there is replaced, as before)
 *   inspect <path>                                 bundle.inspect
 *   import <path> [--include-security] [--yes]     without --yes: what loading would change (bundle.inspect),
 *                                                  nothing changed, exit 2; with --yes: bundle.import
 *
 * Each runs the daemon's System capability through `capabilities.run`, the way `do` does, so the one builder in the
 * daemon writes and reads every bundle, whichever door asked. The program asking fills the capability's `program`
 * input. When the daemon on this machine does not answer it is started once and waited for (its service when one is
 * installed, else the daemon program in the background), as the programs do at start; a daemon on another machine is
 * never started from here.
 */
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  autostartInstalledDaemon, createDaemonServiceControl, DAEMON_PROGRAM_STARTED_LINE, daemonProgramStartFailedLine, GOODVIBES_INSTALLER_COMMAND,
  type DaemonProgram,
} from '@goodvibes/engine/platform/platform/runtime/client';
import { configuredDaemonIsThisMachine } from '@goodvibes/engine/platform/platform/runtime/client/daemon-target-resolver';
import type { ConfigManager } from '@goodvibes/engine/platform/platform/config';
import { runCapabilityCli, type CapabilityCliInvoke } from './capability-cli.js';
// With a daemon on another machine, this program reads and writes the bundle's file on its own disk (bundle-file-work.ts).
export { cliWithFileWorkHere, withFileWorkHere } from './bundle-file-work.js';

export interface SupportBundleCliInput {
  /** The program's name as typed (`goodvibes`, `goodvibes-agent`). */
  readonly binary: string;
  /** The words that name this form after the program (`support-bundle`, `bundle`). */
  readonly command: string;
  readonly caller: 'tui' | 'agent';
  /** The words after the command. */
  readonly args: readonly string[];
  readonly json: boolean;
  /** `--yes` given on the command line as a global flag. */
  readonly yes: boolean;
  readonly invoke: CapabilityCliInvoke;
  readonly configManager: ConfigManager;
  readonly workingDirectory: string;
  readonly stdout: (text: string) => void;
  readonly stderr: (text: string) => void;
}

/**
 * The program's invoke, with the daemon on this machine started once when it does not answer (code `unreachable`):
 * its service when one is installed, else the daemon program in the background (said in one line on `say`, standard
 * error by default); where the daemon program is not on this machine, the answer is the one line naming the installer.
 * The same start the programs make at launch. `daemonProgram` is the daemon's own `do` naming itself.
 */
export function daemonStartingInvoke(
  invoke: CapabilityCliInvoke,
  runtime: { readonly configManager: ConfigManager; readonly workingDirectory: string },
  options: { readonly say?: ((line: string) => void) | undefined; readonly daemonProgram?: (() => DaemonProgram | null) | undefined } = {},
): CapabilityCliInvoke {
  let started = false;
  let missing: string | undefined;
  const say = options.say ?? ((line: string) => { process.stderr.write(`${line}\n`); });
  return async (methodId, input, callOptions) => {
    const answer = await invoke(methodId, input, callOptions);
    if (answer.ok || answer.code !== 'unreachable' || !configuredDaemonIsThisMachine(runtime.configManager)) return answer;
    // The program is not here: every call says that, never "could not reach".
    if (missing) return { ok: false, code: 'unreachable', error: missing, fix: '' };
    if (started) return answer;
    started = true;
    const outcome = await autostartInstalledDaemon({
      daemonMode: 'unavailable',
      control: createDaemonServiceControl({ configManager: runtime.configManager, workingDirectory: runtime.workingDirectory }),
      isReachable: async () => (await invoke('control.status', {}, { explicitUserRequest: false })).ok,
      ...(options.daemonProgram ? { program: options.daemonProgram } : {}),
    });
    if (outcome.action === 'not-installed' && outcome.program === false) {
      missing = `The GoodVibes daemon is not installed on this machine, so nothing was sent. Install it with the GoodVibes installer: ${GOODVIBES_INSTALLER_COMMAND}`;
      return { ok: false, code: 'unreachable', error: missing, fix: '' };
    }
    if (outcome.action === 'program-start-failed') return { ok: false, code: 'unreachable', error: `${daemonProgramStartFailedLine(outcome.reason)} Nothing was sent.`, fix: '' };
    if (outcome.action === 'program-started') say(DAEMON_PROGRAM_STARTED_LINE);
    else if (outcome.action !== 'started' && outcome.action !== 'came-online') return answer;
    return invoke(methodId, input, callOptions);
  };
}

export async function runSupportBundleCli(input: SupportBundleCliInput): Promise<number> {
  const [sub = 'inspect', ...rest] = input.args;
  const base = `${input.binary} ${input.command}`;
  const usage = (line: string): number => {
    if (input.json) input.stdout(JSON.stringify({ ok: false, code: 'PARSE_ERROR', error: `Usage: ${line}` }));
    else input.stderr(`Usage: ${line}`);
    return 2;
  };
  const invoke = daemonStartingInvoke(input.invoke, input);
  const run = (id: string, inputs: Record<string, string>, out: (text: string) => void = input.stdout): Promise<number> => runCapabilityCli({
    program: input.binary, verb: 'do', json: input.json, invoke, workingDirectory: input.workingDirectory, caller: input.caller, said: base,
    args: [id, ...Object.entries(inputs).flatMap(([key, value]) => ['--input', `${key}=${value}`])],
    stdout: out, stderr: input.stderr,
  });
  if (sub === 'inspect') {
    const path = rest[0];
    if (!path) return usage(`${base} inspect <path>`);
    return run('bundle.inspect', { path });
  }
  if (sub === 'export') {
    // The command typed is the request: a file already at that place is replaced, as this command always did (asked
    // for only when one is there, so a first export does not say it replaced something).
    const target = resolve(input.workingDirectory, rest[0] ?? (input.caller === 'agent' ? 'goodvibes-agent-bundle.json' : 'goodvibes-bundle.json'));
    return run('bundle.export', { ...(rest[0] ? { path: rest[0] } : {}), ...(existsSync(target) ? { existing: 'replace' } : {}) });
  }
  if (sub === 'import') {
    const apply = input.yes || rest.includes('--yes');
    const includeSecurity = rest.includes('--include-security');
    const path = rest.find((token) => token !== '--yes' && token !== '--include-security');
    if (!path) return usage(`${base} import <path> [--include-security] [--yes]`);
    if (apply) return run('bundle.import', { path, security: includeSecurity ? 'yes' : 'no' });
    // Without --yes: what loading would change, and nothing changed.
    const again = `${base} import ${path}${includeSecurity ? ' --include-security' : ''} --yes`;
    let printed = '';
    const code = await run('bundle.inspect', { path }, (text) => { printed += text; });
    if (code !== 0) { input.stdout(printed); return code; }
    if (input.json) {
      const parsed = JSON.parse(printed) as Record<string, unknown>;
      input.stdout(JSON.stringify({ ...parsed, ok: false, code: 'CONFIRMATION_REQUIRED', fix: `Load it: ${again}` }));
    } else {
      input.stdout(`${printed}\nNothing was loaded. To load it: ${again}`);
    }
    return 2;
  }
  return usage(`${base} export [path]|inspect <path>|import <path> [--include-security] [--yes]`);
}

/** The same, printed on the program's standard output and error. */
export function runSupportBundleCommand(input: Omit<SupportBundleCliInput, 'stdout' | 'stderr'>): Promise<number> {
  return runSupportBundleCli({
    ...input,
    stdout: (text) => { process.stdout.write(`${text}\n`); },
    stderr: (text) => { process.stderr.write(`${text}\n`); },
  });
}
