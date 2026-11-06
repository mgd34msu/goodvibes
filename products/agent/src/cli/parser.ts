import { parseWithCatalog } from '@goodvibes-jev/engine/terminal-shell';
import { AGENT_CLI_CATALOG, COMMAND_ALIASES, BLOCKED_PRODUCT_COMMAND_HINTS } from './catalog.ts';
import type { GoodVibesCliCommand, GoodVibesCliParseResult } from './types.ts';
export function listGoodVibesCliCommandTokens(): readonly string[] {
  return Object.keys(COMMAND_ALIASES).sort();
}
export function listGoodVibesCliCommands(): readonly GoodVibesCliCommand[] {
  return [...new Set<GoodVibesCliCommand>(['tui', ...Object.values(COMMAND_ALIASES)])].sort();
}
export function listBlockedGoodVibesCliCommandTokens(): readonly string[] {
  return Object.keys(BLOCKED_PRODUCT_COMMAND_HINTS).sort();
}
export function parseGoodVibesCli(argv: readonly string[], binary = 'goodvibes-agent'): GoodVibesCliParseResult {
  const result = parseWithCatalog(argv, AGENT_CLI_CATALOG, binary);
  return {
    binary: result.binary,
    command: result.command,
    rawCommand: result.rawCommand,
    commandArgs: result.commandArgs,
    positionals: result.positionals,
    flags: result.flags,
    errors: result.errors,
  };
}
