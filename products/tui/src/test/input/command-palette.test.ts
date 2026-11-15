/**
 * Command palette wiring, the palette is generated live from the command
 * registry (never a hand-maintained list) and is reachable via the /palette
 * command and the Ctrl+K chord.
 */
import { describe, it, expect } from 'bun:test';
import { CommandRegistry } from '../../input/command-registry.ts';
import { registerBuiltinCommands, categorizeBuiltinCommands } from '../../input/commands.ts';
import { KeybindingsManager } from '../../input/keybindings.ts';
import { buildPaletteEntries } from '../../input/command-palette.ts';

function makeRegistry(): CommandRegistry {
  const registry = new CommandRegistry();
  registerBuiltinCommands(registry);
  return registry;
}

describe('command palette', () => {
  it('registers /palette with the /k alias', () => {
    const registry = makeRegistry();
    const palette = registry.get('palette');
    expect(palette).toBeDefined();
    expect(palette?.name).toBe('palette');
    expect(registry.get('k')?.name).toBe('palette');
  });

  it('categorizes /palette under Shell & Session', () => {
    const entry = categorizeBuiltinCommands().find((e) => e.command.name === 'palette');
    expect(entry?.category).toBe('Shell & Session');
  });

  it('every registered command becomes exactly one categorized palette entry', () => {
    const registry = makeRegistry();
    const categoryByName = new Map(categorizeBuiltinCommands().map((e) => [e.command.name, e.category]));
    const commands = registry.getAll();
    const entries = buildPaletteEntries(commands, categoryByName);
    expect(entries.map((e) => e.id).sort()).toEqual(commands.map((c) => c.name).sort());
    expect(entries.length).toBeGreaterThan(100);
    for (const entry of entries) {
      expect(entry.title.length).toBeGreaterThan(0);
      expect(entry.category).not.toBe('Other'); // every command must have a real category
    }
  });

  it('Ctrl+K opens the palette and kill-to-end moves to Alt+K', () => {
    const km = new KeybindingsManager({ configPath: '/nonexistent/keybindings.json' });
    expect(km.lookup({ logicalName: 'k', ctrl: true })).toBe('command-palette');
    expect(km.lookup({ logicalName: 'k', alt: true })).toBe('kill-line');
  });
});
