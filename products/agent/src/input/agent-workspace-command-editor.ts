import type { AgentWorkspaceBasicCommandEditorKind } from './agent-workspace-basic-command-editors.ts';
import { buildAgentWorkspaceBasicCommandEditorSubmission, isAgentWorkspaceBasicCommandEditorKind } from './agent-workspace-basic-command-editors.ts';
import { buildAgentKnowledgeUrlEditorSubmission } from './agent-workspace-knowledge-url-editor.ts';
import { buildAgentKnowledgeQueryEditorSubmission } from './agent-workspace-knowledge-query-editor.ts';
import { buildAgentWorkspaceCalendarConnectEditorSubmission } from './agent-workspace-calendar-connect-editor.ts';
import { buildAgentRoutineScheduleEditorSubmission } from './agent-workspace-routine-schedule-editor.ts';
import { buildAgentWorkspaceWebResearchSubmission } from './agent-workspace-web-research-editor.ts';
import type { AgentWorkspaceActionResult, AgentWorkspaceEditorKind, AgentWorkspaceLocalEditor } from './agent-workspace-types.ts';

type AgentWorkspaceFieldReader = (fieldId: string) => string;
type AgentWorkspaceCommandEditorKind = AgentWorkspaceBasicCommandEditorKind | Extract<
  AgentWorkspaceEditorKind,
  'web-research'
  | 'web-fetch'
  | 'knowledge-url'
  | 'knowledge-urls'
  | 'knowledge-file'
  | 'knowledge-browser-history'
  | 'knowledge-connector-ingest'
  | 'knowledge-reindex'
  | 'knowledge-search'
  | 'knowledge-ask'
  | 'notify-webhook'
  | 'notify-webhook-remove'
  | 'notify-webhook-clear'
  | 'notify-webhook-test'
  | 'notify-send'
  | 'secret-set'
  | 'secret-link'
  | 'secret-test'
  | 'secret-delete'
  | 'routine-schedule'
  | 'calendar-connect'
  | 'knowledge-bookmarks'
  | 'tts-prompt'
  | 'image-input'
  | 'skill-bundle'
  | 'persona-discovery-import'
  | 'routine-discovery-import'
  | 'skill-discovery-import'
  | 'skill-standard-import'
  | 'skill-standard-export'
  | 'profile-template-export'
  | 'profile-template-import'
  | 'profile-template-from-discovered'
  | 'profile-from-discovered'
  | 'profile-default'
  | 'profile-default-clear'
  | 'support-bundle-export'
  | 'support-bundle-inspect'
  | 'support-bundle-import'
  | 'subscription-inspect'
  | 'subscription-login-start'
  | 'subscription-login-finish'
  | 'subscription-logout'
  | 'delegate-task'
  | 'workplan-add'
  | 'workplan-status'
  | 'workplan-delete'
  | 'workplan-clear-completed'
>;

type AgentWorkspaceCommandEditorSubmission =
  | {
    readonly kind: 'editor';
    readonly editor: AgentWorkspaceLocalEditor;
    readonly status: string;
    readonly actionResult?: AgentWorkspaceActionResult;
  }
  | {
    readonly kind: 'dispatch';
    readonly command: string;
    readonly status: string;
    readonly actionResult: AgentWorkspaceActionResult;
  }
  | {
    readonly kind: 'prompt';
    readonly prompt: string;
    readonly status: string;
    readonly actionResult: AgentWorkspaceActionResult;
  };

export function isAgentWorkspaceCommandEditorKind(kind: AgentWorkspaceEditorKind): kind is AgentWorkspaceCommandEditorKind {
  return kind === 'web-research'
    || kind === 'web-fetch'
    || kind === 'knowledge-url'
    || kind === 'knowledge-search'
    || kind === 'knowledge-ask'
    || kind === 'routine-schedule'
    || kind === 'calendar-connect'
    || isAgentWorkspaceBasicCommandEditorKind(kind);
}

export function buildAgentWorkspaceCommandEditorSubmission(
  editor: AgentWorkspaceLocalEditor,
  readField: AgentWorkspaceFieldReader,
  commandDispatchAvailable: boolean,
  promptDispatchAvailable: boolean,
): AgentWorkspaceCommandEditorSubmission {
  // Web research and fetch are model tasks, so they are sent as a message. Forms
  // whose work is one tool call never come here: the workspace and
  // run_workspace_action run that call (agent-workspace-editor-tool-calls.ts).
  if (editor.kind === 'web-research' || editor.kind === 'web-fetch') {
    return buildAgentWorkspaceWebResearchSubmission(editor, readField, promptDispatchAvailable);
  }
  if (editor.kind === 'knowledge-url') return buildAgentKnowledgeUrlEditorSubmission(editor, readField, commandDispatchAvailable);
  if (editor.kind === 'knowledge-search' || editor.kind === 'knowledge-ask') {
    return buildAgentKnowledgeQueryEditorSubmission(editor, readField, commandDispatchAvailable);
  }
  if (isAgentWorkspaceBasicCommandEditorKind(editor.kind)) {
    return buildAgentWorkspaceBasicCommandEditorSubmission(editor, readField, commandDispatchAvailable);
  }
  if (editor.kind === 'calendar-connect') return buildAgentWorkspaceCalendarConnectEditorSubmission(editor, readField, commandDispatchAvailable);
  return buildAgentRoutineScheduleEditorSubmission(editor, readField, commandDispatchAvailable);
}
