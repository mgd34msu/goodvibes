import { describe, expect, test } from 'bun:test';
import { DAEMON_COMMANDS, GLOBAL_FLAGS } from '../../cli/command-catalog.ts';
import {
  COMPLETION_SHELLS,
  completionCommandWords,
  completionFlagsFor,
  renderCompletionScript,
  runCompletionCommand,
} from '../../cli/completion.ts';

const BINARY = 'goodvibes-daemon';

/** What a script offers for one command, read back out of the rendered text. */
interface Offered {
  readonly words: readonly string[];
  readonly subs: readonly string[];
  readonly flags: readonly string[];
}

function quoted(text: string): string[] {
  return [...text.matchAll(/'((?:[^'\\]|\\.)*)'/g)].map((match) => match[1]!);
}

function offeredBy(shell: (typeof COMPLETION_SHELLS)[number], script: string, spec: (typeof DAEMON_COMMANDS)[number]): Offered {
  const words = [spec.name, ...spec.aliases];
  if (shell === 'bash') {
    const arm = script.match(new RegExp(`^    ${words.join('\\|')}\\)\\n      __gvd_flags="(.*)"\\n      __gvd_subs="(.*)"$`, 'm'));
    if (!arm) throw new Error(`bash script has no case arm for ${words.join('|')}`);
    return { words, flags: arm[1]!.split(' ').filter(Boolean), subs: arm[2]!.split(' ').filter(Boolean) };
  }
  if (shell === 'zsh') {
    const arm = script.match(new RegExp(`^      ${words.join('\\|')}\\)\\n        __gvd_flags=\\((.*)\\)\\n        __gvd_subs=\\((.*)\\)$`, 'm'));
    if (!arm) throw new Error(`zsh script has no case arm for ${words.join('|')}`);
    return { words, flags: quoted(arm[1]!), subs: quoted(arm[2]!) };
  }
  const seen = `-n '__fish_seen_subcommand_from ${words.join(' ')}'`;
  const lines = script.split('\n').filter((line) => line.includes(seen));
  const subs = lines.flatMap((line) => line.match(/ -a '([^']*)'/)?.[1] ?? []);
  const flags = lines.flatMap((line) => {
    const option = line.match(/ -(l|s) (\S+)/);
    return option ? [`${option[1] === 'l' ? '--' : '-'}${option[2]}`] : [];
  });
  return { words, flags, subs };
}

describe('the completion scripts are generated from the catalog', () => {
  test.each([...COMPLETION_SHELLS])('the %s script offers every command', (shell) => {
    const script = renderCompletionScript(shell, BINARY);
    if (shell === 'bash') {
      const line = script.match(/local __gvd_commands="(.*)"/)?.[1] ?? '';
      expect(line.split(' ')).toEqual([...completionCommandWords()]);
      return;
    }
    for (const spec of DAEMON_COMMANDS) {
      const entry = shell === 'zsh' ? `    '${spec.name}:` : `-a '${spec.name}' -d `;
      expect(script, `${spec.name} is not offered as a command`).toContain(entry);
    }
  });

  test.each([...COMPLETION_SHELLS])('the %s script offers every alias', (shell) => {
    const script = renderCompletionScript(shell, BINARY);
    // fish offers the command names and unlocks sub-words and flags for the aliases too.
    for (const spec of DAEMON_COMMANDS) {
      expect(offeredBy(shell, script, spec).words).toEqual([spec.name, ...spec.aliases]);
    }
    if (shell === 'bash') {
      const line = script.match(/local __gvd_commands="(.*)"/)?.[1] ?? '';
      for (const alias of ['session', 'qr', 'qrcode', 'completions']) expect(line.split(' ')).toContain(alias);
    }
  });

  test.each([...COMPLETION_SHELLS])('the %s script offers each command its own sub-words and flags', (shell) => {
    const script = renderCompletionScript(shell, BINARY);
    for (const spec of DAEMON_COMMANDS) {
      const offered = offeredBy(shell, script, spec);
      expect(offered.subs, `${spec.name} sub-words`).toEqual([...spec.subcommands]);
      // fish offers the global flags once, for every command, so its per-command list is the command's own.
      const own = spec.passthrough ? completionFlagsFor(spec.name) : spec.flags.flatMap((flag) => flag.tokens);
      expect(offered.flags, `${spec.name} flags`).toEqual([...(shell === 'fish' ? own : completionFlagsFor(spec.name))]);
    }
  });

  test('the fish script offers every global flag, except after a passthrough command', () => {
    const script = renderCompletionScript('fish', BINARY);
    const passthrough = DAEMON_COMMANDS.filter((spec) => spec.passthrough).flatMap((spec) => [spec.name, ...spec.aliases]);
    expect(passthrough.length).toBeGreaterThan(0);
    for (const flag of GLOBAL_FLAGS) {
      for (const token of flag.tokens) {
        const option = token.startsWith('--') ? `-l ${token.slice(2)}` : `-s ${token.slice(1)}`;
        expect(script, `${token} is not offered`).toContain(`complete -c ${BINARY} -n 'not __fish_seen_subcommand_from ${passthrough.join(' ')}' ${option}`);
      }
    }
  });

  test('the bash script defines and registers a completion function for the binary', () => {
    const script = renderCompletionScript('bash', 'goodvibes-daemon');
    expect(script).toContain('_goodvibes_daemon_complete() {');
    expect(script).toContain('complete -F _goodvibes_daemon_complete goodvibes-daemon');
  });

  test('the zsh script carries the compdef line for the binary', () => {
    const script = renderCompletionScript('zsh', 'goodvibes-daemon');
    expect(script.startsWith('#compdef goodvibes-daemon')).toBe(true);
    expect(script).toContain('_describe -t commands');
  });

  test('the fish script guards command completion to the no-command position', () => {
    const script = renderCompletionScript('fish', 'goodvibes-daemon');
    expect(script).toContain('function __goodvibes_daemon_no_command');
    expect(script).toContain("complete -c goodvibes-daemon -n '__goodvibes_daemon_no_command'");
  });

  test('a renamed binary produces a script for that name', () => {
    const script = renderCompletionScript('bash', 'gvd');
    expect(script).toContain('complete -F _gvd_complete gvd');
  });

  test('the helpers agree with the catalog', () => {
    expect(completionCommandWords()).toContain('sessions');
    expect(completionCommandWords()).toContain('session');
    expect(completionFlagsFor('status')).toContain('--json');
    expect(completionFlagsFor('status')).toContain('--daemon-home');
    expect(completionFlagsFor('serve')).not.toContain('--json');
  });

  test('pair completes -y/--yes alongside its remote-target flags', () => {
    const flags = completionFlagsFor('pair');
    expect(flags).toContain('-y');
    expect(flags).toContain('--yes');
    expect(flags).toContain('--host');
    expect(flags).toContain('--port');
    expect(flags).toContain('--token');
    expect(flags).toContain('--json');
  });
});

describe('the completion command itself', () => {
  test.each([...COMPLETION_SHELLS])('emits the %s script and exits 0', (shell) => {
    const result = runCompletionCommand([shell], 'goodvibes-daemon');
    expect(result.exitCode).toBe(0);
    expect(result.lines.join('\n')).toBe(renderCompletionScript(shell, 'goodvibes-daemon'));
  });

  test('a missing shell is a usage refusal naming the ones that exist', () => {
    const result = runCompletionCommand([], 'goodvibes-daemon');
    expect(result.exitCode).toBe(2);
    expect(result.lines.join('\n')).toContain('bash|zsh|fish');
  });

  test('an unrecognized shell is refused rather than guessed at', () => {
    const result = runCompletionCommand(['powershell'], 'goodvibes-daemon');
    expect(result.exitCode).toBe(2);
    expect(result.lines.join('\n')).toContain("'powershell' is not a shell");
  });

  test('a second argument is refused', () => {
    const result = runCompletionCommand(['bash', 'zsh'], 'goodvibes-daemon');
    expect(result.exitCode).toBe(2);
    expect(result.lines.join('\n')).toContain('one argument too many');
  });
});

describe('passthrough commands are completed with their own flags, not the global ones they refuse', () => {
  test('send completes --channel and none of the global flags', () => {
    const flags = completionFlagsFor('send');
    expect(flags).toContain('--channel');
    expect(flags).toContain('--list');
    expect(flags).not.toContain('--daemon-home');
    expect(renderCompletionScript('bash', 'goodvibes-daemon')).toContain('__gvd_flags="--channel -c --to --title --list --help -h"');
  });

  test('the fish script unlocks an alias\'s sub-words and flags with the same guard as its command', () => {
    const script = renderCompletionScript('fish', 'goodvibes-daemon');
    expect(script).toContain("__fish_seen_subcommand_from sessions session' -a 'list'");
    expect(script).toContain("__fish_seen_subcommand_from send' -l channel -r");
  });
});
