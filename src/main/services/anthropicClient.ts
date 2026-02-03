// ============================================================================
// ANTHROPIC CLIENT - Claude API integration for tag suggestions
// ============================================================================

import { Logger } from './logger';
import type { SuggestionCategory, ScanCostEstimate } from '../../shared/types/tag-types';

const logger = new Logger('AnthropicClient');

// ============================================================================
// Types and Constants
// ============================================================================

/**
 * Result of a tag suggestion analysis
 */
export interface TagSuggestionResult {
  tagName: string;
  confidence: number; // 0-1
  category: SuggestionCategory;
  reasoning: string;
}

/**
 * Response format from Claude API
 * @internal Not directly used, but documents expected response structure
 */
interface _ClaudeResponse {
  suggestions: TagSuggestionResult[];
}

/**
 * Claude API configuration
 */
const CLAUDE_CONFIG = {
  model: 'claude-3-haiku-20240307',
  maxTokens: 1024,
  temperature: 0.3, // More deterministic for consistent tagging
  apiUrl: 'https://api.anthropic.com/v1/messages',
  apiVersion: '2023-06-01',
} as const;

/**
 * Token cost estimation constants (approximate)
 */
const TOKEN_COSTS = {
  inputTokensPer1M: 0.25, // $0.25 per 1M input tokens
  outputTokensPer1M: 1.25, // $1.25 per 1M output tokens
  avgInputTokensPerSession: 800, // Estimated average
  avgOutputTokens: 400, // Estimated average response
} as const;

/**
 * Retry configuration
 */
const RETRY_CONFIG = {
  maxAttempts: 3,
  initialDelayMs: 1000,
  maxDelayMs: 10000,
  backoffMultiplier: 2,
} as const;

// ============================================================================
// Custom Error Types
// ============================================================================

/**
 * Base error class for Anthropic API errors
 */
export class AnthropicApiError extends Error {
  constructor(
    message: string,
    public statusCode?: number,
    public errorType?: string,
    public retryable: boolean = false
  ) {
    super(message);
    this.name = 'AnthropicApiError';
  }
}

/**
 * Error for invalid API key
 */
export class InvalidApiKeyError extends AnthropicApiError {
  constructor(message: string = 'Invalid or missing Anthropic API key') {
    super(message, 401, 'invalid_api_key', false);
    this.name = 'InvalidApiKeyError';
  }
}

/**
 * Error for rate limiting
 */
export class RateLimitError extends AnthropicApiError {
  constructor(message: string = 'Rate limit exceeded', public retryAfterMs?: number) {
    super(message, 429, 'rate_limit', true);
    this.name = 'RateLimitError';
  }
}

/**
 * Error for malformed API responses
 */
export class ResponseValidationError extends AnthropicApiError {
  constructor(message: string) {
    super(message, undefined, 'validation_error', false);
    this.name = 'ResponseValidationError';
  }
}

// ============================================================================
// API Key Management
// ============================================================================

/**
 * Get API key from environment or settings
 * Priority: 1) ANTHROPIC_API_KEY env var, 2) Settings store
 */
function getApiKey(): string | null {
  // First check environment variable
  const envKey = process.env.ANTHROPIC_API_KEY;
  if (envKey && envKey.trim()) {
    return envKey.trim();
  }

  // TODO: Check settings store when available
  // const { getConfig } = require('./config');
  // return getConfig().anthropicApiKey;

  return null;
}

// ============================================================================
// Prompt Generation
// ============================================================================

/**
 * Generate the system prompt for tag suggestions
 */
function generatePrompt(context: string, existingTags: string[]): string {
  return `You are a tag suggestion system for Claude Code sessions. Analyze the session context and suggest relevant tags.

EXISTING TAGS IN SYSTEM:
${existingTags.length > 0 ? existingTags.join(', ') : 'No existing tags'}

SESSION CONTEXT:
${context}

Suggest 3-7 tags for this session. For each tag:
- Prefer existing tags when appropriate (higher confidence: 0.7-1.0)
- Suggest new tags when needed (lower confidence: 0.4-0.7)
- Provide confidence score (0-1) where:
  * 0.9-1.0: Very confident (clear match with existing tag)
  * 0.7-0.9: Confident (good fit with existing tag or obvious new tag)
  * 0.5-0.7: Moderate (reasonable new tag suggestion)
  * 0.4-0.5: Low confidence (speculative new tag)
- Categorize as one of:
  * task_type: bug-fix, feature, refactor, documentation, testing, optimization
  * technology: framework, library, language, tool names
  * domain: business domain, feature area
  * complexity: simple, moderate, complex, expert
  * outcome: success, partial, failed, blocked
  * pattern: design pattern, architectural pattern, code pattern
- Explain your reasoning briefly (1-2 sentences)

Respond ONLY with valid JSON in this exact format (no additional text):
{
  "suggestions": [
    {
      "tagName": "tag-name",
      "confidence": 0.85,
      "category": "technology",
      "reasoning": "Brief explanation"
    }
  ]
}`;
}

// ============================================================================
// Response Validation
// ============================================================================

/**
 * Validate that a value is a valid SuggestionCategory
 */
function isValidCategory(value: unknown): value is SuggestionCategory {
  const validCategories: SuggestionCategory[] = [
    'task_type',
    'technology',
    'domain',
    'complexity',
    'outcome',
    'pattern',
  ];
  return typeof value === 'string' && validCategories.includes(value as SuggestionCategory);
}

/**
 * Validate a single suggestion result
 */
function validateSuggestion(suggestion: unknown): TagSuggestionResult {
  if (typeof suggestion !== 'object' || suggestion === null) {
    throw new ResponseValidationError('Suggestion must be an object');
  }

  const s = suggestion as Record<string, unknown>;

  if (typeof s.tagName !== 'string' || !s.tagName.trim()) {
    throw new ResponseValidationError('tagName must be a non-empty string');
  }

  if (typeof s.confidence !== 'number' || s.confidence < 0 || s.confidence > 1) {
    throw new ResponseValidationError('confidence must be a number between 0 and 1');
  }

  if (!isValidCategory(s.category)) {
    throw new ResponseValidationError(
      `category must be one of: task_type, technology, domain, complexity, outcome, pattern`
    );
  }

  if (typeof s.reasoning !== 'string' || !s.reasoning.trim()) {
    throw new ResponseValidationError('reasoning must be a non-empty string');
  }

  return {
    tagName: s.tagName.trim(),
    confidence: s.confidence,
    category: s.category,
    reasoning: s.reasoning.trim(),
  };
}

/**
 * Parse and validate Claude API response
 */
function parseClaudeResponse(responseText: string): TagSuggestionResult[] {
  let parsed: unknown;

  try {
    parsed = JSON.parse(responseText);
  } catch {
    logger.error('Failed to parse Claude response as JSON', { responseText });
    throw new ResponseValidationError('Response is not valid JSON');
  }

  if (typeof parsed !== 'object' || parsed === null) {
    throw new ResponseValidationError('Response must be a JSON object');
  }

  const response = parsed as Record<string, unknown>;

  if (!Array.isArray(response.suggestions)) {
    throw new ResponseValidationError('Response must contain a suggestions array');
  }

  if (response.suggestions.length === 0) {
    logger.warn('Claude returned zero suggestions');
    return [];
  }

  if (response.suggestions.length > 10) {
    logger.warn(`Claude returned ${response.suggestions.length} suggestions, truncating to 10`);
    response.suggestions = response.suggestions.slice(0, 10);
  }

  return (response.suggestions as unknown[]).map((suggestion: unknown, index: number) => {
    try {
      return validateSuggestion(suggestion);
    } catch (err) {
      logger.warn(`Invalid suggestion at index ${index}`, { error: err, suggestion });
      throw err;
    }
  });
}

// ============================================================================
// Retry Logic
// ============================================================================

/**
 * Sleep for specified milliseconds
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Calculate exponential backoff delay
 */
function calculateBackoffDelay(attempt: number): number {
  const delay = RETRY_CONFIG.initialDelayMs * Math.pow(RETRY_CONFIG.backoffMultiplier, attempt - 1);
  return Math.min(delay, RETRY_CONFIG.maxDelayMs);
}

/**
 * Execute an async function with exponential backoff retry
 */
async function withRetry<T>(
  fn: () => Promise<T>,
  operation: string,
  attempt: number = 1
): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    // Don't retry non-retryable errors
    if (error instanceof AnthropicApiError && !error.retryable) {
      throw error;
    }

    // Check if we've exhausted retries
    if (attempt >= RETRY_CONFIG.maxAttempts) {
      logger.error(`${operation} failed after ${RETRY_CONFIG.maxAttempts} attempts`, { error });
      throw error;
    }

    // Calculate delay and retry
    const delayMs = calculateBackoffDelay(attempt);
    logger.warn(`${operation} failed (attempt ${attempt}/${RETRY_CONFIG.maxAttempts}), retrying in ${delayMs}ms`, {
      error: error instanceof Error ? error.message : String(error),
    });

    await sleep(delayMs);
    return withRetry(fn, operation, attempt + 1);
  }
}

// ============================================================================
// API Communication
// ============================================================================

/**
 * Call the Claude API with the given prompt
 */
async function callClaudeApi(prompt: string, apiKey: string): Promise<string> {
  const requestBody = {
    model: CLAUDE_CONFIG.model,
    max_tokens: CLAUDE_CONFIG.maxTokens,
    temperature: CLAUDE_CONFIG.temperature,
    messages: [
      {
        role: 'user',
        content: prompt,
      },
    ],
  };

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 30000); // 30 second timeout

  try {
    const response = await fetch(CLAUDE_CONFIG.apiUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': CLAUDE_CONFIG.apiVersion,
      },
      body: JSON.stringify(requestBody),
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    // Handle different status codes
    if (response.status === 401) {
      throw new InvalidApiKeyError('Invalid Anthropic API key');
    }

    if (response.status === 429) {
      const retryAfter = response.headers.get('retry-after');
      const retryAfterMs = retryAfter ? parseInt(retryAfter, 10) * 1000 : undefined;
      throw new RateLimitError('Rate limit exceeded', retryAfterMs);
    }

    if (response.status >= 500) {
      throw new AnthropicApiError(
        `Anthropic API server error: ${response.status}`,
        response.status,
        'server_error',
        true // Retryable
      );
    }

    if (!response.ok) {
      const errorText = await response.text();
      logger.error('Anthropic API error', { status: response.status, errorText });
      throw new AnthropicApiError(
        `Anthropic API error: ${response.status}`,
        response.status,
        'api_error',
        false
      );
    }

    const responseData: unknown = await response.json();

    // Extract text content from response
    const data = responseData as Record<string, unknown>;
    if (!data.content || !Array.isArray(data.content) || data.content.length === 0) {
      throw new ResponseValidationError('No content in API response');
    }

    const textContent = data.content.find((c: { type: string }) => c.type === 'text');
    if (!textContent || typeof textContent.text !== 'string') {
      throw new ResponseValidationError('No text content in API response');
    }

    return textContent.text;
  } catch (error) {
    clearTimeout(timeoutId);

    // Handle abort/timeout
    if (error instanceof Error && error.name === 'AbortError') {
      throw new AnthropicApiError('Request timeout', undefined, 'timeout', true);
    }

    // Re-throw our custom errors
    if (error instanceof AnthropicApiError) {
      throw error;
    }

    // Handle network errors
    if (error instanceof Error && error.message.includes('fetch')) {
      throw new AnthropicApiError(
        `Network error: ${error.message}`,
        undefined,
        'network_error',
        true
      );
    }

    // Unknown error
    throw new AnthropicApiError(
      error instanceof Error ? error.message : 'Unknown error',
      undefined,
      'unknown_error',
      false
    );
  }
}

// ============================================================================
// Main API Functions
// ============================================================================

/**
 * Generate tag suggestions for a session based on its context
 *
 * @param context - Formatted session context (from tagSuggestionContext)
 * @param existingTags - List of tags already in the system
 * @returns Array of tag suggestions with confidence scores
 * @throws {InvalidApiKeyError} If API key is missing or invalid
 * @throws {RateLimitError} If rate limit is exceeded
 * @throws {AnthropicApiError} For other API errors
 */
export async function generateTagSuggestions(
  context: string,
  existingTags: string[]
): Promise<TagSuggestionResult[]> {
  const startTime = Date.now();

  // Validate inputs
  if (!context || !context.trim()) {
    logger.warn('Empty context provided to generateTagSuggestions');
    return [];
  }

  // Get API key
  const apiKey = getApiKey();
  if (!apiKey) {
    throw new InvalidApiKeyError(
      'Anthropic API key not found. Set ANTHROPIC_API_KEY environment variable.'
    );
  }

  logger.info('Generating tag suggestions', {
    contextLength: context.length,
    existingTagCount: existingTags.length,
  });

  try {
    // Generate prompt
    const prompt = generatePrompt(context, existingTags);

    // Call API with retry logic
    const responseText = await withRetry(
      () => callClaudeApi(prompt, apiKey),
      'generateTagSuggestions'
    );

    // Parse and validate response
    const suggestions = parseClaudeResponse(responseText);

    const duration = Date.now() - startTime;
    logger.info('Tag suggestions generated successfully', {
      suggestionCount: suggestions.length,
      durationMs: duration,
    });

    return suggestions;
  } catch (err) {
    const duration = Date.now() - startTime;
    logger.error('Failed to generate tag suggestions', {
      error: err instanceof Error ? err.message : String(err),
      durationMs: duration,
    });
    throw err;
  }
}

// ============================================================================
// Cost Estimation
// ============================================================================

/**
 * Estimate the cost and time to scan a given number of sessions
 *
 * @param sessionCount - Number of sessions to scan
 * @param avgTokensPerSession - Average tokens per session context (optional)
 * @returns Cost estimate with token count, cost, and time
 */
export function estimateScanCost(
  sessionCount: number,
  avgTokensPerSession: number = TOKEN_COSTS.avgInputTokensPerSession
): ScanCostEstimate {
  // Calculate total tokens
  const totalInputTokens = sessionCount * avgTokensPerSession;
  const totalOutputTokens = sessionCount * TOKEN_COSTS.avgOutputTokens;

  // Calculate costs
  const inputCost = (totalInputTokens / 1_000_000) * TOKEN_COSTS.inputTokensPer1M;
  const outputCost = (totalOutputTokens / 1_000_000) * TOKEN_COSTS.outputTokensPer1M;
  const totalCost = inputCost + outputCost;

  // Estimate time (assume ~2 seconds per request with rate limiting)
  const estimatedTimeSeconds = sessionCount * 2;
  const estimatedTimeMinutes = Math.ceil(estimatedTimeSeconds / 60);

  return {
    totalSessions: sessionCount,
    estimatedTokens: totalInputTokens + totalOutputTokens,
    estimatedCost: Math.round(totalCost * 100) / 100, // Round to 2 decimal places
    estimatedTimeMinutes,
  };
}

// ============================================================================
// Batch Processing (Optional Optimization)
// ============================================================================

/**
 * Context for batch processing
 */
interface BatchContext {
  sessionId: string;
  context: string;
}

/**
 * Generate tag suggestions for multiple sessions in a single API call
 * This is an optimization that can reduce API costs and time
 *
 * @param contexts - Array of session contexts to analyze
 * @param existingTags - List of tags already in the system
 * @returns Map of session IDs to their suggestions
 *
 * NOTE: Currently processes sessions individually. Could be optimized to batch
 * multiple sessions in a single prompt for cost savings.
 */
export async function generateBatchSuggestions(
  contexts: BatchContext[],
  existingTags: string[]
): Promise<Map<string, TagSuggestionResult[]>> {
  const results = new Map<string, TagSuggestionResult[]>();

  logger.info('Starting batch tag suggestion generation', {
    batchSize: contexts.length,
  });

  // Process sequentially to avoid rate limits
  // TODO: Implement parallel processing with rate limiting
  for (const { sessionId, context } of contexts) {
    try {
      const suggestions = await generateTagSuggestions(context, existingTags);
      results.set(sessionId, suggestions);
    } catch (err) {
      logger.error(`Failed to generate suggestions for session ${sessionId}`, { error: err });
      // Continue processing other sessions
      results.set(sessionId, []);
    }
  }

  logger.info('Batch tag suggestion generation completed', {
    successCount: Array.from(results.values()).filter((s) => s.length > 0).length,
    totalCount: contexts.length,
  });

  return results;
}

// ============================================================================
// API Key Validation
// ============================================================================

/**
 * Test if the API key is valid by making a minimal API call
 *
 * @returns true if API key is valid, false otherwise
 */
export async function validateApiKey(): Promise<boolean> {
  const apiKey = getApiKey();
  if (!apiKey) {
    return false;
  }

  try {
    // Make a minimal API call to test the key
    await callClaudeApi('Respond with "OK"', apiKey);
    return true;
  } catch (err) {
    if (err instanceof InvalidApiKeyError) {
      return false;
    }
    // Other errors might be transient, so we'll consider the key potentially valid
    logger.warn('API key validation failed with non-auth error', { error: err });
    return true;
  }
}
