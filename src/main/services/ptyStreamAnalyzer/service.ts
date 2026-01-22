// ============================================================================
// PTY STREAM ANALYZER SERVICE - Real-time Terminal Output Analysis
// ============================================================================

import { EventEmitter } from 'events';
import { Logger } from '../logger.js';
import { recordDetailedToolUsage } from '../../database/primitives.js';
import type { StreamEvent, ToolCall, StreamMetrics, PatternDefinition } from './types.js';
import { STREAM_PATTERNS, isToolName } from './patterns.js';

const logger = new Logger('PTYStreamAnalyzer');

/**
 * Regular expression to match ANSI escape sequences in terminal output.
 * Uses the ESC character (0x1B) followed by CSI sequences [params][command].
 * This is necessary to strip terminal formatting for clean pattern matching.
 * Built at runtime to avoid ESLint no-control-regex false positive.
 */
const ESC = String.fromCharCode(0x1b);
const ANSI_ESCAPE_REGEX = new RegExp(`${ESC}\\[[0-9;?]*[a-zA-Z]`, 'g');

// ============================================================================
// PTY STREAM ANALYZER SERVICE
// ============================================================================

export class PTYStreamAnalyzerService extends EventEmitter {
  private metrics: Map<number, StreamMetrics> = new Map();
  private activeToolCalls: Map<string, { call: ToolCall; addedAt: number }> = new Map();
  private inThinking: Set<number> = new Set();
  private outputBuffers: Map<number, string> = new Map();
  private readonly MAX_BUFFER_SIZE = 50 * 1024; // 50KB per terminal
  private readonly STALE_CLEANUP_INTERVAL_MS = 30 * 1000; // 30 seconds
  private readonly TOOL_CALL_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes
  private cleanupIntervalId: ReturnType<typeof setInterval> | null = null;
  private activeTerminalChecker: (() => Set<number>) | null = null;

  constructor() {
    super();
    this.setMaxListeners(100);
  }

  /**
   * Start periodic cleanup of stale entries for terminals that no longer exist.
   * @param getActiveTerminalIds - Function that returns the set of currently active terminal IDs
   */
  startPeriodicCleanup(getActiveTerminalIds: () => Set<number>): void {
    this.activeTerminalChecker = getActiveTerminalIds;

    // Clear any existing interval
    if (this.cleanupIntervalId !== null) {
      clearInterval(this.cleanupIntervalId);
    }

    this.cleanupIntervalId = setInterval(() => {
      this.cleanupStaleEntries();
    }, this.STALE_CLEANUP_INTERVAL_MS);

    logger.debug('Started periodic stale entry cleanup');
  }

  /**
   * Stop periodic cleanup
   */
  stopPeriodicCleanup(): void {
    if (this.cleanupIntervalId !== null) {
      clearInterval(this.cleanupIntervalId);
      this.cleanupIntervalId = null;
    }
    this.activeTerminalChecker = null;
    logger.debug('Stopped periodic stale entry cleanup');
  }

  /**
   * Remove entries for terminals that no longer exist.
   * Uses the registered activeTerminalChecker to determine which terminals are still active.
   */
  cleanupStaleEntries(): number {
    if (!this.activeTerminalChecker) {
      logger.debug('No active terminal checker registered, skipping stale cleanup');
      return 0;
    }

    const activeTerminalIds = this.activeTerminalChecker();
    let cleanedCount = 0;

    // Cleanup metrics for non-existent terminals
    for (const terminalId of this.metrics.keys()) {
      if (!activeTerminalIds.has(terminalId)) {
        this.clearTerminal(terminalId);
        cleanedCount++;
        logger.debug(`Cleaned up stale entry for terminal ${terminalId}`);
      }
    }

    // Also check outputBuffers (in case there are entries without metrics)
    for (const terminalId of this.outputBuffers.keys()) {
      if (!activeTerminalIds.has(terminalId)) {
        this.outputBuffers.delete(terminalId);
        logger.debug(`Cleaned up stale output buffer for terminal ${terminalId}`);
      }
    }

    // Also check inThinking set
    for (const terminalId of this.inThinking) {
      if (!activeTerminalIds.has(terminalId)) {
        this.inThinking.delete(terminalId);
        logger.debug(`Cleaned up stale thinking state for terminal ${terminalId}`);
      }
    }

    // Also check activeToolCalls
    for (const callId of this.activeToolCalls.keys()) {
      const terminalIdStr = callId.split('-')[0];
      const terminalId = parseInt(terminalIdStr, 10);
      if (!isNaN(terminalId) && !activeTerminalIds.has(terminalId)) {
        this.activeToolCalls.delete(callId);
        logger.debug(`Cleaned up stale tool call ${callId}`);
      }
    }

    // Cleanup abandoned tool calls (older than TOOL_CALL_TIMEOUT_MS)
    this.cleanupAbandonedToolCalls();

    if (cleanedCount > 0) {
      logger.info(`Cleaned up ${cleanedCount} stale terminal entries`);
    }

    return cleanedCount;
  }

  /**
   * Remove tool calls that have been active for longer than TOOL_CALL_TIMEOUT_MS.
   * This prevents memory leaks from abandoned tool calls where tool_end events are never received.
   */
  private cleanupAbandonedToolCalls(): number {
    const now = Date.now();
    let cleanedCount = 0;

    for (const [callId, entry] of this.activeToolCalls) {
      if (now - entry.addedAt > this.TOOL_CALL_TIMEOUT_MS) {
        this.activeToolCalls.delete(callId);
        cleanedCount++;
        logger.debug(`Cleaned up abandoned tool call ${callId} (age: ${Math.round((now - entry.addedAt) / 1000)}s)`);
      }
    }

    if (cleanedCount > 0) {
      logger.info(`Cleaned up ${cleanedCount} abandoned tool calls`);
    }

    return cleanedCount;
  }

  /**
   * Get count of tracked terminals (for diagnostics)
   */
  getTrackedTerminalCount(): number {
    return this.metrics.size;
  }

  // ============================================================================
  // STREAM ANALYSIS
  // ============================================================================

  /**
   * Analyze terminal output and emit events
   */
  analyze(terminalId: number, data: string, sessionId?: string): StreamEvent[] {
    const events: StreamEvent[] = [];
    const timestamp = Date.now();

    // Update output buffer
    this.appendToBuffer(terminalId, data);

    // Initialize or update metrics
    this.updateMetrics(terminalId, sessionId, data);

    // Strip ANSI escape codes for pattern matching
    const cleanData = data.replace(ANSI_ESCAPE_REGEX, '');

    // Run pattern matching
    for (const patternDef of STREAM_PATTERNS) {
      const testData = patternDef.eventType === 'agent_spawn' || patternDef.eventType === 'agent_complete' || patternDef.eventType === 'agent_activity'
        ? cleanData
        : data;

      const match = testData.match(patternDef.pattern);
      if (match) {
        const eventData = patternDef.extract ? patternDef.extract(match) : {};

        if (eventData.skip) {
          continue;
        }

        const event: StreamEvent = {
          type: patternDef.eventType,
          terminalId,
          timestamp,
          data: eventData,
        };

        events.push(event);
        this.processEvent(event, sessionId);
        this.emit('stream:event', event);
      }
    }

    // Emit raw output for subscribers that need it
    this.emit('stream:output', { terminalId, data, timestamp });

    return events;
  }

  /**
   * Process specific event types
   */
  private processEvent(event: StreamEvent, sessionId?: string): void {
    const metrics = this.metrics.get(event.terminalId);

    switch (event.type) {
      case 'tool_start': {
        const toolName = event.data.toolName as string;
        const callId = `${event.terminalId}-${toolName}-${event.timestamp}`;

        this.activeToolCalls.set(callId, {
          call: {
            name: toolName,
            input: '',
            startTime: event.timestamp,
          },
          addedAt: Date.now(),
        });

        if (metrics) metrics.toolCalls++;
        this.emit('tool:start', { terminalId: event.terminalId, toolName, callId });
        break;
      }

      case 'tool_end': {
        const toolName = event.data.toolName as string;

        for (const [callId, entry] of this.activeToolCalls) {
          const call = entry.call;
          if (call.name === toolName && !call.endTime) {
            call.endTime = event.timestamp;
            call.success = event.data.success as boolean;

            if (sessionId) {
              recordDetailedToolUsage({
                sessionId,
                toolName: call.name,
                toolInput: call.input,
                toolResultPreview: call.result?.slice(0, 500) || null,
                success: call.success ?? true,
                durationMs: call.endTime - call.startTime,
                tokenCost: null,
              });
            }

            this.emit('tool:end', {
              terminalId: event.terminalId,
              toolName,
              callId,
              success: call.success,
              durationMs: call.endTime - call.startTime,
            });

            this.activeToolCalls.delete(callId);
            break;
          }
        }
        break;
      }

      case 'thinking_start':
        this.inThinking.add(event.terminalId);
        if (metrics) metrics.thinkingBlocks++;
        this.emit('thinking:start', { terminalId: event.terminalId });
        break;

      case 'thinking_end':
        this.inThinking.delete(event.terminalId);
        this.emit('thinking:end', { terminalId: event.terminalId });
        break;

      case 'error':
        if (metrics) metrics.errors++;
        this.emit('error:detected', {
          terminalId: event.terminalId,
          message: event.data.message,
        });
        break;

      case 'warning':
        if (metrics) metrics.warnings++;
        this.emit('warning:detected', {
          terminalId: event.terminalId,
          message: event.data.message,
        });
        break;

      case 'prompt_ready':
        this.emit('prompt:ready', { terminalId: event.terminalId });
        break;

      case 'cost_update':
        this.emit('cost:update', {
          terminalId: event.terminalId,
          costUSD: event.data.costUSD,
        });
        break;

      case 'token_usage':
        if (metrics) {
          metrics.estimatedTokens = event.data.tokens as number;
        }
        this.emit('tokens:update', {
          terminalId: event.terminalId,
          tokens: event.data.tokens,
        });
        break;

      case 'agent_spawn': {
        if (event.data.skip) {
          logger.debug('Skipping agent spawn - matched tool name, not a real agent');
          break;
        }

        const agentName = event.data.agentName as string;

        if (!agentName || isToolName(agentName)) {
          logger.debug(`Skipping agent spawn - tool name detected: ${agentName}`);
          break;
        }

        const description = event.data.description as string | undefined;
        const isRealAgent = event.data.isRealAgent as boolean | undefined;

        logger.info(`Agent detected: ${agentName}`, {
          description,
          terminalId: event.terminalId,
          source: event.data.source,
          isRealAgent,
        });

        this.emit('agent:spawn', {
          terminalId: event.terminalId,
          agentName,
          description,
          timestamp: event.timestamp,
          isRealAgent: isRealAgent ?? false,
        });
        break;
      }

      case 'agent_complete': {
        if (event.data.skip) {
          logger.debug('Skipping agent complete - matched tool name');
          break;
        }

        const agentId = event.data.agentId as string | undefined;
        const agentName = event.data.agentName as string | undefined;

        if (agentName && isToolName(agentName)) {
          logger.debug(`Skipping agent complete - tool name: ${agentName}`);
          break;
        }

        const reason = event.data.reason as string | undefined;
        logger.info(`Agent completed: ${agentId || agentName}`, { reason });
        this.emit('agent:complete', {
          terminalId: event.terminalId,
          agentId: agentId || '',
          agentName,
          reason,
          timestamp: event.timestamp,
        });
        break;
      }

      case 'agent_activity': {
        const agentName = event.data.agentName as string;
        this.emit('agent:activity', {
          terminalId: event.terminalId,
          agentName,
          activity: event.data.activity,
          timestamp: event.timestamp,
        });
        break;
      }
    }
  }

  // ============================================================================
  // BUFFER MANAGEMENT
  // ============================================================================

  private appendToBuffer(terminalId: number, data: string): void {
    const buffer = (this.outputBuffers.get(terminalId) || '') + data;
    const trimmedBuffer = buffer.length > this.MAX_BUFFER_SIZE
      ? buffer.slice(-this.MAX_BUFFER_SIZE)
      : buffer;
    this.outputBuffers.set(terminalId, trimmedBuffer);
  }

  getBuffer(terminalId: number): string {
    return this.outputBuffers.get(terminalId) || '';
  }

  clearBuffer(terminalId: number): void {
    this.outputBuffers.delete(terminalId);
  }

  searchBuffer(terminalId: number, pattern: RegExp): RegExpMatchArray | null {
    const buffer = this.outputBuffers.get(terminalId);
    return buffer ? buffer.match(pattern) : null;
  }

  // ============================================================================
  // METRICS
  // ============================================================================

  private updateMetrics(terminalId: number, sessionId?: string, data?: string): void {
    let metrics = this.metrics.get(terminalId);

    if (!metrics) {
      metrics = {
        terminalId,
        sessionId,
        toolCalls: 0,
        thinkingBlocks: 0,
        errors: 0,
        warnings: 0,
        outputBytes: 0,
        startTime: Date.now(),
        lastActivityTime: Date.now(),
        estimatedTokens: 0,
      };
      this.metrics.set(terminalId, metrics);
    }

    metrics.lastActivityTime = Date.now();
    if (data) {
      metrics.outputBytes += data.length;
    }
    if (sessionId) {
      metrics.sessionId = sessionId;
    }
  }

  getMetrics(terminalId: number): StreamMetrics | undefined {
    return this.metrics.get(terminalId);
  }

  getAllMetrics(): StreamMetrics[] {
    return Array.from(this.metrics.values());
  }

  clearMetrics(terminalId: number): void {
    this.metrics.delete(terminalId);
  }

  // ============================================================================
  // STATE QUERIES
  // ============================================================================

  isThinking(terminalId: number): boolean {
    return this.inThinking.has(terminalId);
  }

  getActiveToolCalls(terminalId: number): ToolCall[] {
    const calls: ToolCall[] = [];
    for (const [callId, entry] of this.activeToolCalls) {
      if (callId.startsWith(`${terminalId}-`)) {
        calls.push(entry.call);
      }
    }
    return calls;
  }

  getAllActiveToolCalls(): Map<string, ToolCall> {
    const calls = new Map<string, ToolCall>();
    for (const [callId, entry] of this.activeToolCalls) {
      calls.set(callId, entry.call);
    }
    return calls;
  }

  hasActiveToolCalls(terminalId: number): boolean {
    for (const callId of this.activeToolCalls.keys()) {
      if (callId.startsWith(`${terminalId}-`)) {
        return true;
      }
    }
    return false;
  }

  // ============================================================================
  // CUSTOM PATTERNS
  // ============================================================================

  addCustomPattern(pattern: PatternDefinition): void {
    STREAM_PATTERNS.push(pattern);
    logger.debug(`Added custom pattern: ${pattern.name}`);
  }

  removeCustomPattern(name: string): boolean {
    const index = STREAM_PATTERNS.findIndex(p => p.name === name);
    if (index > -1) {
      STREAM_PATTERNS.splice(index, 1);
      logger.debug(`Removed custom pattern: ${name}`);
      return true;
    }
    return false;
  }

  // ============================================================================
  // CLEANUP
  // ============================================================================

  clearTerminal(terminalId: number): void {
    this.metrics.delete(terminalId);
    this.outputBuffers.delete(terminalId);
    this.inThinking.delete(terminalId);

    for (const callId of this.activeToolCalls.keys()) {
      if (callId.startsWith(`${terminalId}-`)) {
        this.activeToolCalls.delete(callId);
      }
    }
  }

  shutdown(): void {
    this.stopPeriodicCleanup();
    this.metrics.clear();
    this.activeToolCalls.clear();
    this.inThinking.clear();
    this.outputBuffers.clear();
    this.removeAllListeners();
    logger.info('PTY Stream Analyzer shut down');
  }
}
