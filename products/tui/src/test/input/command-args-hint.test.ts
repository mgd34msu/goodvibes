// ---------------------------------------------------------------------------
// command-args-hint.test.ts, the composer's argument hints come from each
// command's own `subcommands`, resolved through aliases.
//
// Covers:
//   - /session's subcommand hints cover every real subcommand the /session
//     switch recognizes, cross-checked against the default-branch usage text.
//   - buildCommandArgsHint resolves a real hint for a representative
//     subcommand, under the primary name and under an alias.
// ---------------------------------------------------------------------------

import { describe, test, expect } from 'bun:test';
import { CommandRegistry } from '../../input/command-registry.ts';
import { registerBuiltinCommands } from '../../input/commands.ts';
import { buildCommandArgsHint } from '../../input/command-args-hint.ts';
import { SESSION_SUBCOMMAND_ARG_HINTS, sessionCommand } from '../../input/commands/session.ts';

const registry = new CommandRegistry();
registerBuiltinCommands(registry);

describe('command-args-hint drift guard', () => {

  // Aliases share their canonical subcommand's hint text (see
  // SESSION_SUBCOMMAND_ARG_HINTS's doc) and are never spelled out on their
  // own in the printed usage text (only the canonical name is), verified
  // structurally below instead of by text match.
  const SESSION_SUBCOMMAND_ALIASES: Record<string, string> = { link: 'link-task', ho: 'handoff', g: 'graph' };

  test('SESSION_SUBCOMMAND_ARG_HINTS canonical keys are all real /session subcommands (per the default-branch usage text)', async () => {
    // Trigger the default branch (an unrecognized subcommand) to get the
    // authoritative usage listing straight from the live handler, the same
    // text a confused user actually sees.
    const printed: string[] = [];
    const ctx = { print: (s: string) => printed.push(s) } as unknown as Parameters<typeof sessionCommand.handler>[1];
    await sessionCommand.handler(['__not_a_real_subcommand__'], ctx);
    const usageText = printed.join('\n');
    expect(usageText.length).toBeGreaterThan(0);

    for (const key of Object.keys(SESSION_SUBCOMMAND_ARG_HINTS)) {
      if (key in SESSION_SUBCOMMAND_ALIASES) continue;
      // Each real (canonical) subcommand appears as its own token in the
      // usage text (e.g. "  rename <name>" or "  link-task <taskId> ...").
      // A stale hint key (renamed/removed subcommand) would fail this check.
      const pattern = new RegExp(`(^|\\s)${key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(\\s|$)`, 'm');
      expect(pattern.test(usageText), `hint key "${key}" should appear in /session's usage text`).toBe(true);
    }
  });

  test('SESSION_SUBCOMMAND_ARG_HINTS aliases match their canonical subcommand\'s hint', () => {
    for (const [alias, canonical] of Object.entries(SESSION_SUBCOMMAND_ALIASES)) {
      expect(SESSION_SUBCOMMAND_ARG_HINTS[alias]).toBe(SESSION_SUBCOMMAND_ARG_HINTS[canonical]);
    }
  });

  test('buildCommandArgsHint resolves real hints for representative subcommands', () => {
    expect(buildCommandArgsHint('/session rename', registry)).toBe('<name>');
    expect(buildCommandArgsHint('/session link-task', registry)).toBe(SESSION_SUBCOMMAND_ARG_HINTS['link-task']);
    expect(buildCommandArgsHint('/template save', registry)).toBe('<name>');
    expect(buildCommandArgsHint('/secrets set', registry)).toBe('<KEY> <value> [--user|--project] [--secure|--plaintext]');
    expect(buildCommandArgsHint('/plugin enable', registry)).toBe('<name>');
    expect(buildCommandArgsHint('/permissions revoke', registry)).toBe('<rule-id>');
  });

  test('an alias gets the same hint as the primary name', () => {
    expect(buildCommandArgsHint('/sess resume', registry)).toBe(buildCommandArgsHint('/session resume', registry));
    expect(buildCommandArgsHint('/tmpl use', registry)).toBe('<name> [args]');
  });

  test('subcommands the commands do not have get no hint', () => {
    expect(buildCommandArgsHint('/permissions tool', registry)).toBeUndefined();
    expect(buildCommandArgsHint('/config reset', registry)).toBeUndefined();
  });

  test('an unhinted subcommand yields no hint rather than a stale one', () => {
    expect(buildCommandArgsHint('/session nonexistent-subcommand', registry)).toBeUndefined();
  });
});
