// ============================================================================
// PTY STREAM ANALYZER PATTERNS
// ============================================================================

import type { PatternDefinition } from './types.js';

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
export function isToolName(name: string): boolean {
  return TOOL_NAMES.has(name) || name.startsWith('Explore #') || /^(Read|Write|Edit|Bash|Glob|Grep)\s*#/i.test(name);
}

// ============================================================================
// PATTERN DEFINITIONS
// ============================================================================

export const STREAM_PATTERNS: PatternDefinition[] = [
  // ============================================================================
  // AGENT DETECTION PATTERNS (Claude CLI specific)
  // ============================================================================

  // PRIMARY: Claude CLI agent output format
  {
    name: 'claude_cli_agent_format',
    pattern: /[●·✻✽✶✢*]\s*([a-z][a-z0-9]*(?:-[a-z0-9]+)+)\s*\(([^)]+)\)/i,
    eventType: 'agent_spawn',
    extract: (match) => {
      const agentName = match[1];
      const description = match[2];
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
  {
    name: 'task_tool_spawn',
    pattern: /Task\s*\(?[^)]*subagent_type[:\s=]+["']?([a-zA-Z][\w-]*)["']?/i,
    eventType: 'agent_spawn',
    extract: (match) => {
      const agentName = match[1];
      if (isToolName(agentName)) {
        return { agentName: '', skip: true };
      }
      return { agentName, source: 'task_tool', isRealAgent: true };
    },
  },

  // Task tool invocation with description
  {
    name: 'task_description_spawn',
    pattern: /[●·✻✽✶✢*-]?\s*Task\s*\(\s*([^)]{3,})\s*\)/i,
    eventType: 'agent_spawn',
    extract: (match) => {
      const description = match[1].trim();
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

  // Matches "Create X agent" patterns
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

  // Agent completion with agentId
  {
    name: 'agent_complete_indicator',
    pattern: /agentId:\s*([a-f0-9-]+)/i,
    eventType: 'agent_complete',
    extract: (match) => ({ agentId: match[1] }),
  },

  // Agent task completed patterns
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
