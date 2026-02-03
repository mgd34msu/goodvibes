// ============================================================================
// SESSION MANAGER - COST CALCULATION
// ============================================================================

import {
  MODEL_PRICING,
  CACHE_WRITE_MULTIPLIER,
  CACHE_READ_MULTIPLIER,
  DEFAULT_INPUT_PRICE,
  DEFAULT_OUTPUT_PRICE,
} from '../../../shared/constants.js';
import type { TokenStats } from './types.js';

// ============================================================================
// COST CALCULATION
// ============================================================================

/**
 * Calculates the cost of a session based on token usage and model.
 * Uses model-specific pricing and proper cache token multipliers.
 *
 * Pricing source: https://platform.claude.com/docs/en/about-claude/pricing
 */
export function calculateCost(tokenStats: TokenStats, model: string | null): number {
  // Normalize model name to match our pricing keys
  // e.g., "claude-opus-4-5-20251101" -> "claude-opus-4-5"
  const normalizedModel = model
    ? model.replace(/-\d{8}$/, '').replace(/_/g, '-')
    : null;

  // Get pricing for this model, fall back to defaults
  const pricing = (normalizedModel && MODEL_PRICING[normalizedModel]) || {
    input: DEFAULT_INPUT_PRICE,
    output: DEFAULT_OUTPUT_PRICE,
  };

  // Calculate costs per token type
  const inputCost = (tokenStats.inputTokens * pricing.input) / 1_000_000;
  const outputCost = (tokenStats.outputTokens * pricing.output) / 1_000_000;

  // Cache write tokens cost 1.25x base input price
  const cacheWriteCost = (tokenStats.cacheWriteTokens * pricing.input * CACHE_WRITE_MULTIPLIER) / 1_000_000;

  // Cache read tokens cost 0.1x base input price
  const cacheReadCost = (tokenStats.cacheReadTokens * pricing.input * CACHE_READ_MULTIPLIER) / 1_000_000;

  return inputCost + outputCost + cacheWriteCost + cacheReadCost;
}
