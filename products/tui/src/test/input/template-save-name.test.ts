/**
 * /template save reports the name the template was stored under, which is
 * the sanitised form of what was typed.
 */
import { afterEach, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CommandContext } from '../../input/command-registry.ts';
import { CommandRegistry } from '../../input/command-registry.ts';
import { registerSessionContentCommands } from '../../input/commands/session-content.ts';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

test('the saved-template message names the stored name, not the typed one', async () => {
  const root = mkdtempSync(join(tmpdir(), 'gv-template-save-'));
  roots.push(root);
  const printed: string[] = [];
  const ctx = {
    print: (text: string) => { printed.push(text); },
    workspace: { shellPaths: { workingDirectory: root, homeDirectory: root } },
    session: { conversationManager: { getLastUserMessage: () => 'review this' } },
  } as unknown as CommandContext;
  const registry = new CommandRegistry();
  registerSessionContentCommands(registry);

  await registry.execute('template', ['save', 'My Review!'], ctx);

  expect(printed).toEqual(['Template saved: my-review']);
  // The name the user would now type to use it exists on disk.
  const stored = Bun.spawnSync(['find', root, '-name', 'my-review.md']).stdout.toString().trim();
  expect(existsSync(stored)).toBe(true);
});
