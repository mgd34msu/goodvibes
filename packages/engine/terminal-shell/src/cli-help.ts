import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync, readFileSync } from 'node:fs';
export interface TerminalCommandHelp {
  readonly usage: readonly string[];
  readonly summary: string;
  /** One line for a command list and shell completion; a command without one is listed by its summary. */
  readonly line?: string | undefined;
  readonly subcommands?: readonly string[] | undefined;
  readonly examples?: readonly string[] | undefined;
}
/** A bundled dependency's manifest must never become the product version. */
export function readProductPackageVersion(path: string, expectedName: string): string | null {
  try {
    if (!existsSync(path)) return null;
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf-8'));
    if (!parsed || typeof parsed !== 'object' || !('name' in parsed) || parsed.name !== expectedName || !('version' in parsed)) return null;
    return typeof parsed.version === 'string' && parsed.version.length > 0 ? parsed.version : null;
  } catch {
    return null;
  }
}
export function renderDetailedCommandHelp(
  topic: string,
  normalized: string,
  help: TerminalCommandHelp | undefined,
  binary: string,
  product: string,
  renderMainHelp: (binary: string) => string,
): string {
  if (!help) return [`No detailed help is available for "${topic}".`, '', renderMainHelp(binary)].join('\n');
  return [
    `${product} ${normalized}`,
    '',
    help.summary,
    '',
    'Usage:',
    ...help.usage.map((usage) => `  ${binary} ${usage}`),
    ...(help.subcommands?.length ? ['', 'Subcommands:', ...help.subcommands.map((subcommand) => '  ' + subcommand)] : []),
    ...(help.examples?.length ? ['', 'Examples:', ...help.examples.map((example) => '  ' + binary + (example ? ' ' + example : ''))] : []),
  ].join('\n');
}

/**
 * The one usage line a usage error shows: the command's first form and where
 * its full help is. With no command (or one without a help page), the
 * program's own form and its `--help`.
 */
export function renderUsageLine(normalized: string | undefined, help: TerminalCommandHelp | undefined, binary: string): string {
  if (normalized === undefined || !help) return `Usage: ${binary} [options] [prompt]   (${binary} --help lists every command and option)`;
  return `Usage: ${binary} ${help.usage[0] ?? normalized}   (${binary} ${normalized} --help shows every form and option)`;
}

export const COMMON_COMMAND_HELP = {
  providers: {
    usage: ['providers [list]', 'providers current', 'providers inspect <provider>', 'providers use <provider> [modelRegistryKey]'],
    summary: 'Inspect and change provider setup, auth posture, model counts, and setup class.',
    examples: ['providers', 'providers inspect openai', 'providers use openai openai:gpt-6.1-sol'],
  },
  models: {
    usage: ['models [list] [provider|filter]', 'models current', 'models use|set <registryKey>', 'models pin <registryKey>', 'models unpin <registryKey>', 'models pinned', 'models recent'],
    summary: 'List, inspect, select, pin, and review model choices.',
    examples: ['models current', 'models openai', 'models use openai:gpt-5.4'],
  },
  secrets: {
    usage: [
      'secrets list',
      'secrets providers',
      'secrets test goodvibes://secrets/<source>/...',
      'secrets set <KEY> [--user|--project] [--secure|--plaintext]   (asks for the value without showing it; reads it from standard input when piped)',
      'secrets set <KEY> <value> [--user|--project] [--secure|--plaintext]   (the value stays in your shell history)',
      'secrets link <KEY> <ref> [--user|--project] [--secure|--plaintext]',
      'secrets delete <KEY> [--user|--project] [--secure|--plaintext]',
    ],
    summary: 'Manage GoodVibes secret records and secret references. Secret refs never embed secret values. --plaintext stores the value unencrypted.',
    examples: [
      'secrets set OPENAI_API_KEY --user',
      'secrets providers',
      'secrets test goodvibes://secrets/env/OPENAI_API_KEY',
      'secrets link OPENAI_API_KEY goodvibes://secrets/env/OPENAI_API_KEY',
    ],
  },
  pair: {
    usage: ['pair [--name <device name>]', 'qrcode'],
    summary: 'Mint a named, revocable device token on the connected host and print its pairing link and QR code.',
    examples: ['pair', 'pair --name "my phone"', 'qrcode'],
  },
  completion: {
    usage: ['completion <bash|zsh|fish>'],
    summary: 'Generate shell completion scripts.',
    examples: ['completion bash', 'completion zsh'],
  },
} as const satisfies Readonly<Record<string, TerminalCommandHelp>>;

/**
 * The first block of a terminal program's `--help`: the handful of things most
 * people run, before the full command list. `start` says what the bare
 * program opens; `also` adds a program's own rows after it.
 */
export function renderMostUsedHelp(binary: string, start: string, also: ReadonlyArray<readonly [string, string]> = []): string[] {
  const rows: ReadonlyArray<readonly [string, string]> = [
    [binary, start],
    ...also,
    [`${binary} run "<prompt>"`, 'Run one prompt and print the answer'],
    [`${binary} pair`, 'Pair a phone: print a link and a QR code to scan'],
    [`${binary} status`, 'Check what is set up and working'],
    ['goodvibes-daemon update --check', 'Look for an update now'],
  ];
  const width = Math.max(...rows.map(([command]) => command.length)) + 2;
  return ['Most used:', ...rows.map(([command, what]) => `  ${command.padEnd(width)}${what}`)];
}

export function normalizeHelpTopic(topic: string, aliases: Readonly<Partial<Record<string, string>>>): string {
  const normalized = topic.trim().toLowerCase();
  return (Object.hasOwn(aliases, normalized) ? aliases[normalized] : undefined) ?? normalized;
}

export function productVersionFromModule(moduleUrl: string, expectedName: string, fallback: string): string {
  return readProductPackageVersion(join(dirname(fileURLToPath(moduleUrl)), '..', '..', 'package.json'), expectedName) ?? fallback;
}
