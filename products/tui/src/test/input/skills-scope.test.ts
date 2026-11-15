import { describe, expect, test } from 'bun:test';
import { CommandRegistry, type CommandContext } from '../../input/command-registry.ts';
import { parseEcosystemScope, registerSkillsRuntimeCommands } from '../../input/commands/skills-runtime.ts';

describe('/skills scope word', () => {
  test('defaults to project and accepts only project or user', () => {
    expect(parseEcosystemScope(undefined)).toBe('project');
    expect(parseEcosystemScope('project')).toBe('project');
    expect(parseEcosystemScope('user')).toBe('user');
    expect(parseEcosystemScope('projct')).toBeUndefined();
  });

  for (const sub of ['install', 'update', 'uninstall']) {
    test(`/skills ${sub} with a mistyped scope refuses before touching anything`, async () => {
      const registry = new CommandRegistry();
      registerSkillsRuntimeCommands(registry);
      const printed: string[] = [];
      // Any access to the shell paths or catalog would throw on this bare context.
      const ctx = { print: (text: string) => { printed.push(text); } } as unknown as CommandContext;
      await registry.get('skills')!.handler(
        [sub, 'x', 'projct'], ctx);
      expect(printed).toHaveLength(1);
      expect(printed[0]).toContain('nothing was changed');
      expect(printed[0]).toContain('[project|user]');
    });
  }
});
