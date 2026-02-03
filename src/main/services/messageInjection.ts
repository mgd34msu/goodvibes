// ============================================================================
// MESSAGE INJECTION SERVICE (P1) - First Message Injection
// ============================================================================

import { EventEmitter } from 'events';
import { Logger } from './logger.js';
import { getAgentRegistry } from './agentRegistry.js';

const logger = new Logger('MessageInjection');

// ============================================================================
// TYPES
// ============================================================================

export interface InjectionConfig {
  terminalId: number;
  agentId: string;
  message: string;
  delayMs?: number;
  waitForReady?: boolean;
  retryOnFailure?: boolean;
  maxRetries?: number;
}

export interface InjectionResult {
  success: boolean;
  terminalId: number;
  agentId: string;
  message: string;
  injectedAt?: number;
  error?: string;
}

export interface ReadyPatterns {
  positive: RegExp[];
  negative: RegExp[];
}

// ============================================================================
// DEFAULT PATTERNS
// ============================================================================

/**
 * Patterns that indicate Claude is ready to receive input
 */
const DEFAULT_READY_PATTERNS: ReadyPatterns = {
  positive: [
    // Common Claude ready prompts
    /^>\s*$/m,                           // Simple ">" prompt
    /^claude>\s*$/m,                     // "claude>" prompt
    /^.*\$\s*$/m,                        // Shell-like prompt ending with $
    /What would you like to work on\?/i, // Claude's common greeting
    /How can I help/i,                   // Help prompt
    /Ready for your input/i,             // Explicit ready message
    /\n>\s*$/,                           // Prompt at end of output
  ],
  negative: [
    // Patterns that indicate Claude is still processing
    /Thinking\.\.\./i,
    /Processing\.\.\./i,
    /Loading\.\.\./i,
    /Analyzing\.\.\./i,
    /Searching\.\.\./i,
    /Executing\.\.\./i,
    /^\.{3,}$/m,                         // Just dots
  ],
};

// ============================================================================
// MESSAGE INJECTION SERVICE
// ============================================================================

class MessageInjectionService extends EventEmitter {
  private pendingInjections: Map<number, InjectionConfig[]> = new Map();
  private readyTerminals: Set<number> = new Set();
  private outputBuffers: Map<number, string> = new Map();
  private readyPatterns: ReadyPatterns = DEFAULT_READY_PATTERNS;
  private injectionTimeouts: Map<string, NodeJS.Timeout> = new Map();

  constructor() {
    super();
    this.setMaxListeners(100);
  }

  // ============================================================================
  // READY STATE DETECTION
  // ============================================================================

  /**
   * Process terminal output to detect ready state
   */
  processOutput(terminalId: number, data: string): void {
    // Add to buffer
    const buffer = (this.outputBuffers.get(terminalId) || '') + data;

    // Keep buffer size manageable (last 10KB)
    const maxBufferSize = 10240;
    const trimmedBuffer = buffer.length > maxBufferSize
      ? buffer.slice(-maxBufferSize)
      : buffer;

    this.outputBuffers.set(terminalId, trimmedBuffer);

    // Check for ready state
    const isReady = this.detectReadyState(trimmedBuffer);

    if (isReady && !this.readyTerminals.has(terminalId)) {
      this.readyTerminals.add(terminalId);
      this.emit('terminal:ready', terminalId);
      logger.debug(`Terminal ${terminalId} is ready for input`);

      // Process any pending injections
      this.processPendingInjections(terminalId);
    } else if (!isReady && this.readyTerminals.has(terminalId)) {
      // Terminal became busy
      this.readyTerminals.delete(terminalId);
      this.emit('terminal:busy', terminalId);
      logger.debug(`Terminal ${terminalId} is busy`);
    }
  }

  /**
   * Detect if Claude is ready for input based on output patterns
   */
  private detectReadyState(buffer: string): boolean {
    // Check for negative patterns first (still processing)
    for (const pattern of this.readyPatterns.negative) {
      if (pattern.test(buffer.slice(-500))) { // Only check last 500 chars
        return false;
      }
    }

    // Check for positive patterns
    for (const pattern of this.readyPatterns.positive) {
      if (pattern.test(buffer.slice(-500))) {
        return true;
      }
    }

    // Default: not ready
    return false;
  }

  /**
   * Check if a terminal is ready for input
   */
  isTerminalReady(terminalId: number): boolean {
    return this.readyTerminals.has(terminalId);
  }

  /**
   * Force mark a terminal as ready (use with caution)
   */
  forceReady(terminalId: number): void {
    this.readyTerminals.add(terminalId);
    this.emit('terminal:ready', terminalId);
    this.processPendingInjections(terminalId);
  }

  /**
   * Clear ready state for a terminal
   */
  clearReadyState(terminalId: number): void {
    this.readyTerminals.delete(terminalId);
    this.outputBuffers.delete(terminalId);
  }

  /**
   * Set custom ready patterns
   */
  setReadyPatterns(patterns: Partial<ReadyPatterns>): void {
    if (patterns.positive) {
      this.readyPatterns.positive = patterns.positive;
    }
    if (patterns.negative) {
      this.readyPatterns.negative = patterns.negative;
    }
  }

  // ============================================================================
  // MESSAGE INJECTION
  // ============================================================================

  /**
   * Queue a message for injection
   */
  queueInjection(config: InjectionConfig): void {
    const pending = this.pendingInjections.get(config.terminalId) || [];
    pending.push(config);
    this.pendingInjections.set(config.terminalId, pending);

    logger.debug(`Queued injection for terminal ${config.terminalId}`, {
      message: config.message.slice(0, 50) + '...',
      waitForReady: config.waitForReady,
    });

    // If not waiting for ready, or already ready, process now
    if (!config.waitForReady || this.isTerminalReady(config.terminalId)) {
      this.processPendingInjections(config.terminalId);
    }
  }

  /**
   * Inject a message immediately (without queuing)
   */
  async injectImmediate(
    terminalId: number,
    message: string,
    writeToTerminal: (id: number, data: string) => void
  ): Promise<InjectionResult> {
    try {
      // Add newline if not present
      const finalMessage = message.endsWith('\n') ? message : message + '\n';

      // Write to terminal
      writeToTerminal(terminalId, finalMessage);

      // Mark terminal as busy
      this.readyTerminals.delete(terminalId);
      this.emit('terminal:busy', terminalId);

      const result: InjectionResult = {
        success: true,
        terminalId,
        agentId: '',
        message,
        injectedAt: Date.now(),
      };

      this.emit('injection:complete', result);
      logger.info(`Injected message to terminal ${terminalId}`);

      return result;
    } catch (error) {
      const result: InjectionResult = {
        success: false,
        terminalId,
        agentId: '',
        message,
        error: (error as Error).message,
      };

      this.emit('injection:failed', result);
      logger.error(`Failed to inject message to terminal ${terminalId}`, error);

      return result;
    }
  }

  /**
   * Process pending injections for a terminal
   */
  private processPendingInjections(terminalId: number): void {
    const pending = this.pendingInjections.get(terminalId);
    if (!pending || pending.length === 0) return;

    // Get the first pending injection
    const injection = pending[0];

    // Check if we need to wait for ready state
    if (injection.waitForReady && !this.isTerminalReady(terminalId)) {
      logger.debug(`Waiting for terminal ${terminalId} to be ready`);
      return;
    }

    // Apply delay if specified
    if (injection.delayMs && injection.delayMs > 0) {
      const timeoutKey = `${terminalId}-${injection.agentId}`;

      // Clear any existing timeout
      const existingTimeout = this.injectionTimeouts.get(timeoutKey);
      if (existingTimeout) {
        clearTimeout(existingTimeout);
      }

      const timeout = setTimeout(() => {
        this.injectionTimeouts.delete(timeoutKey);
        this.executeInjection(terminalId, injection);
      }, injection.delayMs);

      this.injectionTimeouts.set(timeoutKey, timeout);
      return;
    }

    // Execute immediately
    this.executeInjection(terminalId, injection);
  }

  /**
   * Execute a pending injection
   */
  private executeInjection(terminalId: number, injection: InjectionConfig): void {
    const pending = this.pendingInjections.get(terminalId) || [];

    // Remove from pending
    const index = pending.indexOf(injection);
    if (index > -1) {
      pending.splice(index, 1);
      this.pendingInjections.set(terminalId, pending);
    }

    // Emit event for actual injection (the caller handles the PTY write)
    this.emit('injection:execute', {
      terminalId,
      agentId: injection.agentId,
      message: injection.message,
    });

    logger.debug(`Executing injection for terminal ${terminalId}`);

    // Update agent registry if agent ID provided
    if (injection.agentId) {
      const registry = getAgentRegistry();
      if (registry) {
        registry.markActive(injection.agentId);
      }
    }

    // Mark terminal as busy
    this.readyTerminals.delete(terminalId);
    this.emit('terminal:busy', terminalId);

    // Process next pending injection if any
    if (pending.length > 0) {
      // Wait for next ready state
      // The processPendingInjections will be called when terminal becomes ready again
    }
  }

  /**
   * Cancel pending injections for a terminal
   */
  cancelPendingInjections(terminalId: number): void {
    this.pendingInjections.delete(terminalId);

    // Clear any pending timeouts
    for (const [key, timeout] of this.injectionTimeouts) {
      if (key.startsWith(`${terminalId}-`)) {
        clearTimeout(timeout);
        this.injectionTimeouts.delete(key);
      }
    }

    logger.debug(`Cancelled pending injections for terminal ${terminalId}`);
  }

  /**
   * Get pending injection count for a terminal
   */
  getPendingCount(terminalId: number): number {
    return this.pendingInjections.get(terminalId)?.length || 0;
  }

  // ============================================================================
  // CONVENIENCE METHODS
  // ============================================================================

  /**
   * Inject initial prompt when agent becomes ready
   */
  injectOnReady(
    terminalId: number,
    agentId: string,
    message: string,
    delayMs: number = 500
  ): void {
    this.queueInjection({
      terminalId,
      agentId,
      message,
      delayMs,
      waitForReady: true,
    });
  }

  /**
   * Inject a task after current processing completes
   */
  injectAfterCurrent(
    terminalId: number,
    agentId: string,
    message: string
  ): void {
    this.queueInjection({
      terminalId,
      agentId,
      message,
      waitForReady: true,
    });
  }

  /**
   * Inject with role/persona prefix
   */
  injectWithRole(
    terminalId: number,
    agentId: string,
    role: string,
    task: string
  ): void {
    const message = `You are a ${role}. ${task}`;
    this.queueInjection({
      terminalId,
      agentId,
      message,
      waitForReady: true,
    });
  }

  // ============================================================================
  // CLEANUP
  // ============================================================================

  /**
   * Clear all state for a terminal
   */
  clearTerminal(terminalId: number): void {
    this.readyTerminals.delete(terminalId);
    this.outputBuffers.delete(terminalId);
    this.cancelPendingInjections(terminalId);
  }

  /**
   * Shutdown the service
   */
  shutdown(): void {
    // Clear all timeouts
    for (const timeout of this.injectionTimeouts.values()) {
      clearTimeout(timeout);
    }
    this.injectionTimeouts.clear();

    // Clear all state
    this.pendingInjections.clear();
    this.readyTerminals.clear();
    this.outputBuffers.clear();

    this.removeAllListeners();
    logger.info('Message Injection service shut down');
  }
}

// ============================================================================
// SINGLETON INSTANCE
// ============================================================================

let messageInjection: MessageInjectionService | null = null;

export function getMessageInjection(): MessageInjectionService {
  if (!messageInjection) {
    messageInjection = new MessageInjectionService();
  }
  return messageInjection;
}

export function shutdownMessageInjection(): void {
  if (messageInjection) {
    messageInjection.shutdown();
    messageInjection = null;
  }
}

// Export the class for testing
export { MessageInjectionService };
