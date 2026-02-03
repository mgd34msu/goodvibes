// ============================================================================
// SESSION MANAGER - COST CALCULATION
// ============================================================================

import {
  CACHE_WRITE_5M_MULTIPLIER,
  CACHE_READ_MULTIPLIER,
  LONG_CONTEXT_THRESHOLD,
  LONG_CONTEXT_INPUT_MULTIPLIER,
  LONG_CONTEXT_OUTPUT_MULTIPLIER,
  DEFAULT_INPUT_PRICE,
  DEFAULT_OUTPUT_PRICE,
} from '../../../shared/constants.js';
import { getPricing } from './pricing-fetcher.js';
import type { TokenStats } from './types.js';

// ============================================================================
// COST CALCULATION
// ============================================================================

/**
 * Calculates the cost of a session based on token usage and model.
 * Uses model-specific pricing and proper cache token multipliers.
 *
 * Pricing rules:
 * - Pricing fetched automatically from Anthropic (cached for 24 hours)
 * - Falls back to hardcoded values if fetch fails
 * - Cache write (5m): 1.25x input price
 * - Cache read: 0.1x input price
 * - Long context (Sonnet 4/4.5 only, >200K input tokens): 2x input, 1.5x output
 *
 * Historical pricing:
 * - If sessionTimestamp is provided, uses pricing that was in effect at that time
 * - This ensures older sessions retain their original costs even after price changes
 *
 * Pricing source: https://platform.claude.com/docs/en/about-claude/pricing
 */
export async function calculateCost(
  tokenStats: TokenStats,
  model: string | null,
  sessionTimestamp?: string | Date
): Promise<number> {
  // Normalize model name to match our pricing keys
  // e.g., "claude-opus-4-5-20251101" -> "claude-opus-4-5"
  const normalizedModel = model
    ? model.replace(/-\d{8}$/, '').replace(/_/g, '-')
    : null;

  // Get pricing for this model from the pricing fetcher
  // If sessionTimestamp is provided, use historical pricing from that date
  let pricing = normalizedModel 
    ? await getPricing(normalizedModel, sessionTimestamp) 
    : undefined;
  
  // Fall back to defaults if pricing not found
  if (!pricing) {
    pricing = {
      input: DEFAULT_INPUT_PRICE,
      output: DEFAULT_OUTPUT_PRICE,
    };
  }

  // Check if this is a Sonnet model eligible for long context pricing
  const isSonnet = normalizedModel?.includes('sonnet-4');
  const totalInputTokens = tokenStats.inputTokens + tokenStats.cacheWriteTokens + tokenStats.cacheReadTokens;
  const isLongContext = isSonnet && totalInputTokens > LONG_CONTEXT_THRESHOLD;

  // Apply long context multipliers if applicable
  const inputPrice = isLongContext ? pricing.input * LONG_CONTEXT_INPUT_MULTIPLIER : pricing.input;
  const outputPrice = isLongContext ? pricing.output * LONG_CONTEXT_OUTPUT_MULTIPLIER : pricing.output;

  // Calculate costs per token type
  const inputCost = (tokenStats.inputTokens * inputPrice) / 1_000_000;
  const outputCost = (tokenStats.outputTokens * outputPrice) / 1_000_000;

  // Cache write tokens cost 1.25x base input price (or long context price if applicable)
  const cacheWriteCost = (tokenStats.cacheWriteTokens * inputPrice * CACHE_WRITE_5M_MULTIPLIER) / 1_000_000;

  // Cache read tokens cost 0.1x base input price (or long context price if applicable)
  const cacheReadCost = (tokenStats.cacheReadTokens * inputPrice * CACHE_READ_MULTIPLIER) / 1_000_000;

  return inputCost + outputCost + cacheWriteCost + cacheReadCost;
}
