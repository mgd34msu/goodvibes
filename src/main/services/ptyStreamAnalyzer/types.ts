// ============================================================================
// PTY STREAM ANALYZER TYPES
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

export interface PatternDefinition {
  name: string;
  pattern: RegExp;
  eventType: StreamEventType;
  extract?: (match: RegExpMatchArray) => Record<string, unknown>;
}
