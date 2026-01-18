// ============================================================================
// HOOKS VIEW - SHARED TYPES AND CONSTANTS
// ============================================================================

import React from 'react';
import {
  Zap,
  CheckCircle,
  Play,
  Pause,
  AlertCircle,
  XCircle,
  ShieldCheck,
  MessageSquare,
  AlertTriangle,
  Users,
  UserMinus,
  Archive,
  Settings,
} from 'lucide-react';

export interface Hook {
  id: number;
  name: string;
  eventType: HookEventType;
  matcher: string | null;
  command: string;
  timeout: number;
  enabled: boolean;
  scope: 'user' | 'project';
  projectPath: string | null;
  executionCount: number;
  lastExecuted: string | null;
  lastResult: 'success' | 'failure' | 'timeout' | null;
  createdAt: string;
  updatedAt: string;
  hookType: 'command' | 'prompt';
  prompt: string | null;
}

export interface EventTypeMetadata {
  value: HookEventType;
  label: string;
  description: string;
  canBlock: boolean;
  exitCode2Behavior: string;
  supportsMatcher: boolean;
  matcherType: 'tool' | 'notification' | 'trigger' | 'subagent' | 'compact' | 'session' | 'none';
  matcherExamples: string[];
  commonUseCases: string[];
  inputSchemaExample: Record<string, unknown>;
  outputSchemaExample: Record<string, unknown> | null;
  availableDecisions: string[] | null;
}

export type HookEventType =
  | 'PreToolUse'
  | 'PermissionRequest'
  | 'PostToolUse'
  | 'PostToolUseFailure'
  | 'Notification'
  | 'UserPromptSubmit'
  | 'Stop'
  | 'SubagentStart'
  | 'SubagentStop'
  | 'PreCompact'
  | 'SessionStart'
  | 'SessionEnd'
  | 'Setup';

export const EVENT_TYPES: EventTypeMetadata[] = [
  {
    value: 'PreToolUse',
    label: 'Pre Tool Use',
    description: 'Before a tool is executed',
    canBlock: true,
    exitCode2Behavior: 'Blocks tool, shows stderr to Claude',
    supportsMatcher: true,
    matcherType: 'tool',
    matcherExamples: ['Bash', 'Read', 'Write', 'Edit', 'Glob', 'Grep', 'Task', 'WebFetch', 'WebSearch', 'mcp__*'],
    commonUseCases: [
      'Block dangerous operations',
      'Auto-approve safe operations',
      'Modify tool inputs',
      'Validate commands',
    ],
    inputSchemaExample: {
      session_id: 'abc123',
      transcript_path: '/path/to/transcript.json',
      cwd: '/project/directory',
      permission_mode: 'default',
      hook_event_name: 'PreToolUse',
      tool_name: 'Bash',
      tool_input: { command: 'npm install' },
      tool_use_id: 'tool_123',
    },
    outputSchemaExample: {
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'allow',
        permissionDecisionReason: 'Safe operation',
        updatedInput: { command: 'npm install --save-exact' },
      },
    },
    availableDecisions: ['allow', 'deny', 'ask'],
  },
  {
    value: 'PermissionRequest',
    label: 'Permission Request',
    description: 'When permission is requested for an action',
    canBlock: true,
    exitCode2Behavior: 'Denies permission, shows stderr to Claude',
    supportsMatcher: true,
    matcherType: 'tool',
    matcherExamples: ['Bash', 'Read', 'Write', 'Edit', 'Glob', 'Grep', 'Task', 'WebFetch', 'WebSearch', 'mcp__*'],
    commonUseCases: [
      'Auto-approve permissions',
      'Implement custom permission logic',
      'Deny based on context',
    ],
    inputSchemaExample: {
      session_id: 'abc123',
      transcript_path: '/path/to/transcript.json',
      cwd: '/project/directory',
      permission_mode: 'default',
      hook_event_name: 'PermissionRequest',
      tool_name: 'Bash',
      tool_input: { command: 'rm -rf node_modules' },
      tool_use_id: 'tool_456',
    },
    outputSchemaExample: {
      hookSpecificOutput: {
        hookEventName: 'PermissionRequest',
        decision: {
          behavior: 'allow',
          updatedInput: null,
          message: 'Permission granted',
          interrupt: false,
        },
      },
    },
    availableDecisions: ['allow', 'deny'],
  },
  {
    value: 'PostToolUse',
    label: 'Post Tool Use',
    description: 'After a tool completes successfully',
    canBlock: true,
    exitCode2Behavior: 'Shows stderr to Claude',
    supportsMatcher: true,
    matcherType: 'tool',
    matcherExamples: ['Bash', 'Read', 'Write', 'Edit', 'Glob', 'Grep', 'Task', 'WebFetch', 'WebSearch', 'mcp__*'],
    commonUseCases: [
      'Run linters after edits',
      'Execute tests after changes',
      'Log results',
      'Trigger workflows',
    ],
    inputSchemaExample: {
      session_id: 'abc123',
      transcript_path: '/path/to/transcript.json',
      cwd: '/project/directory',
      permission_mode: 'default',
      hook_event_name: 'PostToolUse',
      tool_name: 'Edit',
      tool_input: { file_path: '/src/index.ts', old_string: 'foo', new_string: 'bar' },
      tool_use_id: 'tool_789',
      tool_response: {
        stdout: 'File edited successfully',
        stderr: '',
        exit_code: 0,
      },
    },
    outputSchemaExample: {
      hookSpecificOutput: {
        hookEventName: 'PostToolUse',
        decision: 'block',
        reason: 'Linter found errors',
      },
    },
    availableDecisions: ['block'],
  },
  {
    value: 'PostToolUseFailure',
    label: 'Post Tool Failure',
    description: 'After a tool fails',
    canBlock: true,
    exitCode2Behavior: 'Shows stderr to Claude',
    supportsMatcher: true,
    matcherType: 'tool',
    matcherExamples: ['Bash', 'Read', 'Write', 'Edit', 'Glob', 'Grep', 'Task', 'WebFetch', 'WebSearch', 'mcp__*'],
    commonUseCases: [
      'Custom error handling',
      'Failure logging',
      'Retry logic',
      'Error analysis',
    ],
    inputSchemaExample: {
      session_id: 'abc123',
      transcript_path: '/path/to/transcript.json',
      cwd: '/project/directory',
      permission_mode: 'default',
      hook_event_name: 'PostToolUseFailure',
      tool_name: 'Bash',
      tool_input: { command: 'npm run build' },
      tool_use_id: 'tool_error_123',
      tool_response: {
        stdout: '',
        stderr: 'Build failed: TypeScript errors',
        exit_code: 1,
      },
    },
    outputSchemaExample: null,
    availableDecisions: null,
  },
  {
    value: 'Notification',
    label: 'Notification',
    description: 'When Claude sends a notification',
    canBlock: false,
    exitCode2Behavior: 'Shows stderr to user only',
    supportsMatcher: true,
    matcherType: 'notification',
    matcherExamples: ['permission_prompt', 'idle_prompt', 'auth_success', 'elicitation_dialog'],
    commonUseCases: [
      'Desktop notifications',
      'Slack/Discord alerts',
      'Custom sound alerts',
      'Mobile push',
    ],
    inputSchemaExample: {
      session_id: 'abc123',
      transcript_path: '/path/to/transcript.json',
      cwd: '/project/directory',
      permission_mode: 'default',
      hook_event_name: 'Notification',
      notification_type: 'permission_prompt',
      message: 'Claude is waiting for permission',
    },
    outputSchemaExample: null,
    availableDecisions: null,
  },
  {
    value: 'UserPromptSubmit',
    label: 'User Prompt',
    description: 'When user submits a prompt',
    canBlock: true,
    exitCode2Behavior: 'Blocks prompt, shows stderr to user',
    supportsMatcher: false,
    matcherType: 'none',
    matcherExamples: [],
    commonUseCases: [
      'Inject dynamic context',
      'Validate prompts',
      'Block sensitive requests',
      'Security filtering',
    ],
    inputSchemaExample: {
      session_id: 'abc123',
      transcript_path: '/path/to/transcript.json',
      cwd: '/project/directory',
      permission_mode: 'default',
      hook_event_name: 'UserPromptSubmit',
      prompt: 'Please refactor this function',
    },
    outputSchemaExample: {
      hookSpecificOutput: {
        hookEventName: 'UserPromptSubmit',
        decision: 'block',
        reason: 'Prompt contains sensitive information',
      },
    },
    availableDecisions: ['block'],
  },
  {
    value: 'Stop',
    label: 'Stop',
    description: 'When Claude stops execution',
    canBlock: true,
    exitCode2Behavior: 'Blocks stop, shows stderr to Claude',
    supportsMatcher: false,
    matcherType: 'none',
    matcherExamples: [],
    commonUseCases: [
      'Force Claude to continue',
      'Run cleanup tasks',
      'Send completion notifications',
      'Ensure all tasks complete',
    ],
    inputSchemaExample: {
      session_id: 'abc123',
      transcript_path: '/path/to/transcript.json',
      cwd: '/project/directory',
      permission_mode: 'default',
      hook_event_name: 'Stop',
      stop_hook_active: true,
    },
    outputSchemaExample: {
      hookSpecificOutput: {
        hookEventName: 'Stop',
        decision: 'block',
        reason: 'Tasks still pending',
      },
    },
    availableDecisions: ['block'],
  },
  {
    value: 'SubagentStart',
    label: 'Subagent Start',
    description: 'When a subagent is spawned',
    canBlock: false,
    exitCode2Behavior: 'Shows stderr to user only',
    supportsMatcher: true,
    matcherType: 'subagent',
    matcherExamples: ['db-agent', 'test-runner', 'my-agent', '*'],
    commonUseCases: [
      'Set up resources',
      'Initialize connections',
      'Configure environment',
      'Inject context',
    ],
    inputSchemaExample: {
      session_id: 'abc123',
      transcript_path: '/path/to/transcript.json',
      cwd: '/project/directory',
      permission_mode: 'default',
      hook_event_name: 'SubagentStart',
      subagent_name: 'db-agent',
      subagent_prompt: 'Query the database for user records',
    },
    outputSchemaExample: null,
    availableDecisions: null,
  },
  {
    value: 'SubagentStop',
    label: 'Subagent Stop',
    description: 'When a subagent completes',
    canBlock: true,
    exitCode2Behavior: 'Blocks stop, shows stderr to subagent',
    supportsMatcher: true,
    matcherType: 'subagent',
    matcherExamples: ['db-agent', 'test-runner', 'my-agent', '*'],
    commonUseCases: [
      'Ensure tasks complete',
      'Clean up resources',
      'Validate output',
      'Coordinate agents',
    ],
    inputSchemaExample: {
      session_id: 'abc123',
      transcript_path: '/path/to/transcript.json',
      cwd: '/project/directory',
      permission_mode: 'default',
      hook_event_name: 'SubagentStop',
      subagent_name: 'db-agent',
      subagent_result: 'Query completed successfully',
    },
    outputSchemaExample: {
      hookSpecificOutput: {
        hookEventName: 'SubagentStop',
        decision: 'block',
        reason: 'Additional queries needed',
      },
    },
    availableDecisions: ['block'],
  },
  {
    value: 'PreCompact',
    label: 'Pre Compact',
    description: 'Before context compaction',
    canBlock: false,
    exitCode2Behavior: 'Shows stderr to user only',
    supportsMatcher: true,
    matcherType: 'compact',
    matcherExamples: ['manual', 'auto'],
    commonUseCases: [
      'Backup transcripts',
      'Preserve context',
      'Log state',
      'Export data',
    ],
    inputSchemaExample: {
      session_id: 'abc123',
      transcript_path: '/path/to/transcript.json',
      cwd: '/project/directory',
      permission_mode: 'default',
      hook_event_name: 'PreCompact',
      trigger: 'auto',
      custom_instructions: 'Preserve important context about database schema',
    },
    outputSchemaExample: null,
    availableDecisions: null,
  },
  {
    value: 'SessionStart',
    label: 'Session Start',
    description: 'When a session begins',
    canBlock: false,
    exitCode2Behavior: 'Shows stderr to user only',
    supportsMatcher: true,
    matcherType: 'session',
    matcherExamples: ['startup', 'resume', 'clear', 'compact'],
    commonUseCases: [
      'Load context',
      'Install dependencies',
      'Set up environment',
      'Initialize state',
    ],
    inputSchemaExample: {
      session_id: 'abc123',
      transcript_path: '/path/to/transcript.json',
      cwd: '/project/directory',
      permission_mode: 'default',
      hook_event_name: 'SessionStart',
      source: 'startup',
    },
    outputSchemaExample: null,
    availableDecisions: null,
  },
  {
    value: 'SessionEnd',
    label: 'Session End',
    description: 'When a session ends',
    canBlock: false,
    exitCode2Behavior: 'Shows stderr to user only',
    supportsMatcher: true,
    matcherType: 'session',
    matcherExamples: ['clear', 'logout', 'prompt_input_exit', 'other'],
    commonUseCases: [
      'Cleanup tasks',
      'Log statistics',
      'Save state',
      'Send summary notifications',
    ],
    inputSchemaExample: {
      session_id: 'abc123',
      transcript_path: '/path/to/transcript.json',
      cwd: '/project/directory',
      permission_mode: 'default',
      hook_event_name: 'SessionEnd',
      reason: 'logout',
    },
    outputSchemaExample: null,
    availableDecisions: null,
  },
  {
    value: 'Setup',
    label: 'Setup',
    description: 'Repo setup hooks for init and maintenance',
    canBlock: false,
    exitCode2Behavior: 'Blocking errors ignored',
    supportsMatcher: true,
    matcherType: 'trigger',
    matcherExamples: ['init', 'maintenance'],
    commonUseCases: [
      'Initialize project dependencies',
      'Run database migrations',
      'Set up development environment',
      'Perform routine maintenance',
    ],
    inputSchemaExample: {
      session_id: 'abc123',
      transcript_path: '/path/to/transcript.json',
      cwd: '/project/directory',
      permission_mode: 'default',
      hook_event_name: 'Setup',
      trigger: 'init',
    },
    outputSchemaExample: null,
    availableDecisions: null,
  },
];

export const EVENT_TYPE_ICONS: Record<HookEventType, React.ReactNode> = {
  PreToolUse: React.createElement(Zap, { className: 'w-4 h-4 text-yellow-400' }),
  PermissionRequest: React.createElement(ShieldCheck, { className: 'w-4 h-4 text-cyan-400' }),
  PostToolUse: React.createElement(CheckCircle, { className: 'w-4 h-4 text-green-400' }),
  PostToolUseFailure: React.createElement(AlertTriangle, { className: 'w-4 h-4 text-red-400' }),
  Notification: React.createElement(AlertCircle, { className: 'w-4 h-4 text-orange-400' }),
  UserPromptSubmit: React.createElement(MessageSquare, { className: 'w-4 h-4 text-blue-400' }),
  Stop: React.createElement(XCircle, { className: 'w-4 h-4 text-red-400' }),
  SubagentStart: React.createElement(Users, { className: 'w-4 h-4 text-purple-400' }),
  SubagentStop: React.createElement(UserMinus, { className: 'w-4 h-4 text-purple-300' }),
  PreCompact: React.createElement(Archive, { className: 'w-4 h-4 text-gray-400' }),
  SessionStart: React.createElement(Play, { className: 'w-4 h-4 text-green-400' }),
  SessionEnd: React.createElement(Pause, { className: 'w-4 h-4 text-gray-400' }),
  Setup: React.createElement(Settings, { className: 'w-4 h-4 text-teal-400' }),
};
