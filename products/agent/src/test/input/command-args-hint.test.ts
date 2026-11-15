import { describe, expect, test } from 'bun:test';
import { CommandRegistry, type CommandContext } from '../../input/command-registry.ts';
import { registerBuiltinCommands } from '../../input/commands.ts';
import { SESSION_SUBCOMMAND_ARG_HINTS, buildCommandArgsHint } from '../../input/command-args-hint.ts';
import { sessionCommand } from '../../input/commands/session.ts';

const registry = new CommandRegistry();
registerBuiltinCommands(registry);

/** The usage text a person sees for an unrecognised /session subcommand. */
async function sessionUsage(): Promise<string> {
  const printed: string[] = [];
  await sessionCommand.handler(['__not_a_subcommand__'], { print: (text: string) => printed.push(text), session: { sessionManager: {} } } as unknown as CommandContext);
  return printed.join('\n');
}

/** Subcommands the Agent blocks, so an argument hint for them would promise a form that is refused. */
const BLOCKED = new Set(['link-task', 'handoff', 'cancel']);

describe('/session argument hints', () => {
  test('every subcommand the usage text lists has an argument hint, and every hint names a listed subcommand', async () => {
    const usage = await sessionUsage();
    const listed = usage.split('\n')
      .filter((line) => line.includes(' | ') || /^\s+(events|graph)\b/.test(line))
      .flatMap((line) => line.split(' | '))
      .map((part) => part.trim().split(/\s+/)[0] ?? '')
      .filter((name) => /^[a-z][a-z-]*$/.test(name) && name !== 'usage');
    const canonical = [...new Set(listed)].filter((name) => !BLOCKED.has(name));
    expect(canonical.length).toBeGreaterThan(8);
    for (const name of canonical) expect(Object.hasOwn(SESSION_SUBCOMMAND_ARG_HINTS, name), `/session ${name} has no hint`).toBe(true);
    for (const key of Object.keys(SESSION_SUBCOMMAND_ARG_HINTS)) {
      if (key === 'g') continue;
      expect(usage, `hint for /session ${key} names a subcommand the usage text does not list`).toMatch(new RegExp(`(^|\\s)${key}(\\s|$)`, 'm'));
    }
  });

  test('typing a subcommand shows its arguments, including the current-session form of export', () => {
    expect(buildCommandArgsHint('/session fork', registry)).toBe('[name]');
    expect(buildCommandArgsHint('/session graph', registry)).toBe('[--session <sid>] [--format text|json]');
    expect(buildCommandArgsHint('/session export', registry)).toBe('<id|.> [markdown|text]');
  });

  test('an unhinted subcommand yields no hint rather than a stale one', () => {
    expect(buildCommandArgsHint('/session nonexistent-subcommand', registry)).toBeUndefined();
  });
});
