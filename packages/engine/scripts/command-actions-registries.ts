/**
 * Both terminal apps' slash commands, loaded the way each app registers them,
 * without running a handler: what `commands:check` and the command-actions
 * generator read.
 */
import { join } from 'node:path';
import type { CommandDescription } from '../terminal-shell/src/command-actions/index.ts';

const REPO_ROOT = join(import.meta.dir, '..', '..', '..');

export interface RegisteredCommand {
  readonly name: string;
  readonly described?: CommandDescription<never> | undefined;
}
interface Registry { getAll(): RegisteredCommand[] }

export async function loadCommandRegistries(): Promise<{ readonly tui: readonly RegisteredCommand[]; readonly agent: readonly RegisteredCommand[] }> {
  const tuiCommands = await import(join(REPO_ROOT, 'products/tui/src/input/commands.ts')) as { categorizeBuiltinCommands(): { command: RegisteredCommand }[] };
  const tuiRegistry = await import(join(REPO_ROOT, 'products/tui/src/input/command-registry.ts')) as { CommandRegistry: new () => Registry };
  const workLedger = await import(join(REPO_ROOT, 'products/tui/src/runtime/native-work-ledger-host.ts')) as { registerNativeWorkLedgerCommand(registry: unknown, view: object): void };
  const legacyImport = await import(join(REPO_ROOT, 'products/tui/src/input/commands/legacy-work-ledger-import-runtime.ts')) as { registerTuiLegacyImportCommands(registry: unknown): void };
  const tui = tuiCommands.categorizeBuiltinCommands().map((entry) => entry.command);
  // Registered beside the built-in groups at start-up (runtime/bootstrap-shell.ts).
  const extra = new tuiRegistry.CommandRegistry();
  workLedger.registerNativeWorkLedgerCommand(extra, { selectProject: () => undefined });
  legacyImport.registerTuiLegacyImportCommands(extra);
  const known = new Set(tui.map((command) => command.name));
  const agentCommands = await import(join(REPO_ROOT, 'products/agent/src/input/commands.ts')) as { registerBuiltinCommands(registry: unknown): void };
  const agentRegistry = await import(join(REPO_ROOT, 'products/agent/src/input/command-registry.ts')) as { CommandRegistry: new () => Registry };
  const agent = new agentRegistry.CommandRegistry();
  agentCommands.registerBuiltinCommands(agent);
  return { tui: [...tui, ...extra.getAll().filter((command) => !known.has(command.name))], agent: agent.getAll() };
}

/** Every described command once, by name (both apps register the same description). */
export async function loadDescribedCommands(): Promise<readonly CommandDescription<never>[]> {
  const { tui, agent } = await loadCommandRegistries();
  const byName = new Map<string, CommandDescription<never>>();
  for (const command of [...tui, ...agent]) if (command.described && !byName.has(command.name)) byName.set(command.name, command.described);
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}
