// ============================================================================
// TAG SUGGESTION SERVICE - Background AI Tagging System
// ============================================================================
//
// Manages background AI tag suggestion scanning with priority queue and rate limiting.
// Processes sessions in LIFO order within priority levels, respecting API rate limits.
//
// ============================================================================

import { EventEmitter } from 'events';
import { Logger } from './logger.js';
import type {
  TagSuggestion,
  ScanProgress,
  ScanStatusInfo,
  ScanStatus,
} from '../../shared/types/tag-types.js';

import { gatherQuickContext, formatContextForPrompt } from './tagSuggestionContext.js';
import { 
  generateTagSuggestionsViaCli, 
  generateBatchTagSuggestions,
  archiveTaggingSession,
  type TagSuggestionContext 
} from './claudeCliClient.js';
import * as tagSuggestions from '../database/tagSuggestions.js';
import * as db from '../database/index.js';

const logger = new Logger('TagSuggestionService');

// ============================================================================
// TYPES
// ============================================================================

/**
 * Priority level for scan queue items
 */
type Priority = 'high' | 'medium' | 'low';

/**
 * Item in the scan queue
 */
interface ScanQueueItem {
  sessionId: string;
  priority: Priority;
  queuedAt: number; // Timestamp for LIFO ordering
}

/**
 * Configuration for the tag suggestion service
 */
interface ServiceConfig {
  /** Maximum sessions to scan per hour (for rate limiting) */
  maxSessionsPerHour: number;
  /** Number of sessions to scan in each batch */
  batchSize: number;
  /** Interval in milliseconds between batch processing */
  processingIntervalMs: number;
}

/**
 * Event types emitted by the service
 */
interface ServiceEvents {
  progress: [progress: ScanProgress];
  complete: [sessionId: string, suggestions: TagSuggestion[]];
  error: [error: Error, sessionId?: string];
  queueChanged: [queueSize: number];
  statusChanged: [status: ScanStatusInfo];
}

// ============================================================================
// PRIORITY QUEUE IMPLEMENTATION
// ============================================================================

/**
 * Priority queue with LIFO ordering within priority levels
 * Higher priority items are processed first, newest items within same priority are processed first
 */
class PriorityQueue<T extends ScanQueueItem> {
  private items: T[] = [];
  private priorityOrder: Record<Priority, number> = {
    high: 3,
    medium: 2,
    low: 1,
  };

  /**
   * Add item to queue
   */
  enqueue(item: T): void {
    this.items.push(item);
    this.sort();
  }

  /**
   * Remove and return highest priority, newest item
   */
  dequeue(): T | undefined {
    return this.items.shift();
  }

  /**
   * Get queue size
   */
  size(): number {
    return this.items.length;
  }

  /**
   * Check if queue is empty
   */
  isEmpty(): boolean {
    return this.items.length === 0;
  }

  /**
   * Clear all items
   */
  clear(): void {
    this.items = [];
  }

  /**
   * Check if session is already queued
   */
  has(sessionId: string): boolean {
    return this.items.some((item) => item.sessionId === sessionId);
  }

  /**
   * Get all items (for inspection)
   */
  getAll(): readonly T[] {
    return [...this.items];
  }

  /**
   * Sort queue by priority (descending) then by queuedAt (descending for LIFO)
   */
  private sort(): void {
    this.items.sort((a, b) => {
      const priorityDiff = this.priorityOrder[b.priority] - this.priorityOrder[a.priority];
      if (priorityDiff !== 0) return priorityDiff;
      // LIFO within same priority: newer first
      return b.queuedAt - a.queuedAt;
    });
  }
}

// ============================================================================
// RATE LIMITER IMPLEMENTATION
// ============================================================================

/**
 * Token bucket rate limiter
 * Ensures we don't exceed API rate limits
 */
class RateLimiter {
  private tokens: number;
  private lastRefill: number;

  constructor(
    private readonly maxTokens: number,
    private readonly refillIntervalMs: number = 3600000, // 1 hour default
  ) {
    this.tokens = maxTokens;
    this.lastRefill = Date.now();
  }

  /**
   * Try to consume a token. Returns true if token available, false otherwise.
   */
  tryConsume(): boolean {
    this.refill();
    if (this.tokens > 0) {
      this.tokens--;
      return true;
    }
    return false;
  }

  /**
   * Get remaining tokens
   */
  getRemainingTokens(): number {
    this.refill();
    return this.tokens;
  }

  /**
   * Get time until next token is available (ms)
   */
  getTimeUntilNextToken(): number {
    if (this.tokens > 0) return 0;
    const timeSinceRefill = Date.now() - this.lastRefill;
    return Math.max(0, this.refillIntervalMs - timeSinceRefill);
  }

  /**
   * Refill tokens based on elapsed time
   */
  private refill(): void {
    const now = Date.now();
    const elapsed = now - this.lastRefill;

    if (elapsed >= this.refillIntervalMs) {
      this.tokens = this.maxTokens;
      this.lastRefill = now;
    }
  }
}

// ============================================================================
// TAG SUGGESTION SERVICE
// ============================================================================

/**
 * Background service for AI-powered tag suggestions
 * Processes sessions in priority order with rate limiting
 */
class TagSuggestionService extends EventEmitter {
  private queue: PriorityQueue<ScanQueueItem>;
  private rateLimiter: RateLimiter;
  private isRunning: boolean = false;
  private isPaused: boolean = false;
  private currentSessionId: string | null = null;
  private processingInterval: NodeJS.Timeout | null = null;
  private isProcessingBatch: boolean = false;
  private scannedCount: number = 0;
  private totalSessionsToScan: number = 0;
  private lastError: string | null = null;

  constructor(private config: ServiceConfig) {
    super();
    this.queue = new PriorityQueue<ScanQueueItem>();
    this.rateLimiter = new RateLimiter(config.maxSessionsPerHour);

    logger.info('TagSuggestionService initialized', {
      maxSessionsPerHour: config.maxSessionsPerHour,
      batchSize: config.batchSize,
      processingIntervalMs: config.processingIntervalMs,
    });
  }

  // ============================================================================
  // LIFECYCLE METHODS
  // ============================================================================

  /**
   * Start the background processing loop
   */
  start(): void {
    if (this.isRunning) {
      logger.warn('Service already running');
      return;
    }

    this.isRunning = true;
    this.isPaused = false;
    logger.info('Starting tag suggestion service');

    this.processingInterval = setInterval(
      () => this.processQueue(),
      this.config.processingIntervalMs,
    );

    this.emitStatusChanged();
  }

  /**
   * Stop the background processing loop
   */
  stop(): void {
    if (!this.isRunning) {
      logger.warn('Service not running');
      return;
    }

    this.isRunning = false;
    this.isPaused = false;
    logger.info('Stopping tag suggestion service');

    if (this.processingInterval) {
      clearInterval(this.processingInterval);
      this.processingInterval = null;
    }

    this.isProcessingBatch = false;
    this.emitStatusChanged();
  }

  /**
   * Pause processing (keeps queue, stops scanning)
   */
  pause(): void {
    if (!this.isRunning || this.isPaused) {
      logger.warn('Cannot pause: service not running or already paused');
      return;
    }

    this.isPaused = true;
    logger.info('Pausing tag suggestion service');
    this.emitStatusChanged();
  }

  /**
   * Resume processing after pause
   */
  resume(): void {
    if (!this.isRunning || !this.isPaused) {
      logger.warn('Cannot resume: service not running or not paused');
      return;
    }

    this.isPaused = false;
    logger.info('Resuming tag suggestion service');
    this.emitStatusChanged();
  }

  // ============================================================================
  // QUEUE MANAGEMENT
  // ============================================================================

  /**
   * Add a session to the scan queue
   */
  queueSession(sessionId: string, priority: Priority = 'medium'): void {
    if (this.queue.has(sessionId)) {
      logger.debug(`Session ${sessionId} already queued`);
      return;
    }

    const item: ScanQueueItem = {
      sessionId,
      priority,
      queuedAt: Date.now(),
    };

    this.queue.enqueue(item);
    logger.debug(`Queued session ${sessionId} with priority ${priority}`);

    this.emit('queueChanged', this.queue.size());
    this.emitProgress();
  }

  /**
   * Queue all sessions pending AI suggestions
   * Queries database for sessions without AI suggestions and adds them to queue
   */
  async queueAllPending(): Promise<void> {
    logger.info('Queueing all pending sessions...');

    try {
      // Query database for sessions without AI suggestions
      const pendingSessions = tagSuggestions.getPendingSessions(); // No limit - queue all pending
      
      // Check if agent session scanning is enabled
      const scanAgentSessions = db.getSetting<boolean>('tagScanAgentSessions') ?? false;

      for (const sessionId of pendingSessions) {
        // Skip agent sessions if the setting is disabled
        if (sessionId.startsWith('agent-') && !scanAgentSessions) {
          continue;
        }
        
        // User sessions get medium priority, agent sessions get low priority
        // This ensures user sessions are processed before agent sessions
        const priority = sessionId.startsWith('agent-') ? 'low' : 'medium';
        this.queueSession(sessionId, priority);
      }

      logger.info(`Queued ${pendingSessions.length} pending sessions`);
    } catch (error) {
      logger.error('Failed to queue pending sessions:', error);
      this.emit('error', error as Error);
    }
  }

  // ============================================================================
  // SCANNING METHODS
  // ============================================================================

  /**
   * Scan a batch of sessions in a single Claude CLI call
   * This is much more efficient than calling scanSession() for each one
   */
  private async scanSessionBatch(sessionIds: string[]): Promise<void> {
    if (sessionIds.length === 0) {
      return;
    }

    logger.info(`Scanning batch of ${sessionIds.length} sessions...`);

    try {
      // 1. Gather context for ALL sessions
      const sessionContexts: Array<{ sessionId: string; context: TagSuggestionContext; filePath?: string }> = [];
      
      for (const sessionId of sessionIds) {
        const quickContext = gatherQuickContext(sessionId);
        
        if (!quickContext) {
          logger.warn(`Session ${sessionId} not found or has no context, marking as failed`);
          tagSuggestions.updateSessionScanStatus(sessionId, 'failed', 'quick');
          continue;
        }
        
        // Get file path from database
        const session = db.getSession(sessionId);
        
        // Skip if session doesn't exist in DB (not imported yet)
        if (!session) {
          logger.warn(`Session ${sessionId} not found in database, skipping`);
          continue;
        }
        
        const filePath = session?.filePath ?? undefined;
        
        // Convert SessionContext to TagSuggestionContext format
        const context: TagSuggestionContext = {
          projectPath: quickContext.projectName ?? undefined,
          recentMessages: [
            ...quickContext.userMessages.map(content => ({ role: 'user', content })),
            ...quickContext.assistantMessages.map(content => ({ role: 'assistant', content }))
          ],
          toolsUsed: quickContext.toolsUsed,
          existingTags: quickContext.existingTags,
        };
        
        sessionContexts.push({ sessionId, context, filePath });
      }

      if (sessionContexts.length === 0) {
        logger.warn('No valid sessions in batch');
        return;
      }

      // 2. ONE CLI call for all sessions
      const results = await generateBatchTagSuggestions(sessionContexts);

      // Archive the CLI session that was created
      archiveTaggingSession().catch(err => {
        logger.warn('Failed to archive tagging session after batch CLI call', { error: err });
      });

      // 3. Save suggestions for each session
      for (const [sessionId, tags] of results) {
        if (tags.length === 0) {
          logger.warn(`No tags generated for session ${sessionId}`);
          tagSuggestions.updateSessionScanStatus(sessionId, 'completed', 'quick');
          continue;
        }

        const suggestions = tagSuggestions.createSuggestions(
          tags.map(tag => ({
            sessionId,
            tagName: tag.name,
            confidence: tag.confidence,
            category: tag.category || 'other',
            reasoning: tag.reasoning,
          }))
        );

        tagSuggestions.updateSessionScanStatus(sessionId, 'completed', 'quick');
        this.scannedCount++;
        
        logger.info(`Generated ${suggestions.length} suggestions for session ${sessionId}`);
        this.emit('complete', sessionId, suggestions);
      }

      logger.info(`Batch scan completed for ${results.size} sessions`);
    } catch (error) {
      logger.error('Failed to scan session batch:', error);
      this.lastError = error instanceof Error ? error.message : String(error);
      
      // Mark all sessions in batch as failed
      for (const sessionId of sessionIds) {
        try {
          tagSuggestions.updateSessionScanStatus(sessionId, 'failed', 'quick');
        } catch (updateError) {
          logger.error(`Failed to update scan status for ${sessionId}:`, updateError);
        }
      }
      
      this.emit('error', error as Error);
      throw error;
    }
  }

  /**
   * Scan a single session for tag suggestions
   */
  async scanSession(sessionId: string): Promise<TagSuggestion[]> {
    logger.info(`Scanning session ${sessionId}...`);

    try {
      // 1. Gather session context
      const context = gatherQuickContext(sessionId);
      
      if (!context) {
        logger.warn(`Session ${sessionId} not found or has no context`);
        tagSuggestions.updateSessionScanStatus(sessionId, 'failed', 'quick');
        return [];
      }
      
      // 2. Format context for prompt
      const formattedContext = formatContextForPrompt(context);
      
      // 3. Call Claude CLI to generate tag suggestions
      const cliResults = await generateTagSuggestionsViaCli(
        formattedContext,
        context.existingTags
      );
      
      // Archive the CLI session that was created
      archiveTaggingSession().catch(err => {
        logger.warn('Failed to archive tagging session after CLI call', { error: err });
      });
      
      // 4. Save suggestions to database
      const suggestions = tagSuggestions.createSuggestions(
        cliResults.map(result => ({
          sessionId,
          tagName: result.name,
          confidence: result.confidence,
          category: result.category || 'other',
          reasoning: result.reasoning,
        }))
      );
      
      // 5. Update session scan status
      tagSuggestions.updateSessionScanStatus(sessionId, 'completed', 'quick');

      logger.info(`Generated ${suggestions.length} suggestions for session ${sessionId}`);
      this.emit('complete', sessionId, suggestions);

      return suggestions;
    } catch (error) {
      logger.error(`Failed to scan session ${sessionId}:`, error);
      this.lastError = error instanceof Error ? error.message : String(error);
      
      // Mark session as failed
      try {
        tagSuggestions.updateSessionScanStatus(sessionId, 'failed', 'quick');
      } catch (updateError) {
        logger.error(`Failed to update scan status for ${sessionId}:`, updateError);
      }
      
      this.emit('error', error as Error, sessionId);
      throw error;
    }
  }

  /**
   * Scan all sessions in the queue
   */
  async scanAll(): Promise<void> {
    if (!this.isRunning) {
      this.start();
    }

    // Reset counters
    this.scannedCount = 0;
    
    await this.queueAllPending();
    
    // Set total sessions to scan (queue size after queueing all)
    this.totalSessionsToScan = this.queue.size();
    
    logger.info('Scanning all queued sessions...');
  }

  // ============================================================================
  // STATUS AND PROGRESS
  // ============================================================================

  /**
   * Get current service status
   */
  getStatus(): ScanStatusInfo {
    const queueSize = this.queue.size();
    const remainingTokens = this.rateLimiter.getRemainingTokens();
    const timeUntilNextToken = this.rateLimiter.getTimeUntilNextToken();

    return {
      isRunning: this.isRunning,
      isPaused: this.isPaused,
      totalSessions: this.scannedCount + queueSize,
      scannedSessions: this.scannedCount,
      pendingSessions: queueSize,
      currentSessionId: this.currentSessionId,
      estimatedTimeRemaining: this.calculateEstimatedTime(queueSize, remainingTokens, timeUntilNextToken),
      lastError: this.lastError,
    };
  }

  /**
   * Get current scan progress
   */
  getProgress(): ScanProgress {
    const queueSize = this.queue.size();
    const rateLimitEnabled = db.getSetting<boolean>('tagScanRateLimitEnabled') ?? true;
    
    // When rate limiting is disabled, show actual total pending sessions
    // When rate limiting is enabled, cap display at 100 (rate limit max)
    let total: number;
    if (rateLimitEnabled) {
      total = this.totalSessionsToScan > 0 ? this.totalSessionsToScan : this.scannedCount + queueSize;
    } else {
      // Get actual pending count from database when rate limiting is off
      const actualPending = tagSuggestions.getPendingSessions().length;
      total = this.scannedCount + actualPending;
    }
    
    const current = this.scannedCount;

    return {
      current,
      total,
      percentage: total > 0 ? Math.round((current / total) * 100) : 0,
      estimatedTimeMs: this.calculateEstimatedTime(
        queueSize,
        this.rateLimiter.getRemainingTokens(),
        this.rateLimiter.getTimeUntilNextToken(),
      ) || 0,
      currentSessionId: this.currentSessionId || undefined,
      rateLimitRemaining: rateLimitEnabled ? this.rateLimiter.getRemainingTokens() : undefined,
      rateLimitMax: rateLimitEnabled ? this.config.maxSessionsPerHour : undefined,
    };
  }

  // ============================================================================
  // PRIVATE METHODS
  // ============================================================================

  /**
   * Process the next batch of sessions from the queue
   */
  private async processQueue(): Promise<void> {
    // Don't process if paused or not running
    if (!this.isRunning || this.isPaused) {
      return;
    }

    // Don't start a new batch if one is already processing
    if (this.isProcessingBatch) {
      logger.debug('Skipping batch - previous batch still processing');
      return;
    }

    // Check rate limit BEFORE collecting batch (if enabled)
    const rateLimitEnabled = db.getSetting<boolean>('tagScanRateLimitEnabled') ?? true;
    if (rateLimitEnabled) {
      if (!this.rateLimiter.tryConsume()) {
        const timeUntilNext = this.rateLimiter.getTimeUntilNextToken();
        logger.info(`Rate limit reached. Next batch available in ${Math.round(timeUntilNext / 1000)}s`);
        return;
      }
    }

    // Collect session IDs for batch processing
    const batch: string[] = [];
    
    for (let i = 0; i < this.config.batchSize; i++) {
      if (this.queue.isEmpty()) {
        break;
      }

      // Get next item
      const item = this.queue.dequeue();
      if (!item) break;
      
      batch.push(item.sessionId);
    }

    // Process batch if we have any sessions
    if (batch.length > 0) {
      logger.info(`Processing batch of ${batch.length} sessions`);
      this.isProcessingBatch = true;
      this.currentSessionId = batch[0]; // Track first session ID for progress
      this.emitProgress();

      try {
        // ONE CLI call for entire batch
        await this.scanSessionBatch(batch);
      } catch (error) {
        logger.error('Failed to process batch:', error);
        // Error handling is done in scanSessionBatch
      } finally {
        this.isProcessingBatch = false;
        this.currentSessionId = null;
        this.emitProgress();
      }
    }

    // Emit queue changed event
    this.emit('queueChanged', this.queue.size());
  }

  /**
   * Calculate estimated time remaining (in ms)
   */
  private calculateEstimatedTime(
    queueSize: number,
    remainingTokens: number,
    timeUntilNextToken: number,
  ): number | null {
    if (queueSize === 0) return null;

    // If we have enough tokens for all remaining items
    if (remainingTokens >= queueSize) {
      // Estimate based on processing interval
      const batchesNeeded = Math.ceil(queueSize / this.config.batchSize);
      return batchesNeeded * this.config.processingIntervalMs;
    }

    // If we need to wait for token refill
    const itemsBeforeWait = Math.min(remainingTokens, queueSize);
    const itemsAfterWait = queueSize - itemsBeforeWait;
    
    const timeBeforeWait = Math.ceil(itemsBeforeWait / this.config.batchSize) * this.config.processingIntervalMs;
    const timeAfterWait = Math.ceil(itemsAfterWait / this.config.batchSize) * this.config.processingIntervalMs;
    
    return timeBeforeWait + timeUntilNextToken + timeAfterWait;
  }

  /**
   * Emit progress event
   */
  private emitProgress(): void {
    this.emit('progress', this.getProgress());
  }

  /**
   * Emit status changed event
   */
  private emitStatusChanged(): void {
    this.emit('statusChanged', this.getStatus());
  }

  /**
   * Type-safe event listener registration
   */
  override on<K extends keyof ServiceEvents>(
    event: K,
    listener: (...args: ServiceEvents[K]) => void,
  ): this {
    return super.on(event, listener);
  }

  /**
   * Type-safe event emitter
   */
  override emit<K extends keyof ServiceEvents>(
    event: K,
    ...args: ServiceEvents[K]
  ): boolean {
    return super.emit(event, ...args);
  }
}

// ============================================================================
// SINGLETON INSTANCE
// ============================================================================

const DEFAULT_CONFIG: ServiceConfig = {
  // When rate limiting is disabled, processQueue() skips the rate limit check entirely.
  // So we use a high maxSessionsPerHour (9999) here - the actual limiting is done dynamically
  // in processQueue() based on the tagScanRateLimitEnabled setting.
  maxSessionsPerHour: 9999, // Effectively unlimited - rate limiting is checked dynamically
  batchSize: 25,
  processingIntervalMs: 10000, // 10 seconds
};

const tagSuggestionService = new TagSuggestionService(DEFAULT_CONFIG);

// ============================================================================
// EXPORTS
// ============================================================================

export { TagSuggestionService, type ServiceConfig, type Priority, type ScanQueueItem };
export default tagSuggestionService;
