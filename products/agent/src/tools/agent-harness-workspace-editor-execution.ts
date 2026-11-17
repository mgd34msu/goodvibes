import type { AgentWorkspaceEditorKind, AgentWorkspaceLocalEditor } from '../input/agent-workspace-types.ts';
import { buildAgentArtifactBrowserToolArgs, buildAgentArtifactExportToolArgs, buildAgentArtifactPackageToolArgs, buildAgentArtifactPromoteKnowledgeToolArgs, buildAgentArtifactShowToolArgs } from '../input/agent-workspace-artifact-browser-editor.ts';
import { buildAgentDocumentReviewPacketPresetRefreshToolArgs, buildAgentDocumentReviewPacketPresetToolArgs, buildAgentDocumentReviewPacketShareToolArgs } from '../input/agent-workspace-document-ops-editor.ts';
import { buildAgentDocumentToolArgs } from '../input/agent-workspace-document-editor.ts';
import { isAgentWorkspaceCommandEditorKind } from '../input/agent-workspace-command-editor.ts';
import { buildAgentModelCompareAnalyticsToolArgs, buildAgentModelCompareApplyToolArgs, buildAgentModelCompareExportToolArgs, buildAgentModelCompareHandoffDiffToolArgs, buildAgentModelCompareJudgmentToolArgs, buildAgentModelCompareReviewToolArgs, buildAgentModelCompareRouteDecisionToolArgs, buildAgentModelCompareToolArgs } from '../input/agent-workspace-model-compare-editor.ts';
import { captureAgentResearchReportToolArgs } from '../input/agent-workspace-research-report-editor.ts';
import { buildAgentResearchRunToolArgs } from '../input/agent-workspace-research-run-editor.ts';
import { buildAgentResearchSourceToolArgs } from '../input/agent-workspace-research-source-editor.ts';

/**
 * How run_workspace_action runs each workspace form, in one table. The runner
 * dispatches from it, and the description and route hint a listing prints are
 * derived from it, so the route the model is told is the route that runs.
 */

type FieldReader = (fieldId: string) => string;

/** One workspace form whose work is a single tool call. */
export interface WorkspaceEditorToolCall {
  /** The nested call id, stable per form. */
  readonly callId: string;
  readonly tool: string;
  /** Set for a form that changes something: the label its confirmation is asked under. */
  readonly confirmation?: string;
  /** The tool's arguments from the form's fields (and the person's request, where the tool records one). */
  readonly build: (readField: FieldReader, explicitUserRequest: string) => object;
}

const DOCUMENT_EDITOR_KINDS: ReadonlySet<string> = new Set([
  'document-browse', 'document-show', 'document-create', 'document-update', 'document-review', 'document-comment',
  'document-resolve-comment', 'document-suggest', 'document-accept-suggestion', 'document-reject-suggestion',
  'document-insert-artifact', 'document-attach-artifact', 'document-export',
]);

const EDITOR_TOOL_CALLS: Readonly<Record<string, WorkspaceEditorToolCall>> = {
  'artifact-browser': { callId: 'agent-harness-workspace-artifact-browser', tool: 'agent_artifacts', build: (read) => buildAgentArtifactBrowserToolArgs(read) },
  'artifact-show': { callId: 'agent-harness-workspace-artifact-show', tool: 'agent_artifacts', build: (read) => buildAgentArtifactShowToolArgs(read) },
  'artifact-export-file': { callId: 'agent-harness-workspace-artifact-export', tool: 'agent_artifacts', confirmation: 'Workspace artifact export',
    build: (read, request) => buildAgentArtifactExportToolArgs(read, request) },
  'artifact-export-package': { callId: 'agent-harness-workspace-artifact-package-export', tool: 'agent_artifacts', confirmation: 'Workspace artifact package export',
    build: (read, request) => buildAgentArtifactPackageToolArgs(read, request) },
  'artifact-promote-knowledge': { callId: 'agent-harness-workspace-artifact-promote-knowledge', tool: 'agent_knowledge_ingest', confirmation: 'Workspace artifact Knowledge promotion',
    build: (read, request) => buildAgentArtifactPromoteKnowledgeToolArgs(read, request) },
  'research-report': { callId: 'agent-harness-workspace-research-report', tool: 'agent_research_report', confirmation: 'Workspace research report artifact save',
    build: (read, request) => captureAgentResearchReportToolArgs(read, request) },
  'research-run': { callId: 'agent-harness-workspace-research-run', tool: 'agent_research_runs', confirmation: 'Workspace research run creation',
    build: (read, request) => buildAgentResearchRunToolArgs(read, request) },
  'research-source': { callId: 'agent-harness-workspace-research-source', tool: 'agent_research_sources', confirmation: 'Workspace research source queue add',
    build: (read, request) => buildAgentResearchSourceToolArgs(read, request) },
  'document-review-packet-preset': { callId: 'agent-harness-workspace-review-packet-preset', tool: 'agent_review_packet_presets', confirmation: 'Workspace review packet preset save',
    build: (read, request) => buildAgentDocumentReviewPacketPresetToolArgs(read, request) },
  'document-review-packet-preset-refresh': { callId: 'agent-harness-workspace-review-packet-preset-refresh', tool: 'agent_review_packet_presets', confirmation: 'Workspace review packet preset refresh',
    build: (read, request) => buildAgentDocumentReviewPacketPresetRefreshToolArgs(read, request) },
  'document-review-packet-share': { callId: 'agent-harness-workspace-review-packet-share', tool: 'agent_review_packet_share', confirmation: 'Workspace review packet share',
    build: (read, request) => buildAgentDocumentReviewPacketShareToolArgs(read, request) },
  'model-compare': { callId: 'agent-harness-workspace-model-compare', tool: 'agent_model_compare', confirmation: 'Workspace blind model comparison',
    build: (read, request) => buildAgentModelCompareToolArgs(read, request) },
  'local-model-benchmark': { callId: 'agent-harness-workspace-model-compare', tool: 'agent_model_compare', confirmation: 'Workspace blind model comparison',
    build: (read, request) => buildAgentModelCompareToolArgs(read, request) },
  'model-compare-review': { callId: 'agent-harness-workspace-model-compare-review', tool: 'agent_model_compare', build: (read) => buildAgentModelCompareReviewToolArgs(read) },
  'model-compare-handoff-diff': { callId: 'agent-harness-workspace-model-compare-handoff-diff', tool: 'agent_model_compare', build: (read) => buildAgentModelCompareHandoffDiffToolArgs(read) },
  'model-compare-judge': { callId: 'agent-harness-workspace-model-compare-judge', tool: 'agent_model_compare', confirmation: 'Workspace comparison judgment',
    build: (read, request) => buildAgentModelCompareJudgmentToolArgs(read, request) },
  'model-compare-apply': { callId: 'agent-harness-workspace-model-compare-apply', tool: 'agent_model_compare', confirmation: 'Workspace comparison route update',
    build: (read, request) => buildAgentModelCompareApplyToolArgs(read, request) },
  'model-compare-route-decision': { callId: 'agent-harness-workspace-model-compare-route-decision', tool: 'agent_model_compare', confirmation: 'Workspace comparison route decision',
    build: (read, request) => buildAgentModelCompareRouteDecisionToolArgs(read, request) },
  'model-compare-export': { callId: 'agent-harness-workspace-model-compare-export', tool: 'agent_model_compare', confirmation: 'Workspace comparison export',
    build: (read, request) => buildAgentModelCompareExportToolArgs(read, request) },
  'model-compare-analytics': { callId: 'agent-harness-workspace-model-compare-analytics', tool: 'agent_model_compare', build: (read) => buildAgentModelCompareAnalyticsToolArgs(read) },
};

/**
 * The tool call a workspace form stands for, or undefined for a form that is
 * not one tool call (a lane read, a local editor, a slash command). One table
 * for every caller: the harness runner (the agent filling a form in) and the
 * owner's own submit build the same call from the same fields.
 */
export function workspaceEditorToolCall(editor: AgentWorkspaceLocalEditor): WorkspaceEditorToolCall | undefined {
  if (DOCUMENT_EDITOR_KINDS.has(editor.kind)) {
    const isMutation = editor.kind !== 'document-browse' && editor.kind !== 'document-show';
    return { callId: 'agent-harness-workspace-document', tool: 'agent_documents', ...(isMutation ? { confirmation: 'Workspace Agent document action' } : {}),
      build: (read, request) => buildAgentDocumentToolArgs(editor, read, request) };
  }
  return Object.hasOwn(EDITOR_TOOL_CALLS, editor.kind) ? EDITOR_TOOL_CALLS[editor.kind] : undefined;
}

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
    return { route: 'slash-command-dispatch', command: '/agent-profile create <name> [--template <template>] --yes', dispatcher: 'run_command', confirmation: 'required',
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
