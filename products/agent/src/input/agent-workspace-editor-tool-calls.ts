import type { AgentWorkspaceLocalEditor } from './agent-workspace-types.ts';
import { buildAgentArtifactBrowserToolArgs, buildAgentArtifactExportToolArgs, buildAgentArtifactPackageToolArgs, buildAgentArtifactPromoteKnowledgeToolArgs, buildAgentArtifactShowToolArgs } from './agent-workspace-artifact-browser-editor.ts';
import { buildAgentDocumentReviewerReadinessToolArgs, buildAgentDocumentReviewPacketPresetRefreshToolArgs, buildAgentDocumentReviewPacketPresetToolArgs, buildAgentDocumentReviewPacketShareToolArgs, buildAgentDocumentReviewPacketWizardToolArgs } from './agent-workspace-document-ops-editor.ts';
import { buildAgentDocumentToolArgs } from './agent-workspace-document-editor.ts';
import { buildAgentModelCompareAnalyticsToolArgs, buildAgentModelCompareApplyToolArgs, buildAgentModelCompareExportToolArgs, buildAgentModelCompareHandoffDiffToolArgs, buildAgentModelCompareJudgmentToolArgs, buildAgentModelCompareReviewToolArgs, buildAgentModelCompareRouteDecisionToolArgs, buildAgentModelCompareToolArgs } from './agent-workspace-model-compare-editor.ts';
import { captureAgentResearchReportToolArgs } from './agent-workspace-research-report-editor.ts';
import { buildAgentResearchRunToolArgs } from './agent-workspace-research-run-editor.ts';
import { buildAgentResearchSourceToolArgs } from './agent-workspace-research-source-editor.ts';

/**
 * The workspace forms whose work is one tool call, in one table: the owner's
 * own submit (agent-workspace.ts) and the agent's run_workspace_action build
 * the same call from the same fields, so the two cannot disagree.
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

/**
 * The two Document Ops lane reads, which run_workspace_action answers itself
 * (it is agent_harness); from the owner's own submit they are the same
 * agent_harness read.
 */
const LANE_READ_CALLS: Readonly<Record<string, WorkspaceEditorToolCall>> = {
  'document-reviewer-readiness': { callId: 'agent-harness-workspace-reviewer-readiness', tool: 'agent_harness', build: (read) => buildAgentDocumentReviewerReadinessToolArgs(read) },
  'document-review-packet-wizard': { callId: 'agent-harness-workspace-review-packet-wizard', tool: 'agent_harness', build: (read) => buildAgentDocumentReviewPacketWizardToolArgs(read) },
};

/** The tool call the owner's submit of a form runs: the shared table, plus the two lane reads. */
export function workspaceEditorOwnerToolCall(editor: AgentWorkspaceLocalEditor): WorkspaceEditorToolCall | undefined {
  return workspaceEditorToolCall(editor) ?? (Object.hasOwn(LANE_READ_CALLS, editor.kind) ? LANE_READ_CALLS[editor.kind] : undefined);
}
