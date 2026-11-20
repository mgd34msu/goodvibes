import type { AgentWorkspaceEditorKind, AgentWorkspaceLocalEditor } from '../input/agent-workspace-types.ts';
import { isAgentWorkspaceCommandEditorKind } from '../input/agent-workspace-command-editor.ts';
import { workspaceEditorToolCall } from '../input/agent-workspace-editor-tool-calls.ts';

export { workspaceEditorToolCall, type WorkspaceEditorToolCall } from '../input/agent-workspace-editor-tool-calls.ts';

/**
 * What run_workspace_action does with each workspace form. The tool-call forms
 * come from the one table both the owner's submit and the runner use, so the
 * route the model is told is the route that runs.
 */

type LocalEditorDomain = 'memory' | 'note' | 'persona' | 'skill' | 'routine';

function localEditorDomain(editorKind: AgentWorkspaceEditorKind): LocalEditorDomain | null {
  return editorKind === 'memory' || editorKind === 'note' || editorKind === 'persona' || editorKind === 'skill' || editorKind === 'routine' ? editorKind : null;
}

const LOCAL_EDITOR_ACTIONS: Readonly<Record<LocalEditorDomain, readonly string[]>> = {
  memory: ['list', 'search', 'get', 'review', 'stale', 'delete'],
  note: ['list', 'search', 'get', 'review', 'stale', 'delete'],
  persona: ['list', 'search', 'get', 'use', 'clear_active', 'review', 'stale', 'delete'],
  skill: ['list', 'search', 'get', 'enable', 'disable', 'review', 'stale', 'delete'],
  routine: ['list', 'search', 'get', 'enable', 'disable', 'start', 'review', 'stale', 'delete'],
};

/** The forms run_workspace_action answers from a Document Ops lane read. */
const HARNESS_LANE_EDITOR_KINDS: ReadonlySet<string> = new Set(['document-reviewer-readiness', 'document-review-packet-wizard']);

/** What run_workspace_action does with this form, from the table it dispatches through. */
export function describeWorkspaceEditorModelExecution(editorKind: AgentWorkspaceEditorKind): Record<string, unknown> {
  const localDomain = localEditorDomain(editorKind);
  if (localDomain) {
    return { route: 'agent_local_registry', tool: 'agent_local_registry', domain: localDomain, action: 'create_or_update_from_fields', confirmation: 'required',
      supportedActions: LOCAL_EDITOR_ACTIONS[localDomain],
      note: 'run_workspace_action validates the editor fields and dispatches through the Agent-local registry.' };
  }
  const call = workspaceEditorToolCall({ kind: editorKind } as AgentWorkspaceLocalEditor);
  if (call) {
    return { route: call.tool, tool: call.tool, confirmation: call.confirmation ? 'required' : 'not-required',
      ...(call.confirmation ? { label: call.confirmation } : {}),
      note: `run_workspace_action builds the ${call.tool} call from the submitted fields and runs it as a nested call${call.confirmation ? ' under current recorded effect admission' : ''}.` };
  }
  if (editorKind === 'learned-behavior') {
    return { route: 'direct-agent-local-create', action: 'create_learned_behavior', confirmation: 'required',
      note: 'run_workspace_action creates a local skill, routine, or persona from the submitted learned-behavior fields.' };
  }
  if (editorKind === 'profile') {
    return { route: 'slash-command-dispatch', command: '/agent-home create <name> [--starter <starter>]', dispatcher: 'run_command', confirmation: 'required',
      note: 'run_workspace_action builds the matching profile creation slash command from the submitted fields.' };
  }
  if (HARNESS_LANE_EDITOR_KINDS.has(editorKind)) {
    return { route: 'agent_harness', tool: 'agent_harness', mode: 'document_ops_lane', confirmation: 'not-required',
      note: 'run_workspace_action answers this form with the matching Document Ops lane read.' };
  }
  if (isAgentWorkspaceCommandEditorKind(editorKind)) {
    return { route: 'slash-command-dispatch', dispatcher: 'run_command', confirmation: 'required',
      note: 'run_workspace_action builds the same submission as the TUI form from the submitted fields: a slash command it runs through the shared command registry, or a main-conversation prompt it returns.' };
  }
  return { route: 'model-tool-required', confirmation: 'not-required',
    note: 'run_workspace_action does not run this form; it answers model_tool_required with the editor schema.' };
}

/** The route a listing prints for a form: the tool the runner calls, or run_workspace_action itself. */
export function workspaceEditorRouteHint(editorKind: AgentWorkspaceEditorKind): string {
  const execution = describeWorkspaceEditorModelExecution(editorKind);
  if (typeof execution.tool === 'string' && execution.tool !== 'agent_harness') return execution.tool;
  return 'agent_harness mode:"run_workspace_action"';
}
