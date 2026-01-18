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
  | 'SessionEnd';

export const EVENT_TYPES: { value: HookEventType; label: string; description: string }[] = [
  { value: 'PreToolUse', label: 'Pre Tool Use', description: 'Before a tool is executed' },
  { value: 'PermissionRequest', label: 'Permission Request', description: 'When permission is requested for an action' },
  { value: 'PostToolUse', label: 'Post Tool Use', description: 'After a tool completes successfully' },
  { value: 'PostToolUseFailure', label: 'Post Tool Failure', description: 'After a tool fails' },
  { value: 'Notification', label: 'Notification', description: 'When Claude sends a notification' },
  { value: 'UserPromptSubmit', label: 'User Prompt', description: 'When user submits a prompt' },
  { value: 'Stop', label: 'Stop', description: 'When Claude stops execution' },
  { value: 'SubagentStart', label: 'Subagent Start', description: 'When a subagent is spawned' },
  { value: 'SubagentStop', label: 'Subagent Stop', description: 'When a subagent completes' },
  { value: 'PreCompact', label: 'Pre Compact', description: 'Before context compaction' },
  { value: 'SessionStart', label: 'Session Start', description: 'When a session begins' },
  { value: 'SessionEnd', label: 'Session End', description: 'When a session ends' },
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
};
