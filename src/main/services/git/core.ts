// ============================================================================
// GIT SERVICE - CORE FUNCTIONALITY
// ============================================================================

import { execFile } from 'child_process';
import { promisify } from 'util';
import { Logger } from '../logger.js';
import type { GitStatus } from '../../../shared/types/index.js';
import type { RateLimiterState, RateLimitConfig } from './types.js';

const execFileAsync = promisify(execFile);
export const logger = new Logger('Git');

export const GIT_TIMEOUT = 30000;
export const GIT_MAX_BUFFER = 1024 * 1024 * 10; // 10MB

// ============================================================================
// RATE LIMITING
// ============================================================================

// Token bucket rate limiter for Git operations
// Prevents abuse and protects against runaway scripts
const rateLimiter: RateLimiterState = {
  tokens: 50,        // Start with 50 tokens (allows burst)
  lastRefill: Date.now(),
};

const RATE_LIMIT_CONFIG: RateLimitConfig = {
  maxTokens: 50,     // Maximum tokens in bucket
  refillRate: 10,    // Tokens added per second
  tokensPerRequest: 1, // Tokens consumed per request
};

/**
 * Check if a request can proceed under rate limiting.
 * Uses a token bucket algorithm that allows bursts while limiting sustained rate.
 * @returns true if request is allowed, false if rate limited
 */
function checkRateLimit(): boolean {
  const now = Date.now();
  const timeSinceRefill = (now - rateLimiter.lastRefill) / 1000; // in seconds

  // Refill tokens based on time elapsed
  const tokensToAdd = Math.floor(timeSinceRefill * RATE_LIMIT_CONFIG.refillRate);
  if (tokensToAdd > 0) {
    rateLimiter.tokens = Math.min(
      RATE_LIMIT_CONFIG.maxTokens,
      rateLimiter.tokens + tokensToAdd
    );
    rateLimiter.lastRefill = now;
  }

  // Check if we have tokens available
  if (rateLimiter.tokens >= RATE_LIMIT_CONFIG.tokensPerRequest) {
    rateLimiter.tokens -= RATE_LIMIT_CONFIG.tokensPerRequest;
    return true;
  }

  return false;
}

/**
 * Runs a git command safely using execFile to prevent command injection.
 * Arguments are passed as an array, not interpolated into a shell string.
 * Includes rate limiting to prevent abuse.
 */
export async function runGitCommand(cwd: string, args: string[]): Promise<GitStatus> {
  // Apply rate limiting
  if (!checkRateLimit()) {
    logger.warn('Git operation rate limited', { cwd, command: args[0] });
    return {
      success: false,
      error: 'Too many Git operations. Please wait a moment and try again.',
    };
  }

  try {
    const { stdout, stderr } = await execFileAsync('git', args, {
      cwd,
      timeout: GIT_TIMEOUT,
      maxBuffer: GIT_MAX_BUFFER,
      windowsHide: true,
    });
    return { success: true, output: stdout.trim(), stderr: stderr.trim() };
  } catch (error: unknown) {
    const err = error as { message?: string; stderr?: string };
    return {
      success: false,
      error: err.message ?? 'Unknown error',
      stderr: err.stderr?.trim() ?? '',
    };
  }
}

/**
 * Validate branch name to prevent injection
 */
export function validateBranchName(branch: string): { valid: boolean; error?: string } {
  // Sanitize branch name - allow alphanumeric, dash, underscore, slash, and dots
  if (!/^[\w./-]+$/.test(branch)) {
    return { valid: false, error: 'Invalid branch name. Use only letters, numbers, dashes, underscores, slashes, and dots.' };
  }

  // Prevent directory traversal attempts
  if (branch.includes('..')) {
    return { valid: false, error: 'Invalid branch name' };
  }

  return { valid: true };
}

/**
 * Validate commit hash format
 */
export function validateCommitHash(hash: string): { valid: boolean; error?: string } {
  if (!/^[a-fA-F0-9]+$/.test(hash)) {
    return { valid: false, error: 'Invalid commit hash format' };
  }
  return { valid: true };
}

/**
 * Validate remote name
 */
export function validateRemoteName(name: string): { valid: boolean; error?: string } {
  if (!/^[\w-]+$/.test(name)) {
    return { valid: false, error: 'Invalid remote name' };
  }
  return { valid: true };
}
