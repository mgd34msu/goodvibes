// ============================================================================
// PTY STREAM ANALYZER SERVICE (P5) - Real-time Terminal Output Analysis
// ============================================================================

import { EventEmitter } from 'events';
import { Logger } from './logger.js';
import { recordDetailedToolUsage } from '../database/primitives.js';

const logger = new Logger('PTYStreamAnalyzer');

// ============================================================================
// TYPES
// ============================================================================

export interface StreamEvent {
  type: StreamEventType;
  terminalId: number;
  timestamp: number;
  data: Record<string, unknown>;
}

export type StreamEventType =
  | 'tool_start'
  | 'tool_end'
  | 'thinking_start'
  | 'thinking_end'
  | 'error'
  | 'warning'
  | 'prompt_ready'
  | 'processing'
  | 'output_text'
  | 'code_block'
  | 'file_reference'
  | 'session_start'
  | 'session_end'
  | 'cost_update'
  | 'token_usage'
  | 'agent_spawn'
  | 'agent_complete'
  | 'agent_activity';

export interface ToolCall {
  name: string;
  input: string;
  startTime: number;
  endTime?: number;
  result?: string;
  success?: boolean;
}

export interface StreamMetrics {
  terminalId: number;
  sessionId?: string;
  toolCalls: number;
  thinkingBlocks: number;
  errors: number;
  warnings: number;
  outputBytes: number;
  startTime: number;
  lastActivityTime: number;
  estimatedTokens: number;
}

// ============================================================================
// PATTERN DEFINITIONS
// ============================================================================

interface PatternDefinition {
  name: string;
  pattern: RegExp;
  eventType: StreamEventType;
  extract?: (match: RegExpMatchArray) => Record<string, unknown>;
}

// ============================================================================
// TOOL NAMES - these are NOT agents, do not create agent entries for them
// ============================================================================
const TOOL_NAMES = new Set([
  'Read', 'Write', 'Edit', 'Bash', 'Glob', 'Grep', 'Task', 'TaskOutput',
  'WebFetch', 'WebSearch', 'NotebookEdit', 'AskUserQuestion', 'TodoWrite',
  'Skill', 'EnterPlanMode', 'ExitPlanMode', 'LSP', 'KillShell', 'Explore'
]);

/**
 * Check if a name is a tool (not an agent)
 */
function isToolName(name: string): boolean {
  return TOOL_NAMES.has(name) || name.startsWith('Explore #') || /^(Read|Write|Edit|Bash|Glob|Grep)\s*#/i.test(name);
}

const STREAM_PATTERNS: PatternDefinition[] = [
  // ============================================================================
  // AGENT DETECTION PATTERNS (Claude CLI specific)
  // ============================================================================
  // IMPORTANT: These patterns are STRICT to avoid false positives.
  // Only the Task tool with subagent_type creates real agents.
  // Tool uses like Read, Write, Edit, Explore are NOT agents.
  // ============================================================================

  // PRIMARY: Claude CLI agent output format
  // Matches patterns like:
  //   "● claude-skill-creator(Create project summary skill)"
  //   "  agent-name(Task description here)"
  // Agent names contain hyphens, tool names are single capitalized words
  // The pattern requires the name to contain a hyphen to differentiate from tools
  {
    name: 'claude_cli_agent_format',
    pattern: /[●·✻✽✶✢*]\s*([a-z][a-z0-9]*(?:-[a-z0-9]+)+)\s*\(([^)]+)\)/i,
    eventType: 'agent_spawn',
    extract: (match) => {
      const agentName = match[1];
      const description = match[2];
      // Agent names with hyphens are real agents (claude-skill-creator, frontend-ui, etc.)
      // Single-word capitalized names are tools (Read, Write, Explore)
      if (isToolName(agentName)) {
        return { agentName: '', skip: true };
      }
      return {
        agentName,
        description,
        source: 'claude_cli_format',
        isRealAgent: true,
        fullMatch: match[0]
      };
    },
  },

  // SECONDARY: Claude CLI @agent invocation in prompt
  // Matches "@agent-name" patterns in user prompts shown in terminal
  // e.g., "> @agent-claude-skill-creator create a skill..."
  {
    name: 'at_agent_invocation',
    pattern: /@([a-z][a-z0-9]*(?:-[a-z0-9]+)+)\s+/i,
    eventType: 'agent_spawn',
    extract: (match) => {
      const agentName = match[1];
      if (isToolName(agentName)) {
        return { agentName: '', skip: true };
      }
      return {
        agentName,
        description: `Invoked via @${agentName}`,
        source: 'at_invocation',
        isRealAgent: true,
        fullMatch: match[0]
      };
    },
  },

  // Task tool invocation with subagent_type
  // e.g., "Task(subagent_type: orchestrator, description: ...)"
  {
    name: 'task_tool_spawn',
    pattern: /Task\s*\(?[^)]*subagent_type[:\s=]+["']?([a-zA-Z][\w-]*)["']?/i,
    eventType: 'agent_spawn',
    extract: (match) => {
      const agentName = match[1];
      // Filter out tool names that might be mistakenly matched
      if (isToolName(agentName)) {
        return { agentName: '', skip: true };
      }
      return { agentName, source: 'task_tool', isRealAgent: true };
    },
  },

  // CRITICAL: Task tool invocation with description (subagent activity indicator)
  // This catches patterns like "Task(Catalog all agents and skills)" seen in terminal output
  // The description can be used as the task/agent context
  // Note: This is a SUBAGENT indicator - when Claude spawns a Task, it's running a subagent
  {
    name: 'task_description_spawn',
    pattern: /[●·✻✽✶✢*-]?\s*Task\s*\(\s*([^)]{3,})\s*\)/i,
    eventType: 'agent_spawn',
    extract: (match) => {
      const description = match[1].trim();
      // Generate a task-based name from the description
      // Take first few words and kebab-case them
      const words = description.split(/\s+/).slice(0, 4);
      const taskName = words.join('-').toLowerCase().replace(/[^a-z0-9-]/g, '');
      return {
        agentName: `task-${taskName || 'unnamed'}`,
        description,
        source: 'task_description',
        isRealAgent: true,
        fullMatch: match[0]
      };
    },
  },

  // Matches "Create X agent" patterns from Claude CLI output
  // e.g., "Create electron-tester agent · Running in background"
  {
    name: 'agent_spawn_create',
    pattern: /Create\s+([\w-]+)\s+agent\s+[·\u00b7]\s+(?:Running|Launched)/i,
    eventType: 'agent_spawn',
    extract: (match) => {
      const agentName = match[1];
      if (isToolName(agentName)) {
        return { agentName: '', skip: true };
      }
      return {
        agentName,
        description: `Created agent: ${agentName}`,
        source: 'create_pattern',
        isRealAgent: true,
        fullMatch: match[0]
      };
    },
  },

  // Matches explicit agent spawn messages
  // e.g., "Spawning agent: orchestrator" or "Starting agent: frontend-ui"
  {
    name: 'agent_spawn_explicit',
    pattern: /(?:Spawning|Starting|Launching)\s+agent[:\s]+([a-zA-Z][\w-]*)/i,
    eventType: 'agent_spawn',
    extract: (match) => {
      const agentName = match[1];
      if (isToolName(agentName)) {
        return { agentName: '', skip: true };
      }
      return { agentName, source: 'explicit', isRealAgent: true };
    },
  },

  // Agent completion with agentId (this comes from SubagentStop hook)
  {
    name: 'agent_complete_indicator',
    pattern: /agentId:\s*([a-f0-9-]+)/i,
    eventType: 'agent_complete',
    extract: (match) => ({ agentId: match[1] }),
  },

  // Agent task completed patterns - only for non-tool names
  {
    name: 'agent_complete_done',
    pattern: /\[([a-zA-Z][\w-]+)\]\s*(?:completed|done|finished|exited)/i,
    eventType: 'agent_complete',
    extract: (match) => {
      const agentName = match[1];
      if (isToolName(agentName)) {
        return { agentName: '', skip: true };
      }
      return { agentName, reason: 'completed' };
    },
  },

  // Agent returned/reported back patterns
  {
    name: 'agent_complete_returned',
    pattern: /(?:←|<-|Returned from|Back from)\s*([a-zA-Z][\w-]+)/i,
    eventType: 'agent_complete',
    extract: (match) => {
      const agentName = match[1];
      if (isToolName(agentName)) {
        return { agentName: '', skip: true };
      }
      return { agentName, reason: 'returned' };
    },
  },

  // ============================================================================
  // TOOL USAGE PATTERNS
  // ============================================================================

  // Tool usage patterns
  {
    name: 'tool_start',
    pattern: /\[Tool: (\w+)\]/,
    eventType: 'tool_start',
    extract: (match) => ({ toolName: match[1] }),
  },
  {
    name: 'tool_start_verbose',
    pattern: /Calling tool: (\w+)/i,
    eventType: 'tool_start',
    extract: (match) => ({ toolName: match[1] }),
  },
  {
    name: 'tool_end_success',
    pattern: /Tool (\w+) completed successfully/i,
    eventType: 'tool_end',
    extract: (match) => ({ toolName: match[1], success: true }),
  },
  {
    name: 'tool_end_error',
    pattern: /Tool (\w+) failed: (.*)/i,
    eventType: 'tool_end',
    extract: (match) => ({ toolName: match[1], success: false, error: match[2] }),
  },

  // Thinking patterns
  {
    name: 'thinking_start',
    pattern: /<thinking>/i,
    eventType: 'thinking_start',
  },
  {
    name: 'thinking_end',
    pattern: /<\/thinking>/i,
    eventType: 'thinking_end',
  },
  {
    name: 'thinking_indicator',
    pattern: /^Thinking\.\.\./m,
    eventType: 'thinking_start',
  },

  // Error patterns
  {
    name: 'error_general',
    pattern: /Error: (.*)/i,
    eventType: 'error',
    extract: (match) => ({ message: match[1] }),
  },
  {
    name: 'error_exception',
    pattern: /Exception: (.*)/i,
    eventType: 'error',
    extract: (match) => ({ message: match[1] }),
  },
  {
    name: 'error_failed',
    pattern: /Failed to (.*)/i,
    eventType: 'error',
    extract: (match) => ({ message: `Failed to ${match[1]}` }),
  },

  // Warning patterns
  {
    name: 'warning',
    pattern: /Warning: (.*)/i,
    eventType: 'warning',
    extract: (match) => ({ message: match[1] }),
  },

  // Status patterns
  {
    name: 'prompt_ready',
    pattern: /^>\s*$/m,
    eventType: 'prompt_ready',
  },
  {
    name: 'processing',
    pattern: /Processing\.\.\./i,
    eventType: 'processing',
  },

  // Code block patterns
  {
    name: 'code_block_start',
    pattern: /```(\w+)?/,
    eventType: 'code_block',
    extract: (match) => ({ language: match[1] || 'unknown', action: 'start' }),
  },
  {
    name: 'code_block_end',
    pattern: /```$/m,
    eventType: 'code_block',
    extract: () => ({ action: 'end' }),
  },

  // File reference patterns
  {
    name: 'file_read',
    pattern: /Reading file[:\s]+([^\s]+)/i,
    eventType: 'file_reference',
    extract: (match) => ({ file: match[1], operation: 'read' }),
  },
  {
    name: 'file_write',
    pattern: /Writing to file[:\s]+([^\s]+)/i,
    eventType: 'file_reference',
    extract: (match) => ({ file: match[1], operation: 'write' }),
  },
  {
    name: 'file_edit',
    pattern: /Editing[:\s]+([^\s]+)/i,
    eventType: 'file_reference',
    extract: (match) => ({ file: match[1], operation: 'edit' }),
  },

  // Cost/token patterns
  {
    name: 'cost_update',
    pattern: /Cost[:\s]+\$?([\d.]+)/i,
    eventType: 'cost_update',
    extract: (match) => ({ costUSD: parseFloat(match[1]) }),
  },
  {
    name: 'token_usage',
    pattern: /Tokens?[:\s]+(\d+)/i,
    eventType: 'token_usage',
    extract: (match) => ({ tokens: parseInt(match[1], 10) }),
  },
];

// ============================================================================
// PTY STREAM ANALYZER SERVICE
// ============================================================================

class PTYStreamAnalyzerService extends EventEmitter {
  private metrics: Map<number, StreamMetrics> = new Map();
  private activeToolCalls: Map<string, ToolCall> = new Map();
  private inThinking: Set<number> = new Set();
  private outputBuffers: Map<number, string> = new Map();
  private readonly MAX_BUFFER_SIZE = 50 * 1024; // 50KB per terminal

  constructor() {
    super();
    this.setMaxListeners(100);
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

    // Strip ANSI escape codes for pattern matching (important for terminal output)
    // Use comprehensive regex that handles all ANSI sequences including cursor control
    // eslint-disable-next-line no-control-regex
    const cleanData = data.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '');

    // Run pattern matching
    for (const patternDef of STREAM_PATTERNS) {
      // Test both raw and clean data for agent patterns
      const testData = patternDef.eventType === 'agent_spawn' || patternDef.eventType === 'agent_complete' || patternDef.eventType === 'agent_activity'
        ? cleanData
        : data;

      const match = testData.match(patternDef.pattern);
      if (match) {
        const eventData = patternDef.extract ? patternDef.extract(match) : {};

        // Skip events that should be filtered out
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
          name: toolName,
          input: '',
          startTime: event.timestamp,
        });

        if (metrics) metrics.toolCalls++;
        this.emit('tool:start', { terminalId: event.terminalId, toolName, callId });
        break;
      }

      case 'tool_end': {
        const toolName = event.data.toolName as string;

        // Find matching tool call
        for (const [callId, call] of this.activeToolCalls) {
          if (call.name === toolName && !call.endTime) {
            call.endTime = event.timestamp;
            call.success = event.data.success as boolean;

            // Record to database
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
        // Check if this should be skipped (tool name, not real agent)
        if (event.data.skip) {
          logger.debug('Skipping agent spawn - matched tool name, not a real agent');
          break;
        }

        const agentName = event.data.agentName as string;

        // Double-check it's not a tool name (belt and suspenders)
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
        // Check if this should be skipped
        if (event.data.skip) {
          logger.debug('Skipping agent complete - matched tool name');
          break;
        }

        const agentId = event.data.agentId as string | undefined;
        const agentName = event.data.agentName as string | undefined;

        // Skip if it's a tool name
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

  /**
   * Append data to terminal buffer
   */
  private appendToBuffer(terminalId: number, data: string): void {
    const buffer = (this.outputBuffers.get(terminalId) || '') + data;

    // Trim buffer if too large
    const trimmedBuffer = buffer.length > this.MAX_BUFFER_SIZE
      ? buffer.slice(-this.MAX_BUFFER_SIZE)
      : buffer;

    this.outputBuffers.set(terminalId, trimmedBuffer);
  }

  /**
   * Get output buffer for a terminal
   */
  getBuffer(terminalId: number): string {
    return this.outputBuffers.get(terminalId) || '';
  }

  /**
   * Clear output buffer for a terminal
   */
  clearBuffer(terminalId: number): void {
    this.outputBuffers.delete(terminalId);
  }

  /**
   * Search buffer for a pattern
   */
  searchBuffer(terminalId: number, pattern: RegExp): RegExpMatchArray | null {
    const buffer = this.outputBuffers.get(terminalId);
    return buffer ? buffer.match(pattern) : null;
  }

  // ============================================================================
  // METRICS
  // ============================================================================

  /**
   * Initialize or update metrics for a terminal
   */
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

  /**
   * Get metrics for a terminal
   */
  getMetrics(terminalId: number): StreamMetrics | undefined {
    return this.metrics.get(terminalId);
  }

  /**
   * Get all metrics
   */
  getAllMetrics(): StreamMetrics[] {
    return Array.from(this.metrics.values());
  }

  /**
   * Clear metrics for a terminal
   */
  clearMetrics(terminalId: number): void {
    this.metrics.delete(terminalId);
  }

  // ============================================================================
  // STATE QUERIES
  // ============================================================================

  /**
   * Check if terminal is in thinking state
   */
  isThinking(terminalId: number): boolean {
    return this.inThinking.has(terminalId);
  }

  /**
   * Get active tool calls for a terminal
   */
  getActiveToolCalls(terminalId: number): ToolCall[] {
    const calls: ToolCall[] = [];
    for (const [callId, call] of this.activeToolCalls) {
      if (callId.startsWith(`${terminalId}-`)) {
        calls.push(call);
      }
    }
    return calls;
  }

  /**
   * Get all active tool calls
   */
  getAllActiveToolCalls(): Map<string, ToolCall> {
    return new Map(this.activeToolCalls);
  }

  /**
   * Check if a terminal has active tool calls
   */
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

  /**
   * Add a custom pattern for analysis
   */
  addCustomPattern(pattern: PatternDefinition): void {
    STREAM_PATTERNS.push(pattern);
    logger.debug(`Added custom pattern: ${pattern.name}`);
  }

  /**
   * Remove a custom pattern
   */
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

  /**
   * Clear all state for a terminal
   */
  clearTerminal(terminalId: number): void {
    this.metrics.delete(terminalId);
    this.outputBuffers.delete(terminalId);
    this.inThinking.delete(terminalId);

    // Clear active tool calls for this terminal
    for (const callId of this.activeToolCalls.keys()) {
      if (callId.startsWith(`${terminalId}-`)) {
        this.activeToolCalls.delete(callId);
      }
    }
  }

  /**
   * Shutdown the service
   */
  shutdown(): void {
    this.metrics.clear();
    this.activeToolCalls.clear();
    this.inThinking.clear();
    this.outputBuffers.clear();
    this.removeAllListeners();
    logger.info('PTY Stream Analyzer shut down');
  }
}

// ============================================================================
// SINGLETON INSTANCE
// ============================================================================

let streamAnalyzer: PTYStreamAnalyzerService | null = null;

export function getPTYStreamAnalyzer(): PTYStreamAnalyzerService {
  if (!streamAnalyzer) {
    streamAnalyzer = new PTYStreamAnalyzerService();
  }
  return streamAnalyzer;
}

export function shutdownPTYStreamAnalyzer(): void {
  if (streamAnalyzer) {
    streamAnalyzer.shutdown();
    streamAnalyzer = null;
  }
}

// Export the class for testing
export { PTYStreamAnalyzerService };
