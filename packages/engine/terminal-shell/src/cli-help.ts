import { existsSync, readFileSync } from 'node:fs';
export interface TerminalCommandHelp {
  readonly usage: readonly string[];
  readonly summary: string;
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

export const COMMON_COMMAND_HELP = {
  providers: {
    usage: ['providers [list]', 'providers current', 'providers inspect <provider>', 'providers use <provider> [modelRegistryKey]'],
    summary: 'Inspect and change provider setup, auth posture, model counts, and setup class.',
    examples: ['providers', 'providers inspect openai-subscriber', 'providers use openai openai:gpt-5.4'],
  },
  models: {
    usage: ['models [provider]', 'models current', 'models use <registryKey>', 'models pin <registryKey>', 'models recent'],
    summary: 'List, inspect, select, pin, and review model choices.',
    examples: ['models current', 'models openai', 'models use openai:gpt-5.4'],
  },
  secrets: {
    usage: [
      'secrets list',
      'secrets providers',
      'secrets test goodvibes://secrets/<source>/...',
      'secrets set <KEY> <value>',
      'secrets link <KEY> <ref>',
    ],
    summary: 'Manage GoodVibes secret records and secret references. Secret refs never embed secret values.',
    examples: [
      'secrets providers',
      'secrets test goodvibes://secrets/env/OPENAI_API_KEY',
      'secrets link OPENAI_API_KEY goodvibes://secrets/env/OPENAI_API_KEY',
    ],
  },
  pair: {
    usage: ['pair', 'qrcode'],
    summary: 'Print companion pairing connection details and a QR code.',
    examples: ['pair', 'qrcode'],
  },
  completion: {
    usage: ['completion <bash|zsh|fish>'],
    summary: 'Generate shell completion scripts.',
    examples: ['completion bash', 'completion zsh'],
  },
} as const satisfies Readonly<Record<string, TerminalCommandHelp>>;

export function normalizeHelpTopic(topic: string, aliases: Readonly<Partial<Record<string, string>>>): string {
  const normalized = topic.trim().toLowerCase();
  return (Object.hasOwn(aliases, normalized) ? aliases[normalized] : undefined) ?? normalized;
}
