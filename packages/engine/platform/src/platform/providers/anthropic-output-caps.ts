/**
 * Anthropic output caps from the documented model table, decided in code.
 *
 * platform.claude.com/docs/en/about-claude/models/overview and its legacy
 * models table: 128K for Fable 5, Mythos 5, Opus 5, Opus 4.8 / 4.7 / 4.6,
 * Sonnet 5 and Sonnet 4.6; 64K for Sonnet 4.5, Haiku 4.5, Opus 4.5, Sonnet 4
 * and Sonnet 3.7; 32K for Opus 4 and 4.1; 8192 for Claude 3.5 Sonnet and
 * Haiku; 4096 for Claude 3 Opus, Sonnet and Haiku and every earlier Claude.
 */
import { knownCatalogMaxOutput } from './model-catalog-facts.js';

const DOCUMENTED_OUTPUT_CAPS: ReadonlyMap<string, number> = new Map([
  ...['claude-fable-5', 'claude-mythos-5', 'claude-opus-5', 'claude-opus-4-8', 'claude-opus-4-7', 'claude-opus-4-6',
    'claude-sonnet-5', 'claude-sonnet-4-6'].map((id) => [id, 128_000] as const),
  ...['claude-sonnet-4-5', 'claude-haiku-4-5', 'claude-opus-4-5', 'claude-sonnet-4', 'claude-3-7-sonnet'].map((id) => [id, 64_000] as const),
  ...['claude-opus-4', 'claude-opus-4-1'].map((id) => [id, 32_000] as const),
  ...['claude-3-5-sonnet', 'claude-3-5-haiku'].map((id) => [id, 8_192] as const),
  ...['claude-3-opus', 'claude-3-sonnet', 'claude-3-haiku'].map((id) => [id, 4_096] as const),
]);

/**
 * The cap of a model with no documented row: the smallest documented cap,
 * since a max_tokens above a model's real cap is a 400 on every request.
 */
export const ANTHROPIC_SMALLEST_OUTPUT_CAP = 4_096;

/** `claude-sonnet-4-5-20250929`, `anthropic/claude-sonnet-4-5` and `claude-sonnet-4-5-latest` name `claude-sonnet-4-5`. */
function documentedModelKey(model: string): string {
  // A compat adapter may pass an omitted model through; it has no row.
  return (typeof model === 'string' ? model : '').trim().toLowerCase()
    .replace(/^anthropic[:/]/, '')
    .replace(/-latest$/, '')
    .replace(/-\d{8}$/, '');
}

/** The documented cap of a Claude model id, or undefined for an id the table does not name. */
export function documentedAnthropicOutputCap(model: string): number | undefined {
  return DOCUMENTED_OUTPUT_CAPS.get(documentedModelKey(model));
}

/** Repository output limit, then the documented table, then the smallest documented cap. Live endpoint limits win in the adapter. */
export function documentedMaxOutput(model: string): number {
  return knownCatalogMaxOutput('anthropic', model) ?? documentedAnthropicOutputCap(model) ?? ANTHROPIC_SMALLEST_OUTPUT_CAP;
}
