/**
 * `engine.tools.exec-prompt`: the reading behind the exec tool's PTY
 * prompt-answer path (tools/exec/interactive.ts).
 *
 * `awaiting_input` (state: the command, its unterminated last output line and
 * recent output): after output has gone quiet with the process alive, is that
 * line a question waiting for an answer? A yes surfaces it through the
 * approval broker. It replaces the three tail regexes (ends with : or ?, a
 * short [..] bracket, a (yes/no) choice) and the 500-character cutoff. Medium
 * stakes: a wrong yes puts a non-question in front of the owner (a decline
 * stops the run); a wrong no leaves a real prompt unanswered until the timeout.
 *
 * Whether a command runs under a PTY at all is not read: the caller's
 * `interactive` flag or the piped run's own terminal-required error decides
 * it, so a command starts with no request.
 */
import { defineBattery, STAKES_BANDS, yesNo } from '@goodvibes-jev/judgment';

/** Complete-evidence budgets; oversized input holds instead of dropping context. */
export const MAX_JUDGED_PROMPT_LINE_CHARS = Number.POSITIVE_INFINITY;
export const MAX_JUDGED_RECENT_OUTPUT_CHARS = Number.POSITIVE_INFINITY;

/** What `awaiting_input` sees: the command, the unterminated last line, and the output before it. */
export function pendingPromptView(command: string, line: string, recentOutput: string): { command: string; lastLine: string; recentOutput: string } {
  if (command.length + line.length + recentOutput.length > MAX_JUDGED_RECENT_OUTPUT_CHARS) throw new RangeError('Terminal prompt evidence exceeds the judgment input budget.');
  return {
    command,
    lastLine: line,
    recentOutput,
  };
}

const pending = (command: string, line: string, recent = '') => pendingPromptView(command, line, recent);

export const execPrompt = defineBattery({
  name: 'engine.tools.exec-prompt',
  version: 2,
  description: 'Whether a quiet, unterminated output line of a running shell command is a question waiting for an answer.',
  accuracyFloor: 0.85,
  items: {
    awaiting_input: yesNo(
      '`command` is running, its output has stopped, and it is still alive. `lastLine` is the last line it printed, with no newline after it; `recentOutput` is what it printed before. Is `lastLine` a question or prompt waiting for someone to type an answer (a password, a yes/no confirmation, a choice, a value to enter)? Progress bars, status or log lines, partial output of a slow step, and a program simply thinking are not waiting for input.',
      STAKES_BANDS.medium.yesNo,
    ),
  },
  fixtures: [
    { name: 'sudo password', state: pending('sudo apt-get install ripgrep', '[sudo] password for dev:'), expect: { awaiting_input: 'yes' } },
    {
      name: 'ssh host key',
      state: pending(
        'ssh deploy@build-01.internal uptime',
        'Are you sure you want to continue connecting (yes/no/[fingerprint])?',
        "The authenticity of host 'build-01.internal (10.0.4.12)' can't be established.\nED25519 key fingerprint is SHA256:2x1kQv0mVfX4d7Lr9s8PzYb3aT6cN5eJ0uHwGiRkM1o.\n",
      ),
      expect: { awaiting_input: 'yes' },
    },
    { name: 'apt confirm', state: pending('sudo apt-get install ripgrep', 'Do you want to continue? [Y/n]', 'After this operation, 4,096 kB of additional disk space will be used.\n'), expect: { awaiting_input: 'yes' } },
    { name: 'git credential', state: pending('git push origin main', "Username for 'https://github.com':"), expect: { awaiting_input: 'yes' } },
    { name: 'npm init field', state: pending('npm init', 'package name: (shop-api)', 'This utility will walk you through creating a package.json file.\n'), expect: { awaiting_input: 'yes' } },
    { name: 'progress bar', state: pending('bun install', '[12/48] Resolving dependencies...'), expect: { awaiting_input: 'no' } },
    { name: 'download percentage', state: pending('curl -O https://example.org/big.iso', ' 42.1% of 3.2GiB at 11.4MiB/s ETA 02:51'), expect: { awaiting_input: 'no' } },
    { name: 'log line ending in a colon', state: pending('bun run build', 'Bundling entry points:', 'Cleaning dist...\n'), expect: { awaiting_input: 'no' } },
    { name: 'test runner mid-run', state: pending('bun test', 'test/cart.test.ts:', 'bun test v1.2.19\n'), expect: { awaiting_input: 'no' } },
  ],
});
