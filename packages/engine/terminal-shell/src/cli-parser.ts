/**
 * cli-parser.ts, parses a terminal-shaped front-end's argv into a command
 * word and the flags its vocabulary shares.
 *
 * `parseGoodVibesCli` is a thin wrapper: cli-parser-engine.ts is the argument
 * engine, and cli-command-catalog.ts is the data, every command name,
 * alias, and flag this parses. This file exists so a consumer keeps its
 * existing single call, with its existing single result shape.
 */
import { parseWithCatalog } from './cli-parser-engine.js';
import { GOODVIBES_CLI_CATALOG } from './cli-command-catalog.js';
import type { GoodVibesCliParseResult } from './cli-types.js';

export function parseGoodVibesCli(argv: readonly string[], binary = 'goodvibes'): GoodVibesCliParseResult {
  return parseWithCatalog(argv, GOODVIBES_CLI_CATALOG, binary);
}

/** Bind a product vocabulary once; the compatibility flags entry point stays uniform. */
export function createCliFlagParser<Flags>(parse: (argv: readonly string[], binary: string) => { readonly flags: Flags }) {
  return (argv: readonly string[], binary = 'goodvibes'): Flags => parse(argv, binary).flags;
}
