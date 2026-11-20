import { createLearnedBehaviorEditor, createLocalEditor, createProfileEditor } from './agent-workspace-editors.ts';
import { createAgentArtifactBrowserEditor, createAgentArtifactExportEditor, createAgentArtifactPackageEditor, createAgentArtifactPromoteKnowledgeEditor, createAgentArtifactShowEditor } from './agent-workspace-artifact-browser-editor.ts';
import { createAgentDocumentAcceptSuggestionEditor, createAgentDocumentAttachArtifactEditor, createAgentDocumentBrowseEditor, createAgentDocumentCommentEditor, createAgentDocumentCreateEditor, createAgentDocumentExportEditor, createAgentDocumentInsertArtifactEditor, createAgentDocumentRejectSuggestionEditor, createAgentDocumentResolveCommentEditor, createAgentDocumentReviewEditor, createAgentDocumentShowEditor, createAgentDocumentSuggestEditor, createAgentDocumentUpdateEditor } from './agent-workspace-document-editor.ts';
import { createAgentDocumentReviewerReadinessEditor, createAgentDocumentReviewPacketPresetEditor, createAgentDocumentReviewPacketPresetRefreshEditor, createAgentDocumentReviewPacketShareEditor, createAgentDocumentReviewPacketWizardEditor } from './agent-workspace-document-ops-editor.ts';
import { createAgentWorkspaceBasicCommandEditor, isAgentWorkspaceBasicCommandEditorKind } from './agent-workspace-basic-command-editors.ts';
import { createAgentKnowledgeQueryEditor } from './agent-workspace-knowledge-query-editor.ts';
import { createAgentLocalModelBenchmarkEditor, createAgentModelCompareAnalyticsEditor, createAgentModelCompareApplyEditor, createAgentModelCompareEditor, createAgentModelCompareExportEditor, createAgentModelCompareHandoffDiffEditor, createAgentModelCompareJudgmentEditor, createAgentModelCompareReviewEditor, createAgentModelCompareRouteDecisionEditor } from './agent-workspace-model-compare-editor.ts';
import { createAgentResearchReportEditor } from './agent-workspace-research-report-editor.ts';
import { createAgentResearchRunEditor } from './agent-workspace-research-run-editor.ts';
import { createAgentResearchSourceEditor } from './agent-workspace-research-source-editor.ts';
import { createEmailConnectWizardEditor, type AgentWorkspaceEmailConnectPrefill } from './agent-workspace-email-connect-editor.ts';
import { createCalendarConnectEditor } from './agent-workspace-calendar-connect-editor.ts';
import { createCalendarSubscribeWizardEditor } from './agent-workspace-calendar-subscribe-editor.ts';
import { createCalendarOAuthEditor } from './agent-workspace-calendar-oauth-editor.ts';
import {
  createGoogleAdoptEditor,
  createGoogleAppPasswordEditor,
  createGoogleClientFileEditor,
  createGoogleClientManualEditor,
  createGoogleConnectEditor,
  createGoogleForgetEditor,
  createGoogleReauthorizeEditor,
  createGoogleStatusEditor,
  createGoogleWalkthroughEditor,
} from './agent-workspace-google-setup-editor.ts';
import type { AgentWorkspaceCalendarOAuthConfigStatus } from './agent-workspace-calendar-oauth-editor.ts';
import { createRoutineScheduleEditor } from './agent-workspace-routine-schedule-editor.ts';
import { createAgentWorkspaceWebResearchEditor } from './agent-workspace-web-research-editor.ts';
import { parseSlashCommand } from './slash-command-parser.ts';
import type {
  AgentWorkspaceActionResult,
  AgentWorkspaceCategory,
  AgentWorkspaceCommandDispatcher,
  AgentWorkspaceEditorKind,
  AgentWorkspaceEmailConnectStatus,
  AgentWorkspaceFocusPane,
  AgentWorkspaceLocalEditor,
  AgentWorkspaceLocalEditorKind,
  AgentWorkspaceLocalLibraryItem,
  AgentWorkspaceLocalOperation,
  AgentWorkspaceRecentReviewerHandoffArtifact,
  AgentWorkspaceReviewPacketDefaults,
  AgentWorkspaceRuntimeSnapshot,
  AgentWorkspaceRuntimeStarterTemplateItem,
} from './agent-workspace-types.ts';

interface AgentWorkspaceActivationHost {
  readonly categories: readonly AgentWorkspaceCategory[];
  readonly selectedCategory: AgentWorkspaceCategory;
  readonly selectedAction: AgentWorkspaceCategory['actions'][number] | null;
  readonly runtimeSnapshot: AgentWorkspaceRuntimeSnapshot | null;
  localEditor: AgentWorkspaceLocalEditor | null;
  focusPane: AgentWorkspaceFocusPane;
  selectedCategoryIndex: number;
  selectedActionIndex: number;
  status: string;
  lastActionResult: AgentWorkspaceActionResult | null;
  submitEditorFieldOrForm(requestRender?: () => void): void;
  focusActions(): void;
  clampSelection(): void;
  moveLocalLibraryItemSelection(kind: AgentWorkspaceLocalEditorKind, delta: number): void;
  selectedLocalLibraryItem(kind: AgentWorkspaceLocalEditorKind): AgentWorkspaceLocalLibraryItem | null;
  applyLocalLibraryOperation(operation: AgentWorkspaceLocalOperation): void;
  applySettingAction(action: AgentWorkspaceCategory['actions'][number], requestRender?: () => void): void;
  importTuiSettings(requestRender?: () => void): void;
  openModelPickerAction(action: AgentWorkspaceCategory['actions'][number], requestRender?: () => void): void;
  openSettingsModalAction(action: AgentWorkspaceCategory['actions'][number], requestRender?: () => void): void;
  completeOnboarding(): void;
  hasCommandDispatch(): boolean;
  dispatchWorkspaceCommand(command: string, behavior?: 'inline' | 'compose' | 'exit', displayCommand?: string): void;
  commitActionSearchSelection(): boolean;
  closeToComposer(): void;
  /** Open a described command's action for this row instead of its form; false when the row keeps its form. */
  openGuidedAction?(editorKind: string): boolean;
  /** The stored inbox settings, read when the inbox form opens. */
  emailConnectPrefill?(): AgentWorkspaceEmailConnectPrefill | null;
  /** The connected host's inbox settings, or null when no host holds them (then emailConnectPrefill answers). */
  loadEmailConnectPrefillFromHost?(): Promise<AgentWorkspaceEmailConnectPrefill | null> | null;
}

function openActionEditor(
  workspace: AgentWorkspaceActivationHost,
  action: AgentWorkspaceCategory['actions'][number],
  editorKind: NonNullable<AgentWorkspaceCategory['actions'][number]['editorKind']>,
  emailConnectPrefill: AgentWorkspaceEmailConnectPrefill | null,
  requestRender?: () => void,
): void {
  const editor = createAgentWorkspaceEditor(editorKind, {
    runtimeStarterTemplates: workspace.runtimeSnapshot?.runtimeStarterTemplates ?? [],
    selectedRoutine: workspace.selectedLocalLibraryItem('routine'),
    recentReviewerHandoffArtifacts: workspace.runtimeSnapshot?.recentReviewerHandoffArtifacts ?? [],
    reviewPacketDefaults: workspace.runtimeSnapshot?.reviewPacketDefaults ?? null,
    emailConnectStatus: workspace.runtimeSnapshot?.emailConnectStatus ?? null,
    emailConnectPrefill,
    calendarOAuthConfigStatus: workspace.runtimeSnapshot?.calendarOAuthConfigStatus ?? null,
  });
  if (!editor) {
    workspace.status = `Editor unavailable: ${editorKind}.`;
    workspace.lastActionResult = {
      kind: 'error',
      title: 'Editor unavailable',
      detail: `No Agent workspace editor exists for ${editorKind}.`,
      safety: action.safety,
    };
    return;
  }
  workspace.localEditor = editor;
  workspace.status = `Editing ${editor.title}.`;
  workspace.lastActionResult = {
    kind: 'guidance',
    title: editor.title,
    detail: editor.message,
    safety: action.safety,
  };
  // A form with nothing to fill in (a read) runs on the Enter that opened it.
  if (editor.fields.length === 0) workspace.submitEditorFieldOrForm(requestRender);
}

export function activateAgentWorkspaceSelection(
  workspace: AgentWorkspaceActivationHost,
  requestRender?: () => void,
): void {
  if (workspace.localEditor) {
    workspace.submitEditorFieldOrForm(requestRender);
    return;
  }
  if (workspace.focusPane === 'categories') {
    workspace.focusActions();
    return;
  }
  if (!workspace.commitActionSearchSelection()) return;
  const action = workspace.selectedAction;
  if (!action) return;
  if (action.kind === 'setting') {
    workspace.applySettingAction(action, requestRender);
    return;
  }
  if (action.kind === 'settings-import') {
    workspace.importTuiSettings(requestRender);
    return;
  }
  if (action.kind === 'model-picker') {
    workspace.openModelPickerAction(action, requestRender);
    return;
  }
  if (action.kind === 'settings-modal') {
    workspace.openSettingsModalAction(action, requestRender);
    return;
  }
  if (action.kind === 'editor' && action.editorKind) {
    // A row whose command is described opens that action's guided path, not a form.
    if (workspace.openGuidedAction?.(action.editorKind)) return;
    if (action.editorKind === 'email-connect-wizard') {
      // The connected host owns the inbox settings: the form opens with its values once it answers.
      const fromHost = workspace.loadEmailConnectPrefillFromHost?.();
      if (fromHost) {
        const editorKind = action.editorKind;
        workspace.status = 'Reading the stored inbox settings from the connected host...';
        void fromHost.then((prefill) => {
          // Opened only if the person is still on this row with no other form open.
          if (workspace.localEditor || workspace.selectedAction?.id !== action.id) return;
          openActionEditor(workspace, action, editorKind, prefill, requestRender);
          requestRender?.();
        });
        return;
      }
    }
    openActionEditor(workspace, action, action.editorKind,
      action.editorKind === 'email-connect-wizard' ? workspace.emailConnectPrefill?.() ?? null : null, requestRender);
    return;
  }
  if (action.kind === 'local-selection' && action.localKind) {
    workspace.moveLocalLibraryItemSelection(action.localKind, action.selectionDelta ?? 0);
    return;
  }
  if (action.kind === 'local-operation' && action.localOperation) {
    workspace.applyLocalLibraryOperation(action.localOperation);
    return;
  }
  if (action.kind === 'onboarding-complete') {
    workspace.completeOnboarding();
    return;
  }
  // A row that exits with no command to run is a "back to the conversation" row.
  if (action.commandBehavior === 'exit' && !action.command) {
    workspace.closeToComposer();
    return;
  }
  if (action.kind === 'guidance' || !action.command) {
    handleGuidanceOrWorkspaceAction(workspace, action);
    return;
  }
  if (action.safety === 'blocked') {
    workspace.status = `Blocked here: ${action.label}.`;
    workspace.lastActionResult = {
      kind: 'blocked',
      title: `${action.label} is blocked in Agent`,
      detail: action.detail,
      command: action.command,
      safety: action.safety,
    };
    return;
  }
  const parsed = parseSlashCommand(action.command);
  if (!parsed.name) {
    workspace.status = `No command is configured for ${action.label}.`;
    workspace.lastActionResult = {
      kind: 'error',
      title: 'Command unavailable',
      detail: `No command is configured for ${action.label}.`,
      safety: action.safety,
    };
    return;
  }
  if (/<[^>\s]+(?:\s+[^>]*)?>/.test(action.command)) {
    workspace.status = `Command needs concrete values before dispatch: ${action.command}.`;
    workspace.lastActionResult = {
      kind: 'guidance',
      title: `${action.label} needs details`,
      detail: 'This action needs concrete values before it can run. Return to the composer and include the real task text.',
      command: action.command,
      safety: action.safety,
    };
    return;
  }
  if (!workspace.hasCommandDispatch()) {
    workspace.status = `Command dispatch is not available for ${action.command}.`;
    workspace.lastActionResult = {
      kind: 'error',
      title: 'Command dispatch unavailable',
      detail: `The command ${action.command} cannot be opened from this runtime.`,
      command: action.command,
      safety: action.safety,
    };
    return;
  }
  workspace.status = `Opening ${action.command}.`;
  workspace.lastActionResult = {
    kind: 'dispatched',
    title: `Opening ${action.label}`,
    detail: 'The workspace handed this command to the shell-owned command router.',
    command: action.command,
    safety: action.safety,
  };
  workspace.dispatchWorkspaceCommand(action.command, action.commandBehavior);
}

type AgentWorkspaceEditorOptions = {
  readonly runtimeStarterTemplates?: readonly AgentWorkspaceRuntimeStarterTemplateItem[];
  readonly selectedRoutine?: AgentWorkspaceLocalLibraryItem | null;
  readonly recentReviewerHandoffArtifacts?: readonly AgentWorkspaceRecentReviewerHandoffArtifact[];
  readonly reviewPacketDefaults?: AgentWorkspaceReviewPacketDefaults | null;
  readonly emailConnectStatus?: AgentWorkspaceEmailConnectStatus | null;
  readonly emailConnectPrefill?: AgentWorkspaceEmailConnectPrefill | null;
  readonly calendarOAuthConfigStatus?: AgentWorkspaceCalendarOAuthConfigStatus | null;
};

/**
 * One constructor per form kind that is not built by a family table. A kind
 * is opened by one lookup here, then the family tables, then the local
 * registry editors.
 */
const EDITOR_CONSTRUCTORS: Partial<Record<AgentWorkspaceEditorKind, (o: AgentWorkspaceEditorOptions) => AgentWorkspaceLocalEditor>> = {
  'email-connect-wizard': (o) => createEmailConnectWizardEditor(o.emailConnectStatus ?? null, o.emailConnectPrefill ?? null),
  'calendar-connect': () => createCalendarConnectEditor(),
  'calendar-subscribe-wizard': () => createCalendarSubscribeWizardEditor(),
  'calendar-oauth-google': (o) => createCalendarOAuthEditor('google', o.calendarOAuthConfigStatus?.google ?? false),
  'calendar-oauth-outlook': (o) => createCalendarOAuthEditor('microsoft', o.calendarOAuthConfigStatus?.microsoft ?? false),
  'google-status': () => createGoogleStatusEditor(),
  'google-connect': () => createGoogleConnectEditor(),
  'google-reauthorize': () => createGoogleReauthorizeEditor(),
  'google-forget': () => createGoogleForgetEditor(),
  'google-setup-walkthrough': () => createGoogleWalkthroughEditor(),
  'google-setup-app-password': () => createGoogleAppPasswordEditor(),
  'google-adopt': () => createGoogleAdoptEditor(),
  'google-client-file': () => createGoogleClientFileEditor(),
  'google-client-manual': () => createGoogleClientManualEditor(),
  'profile': (o) => createProfileEditor(o.runtimeStarterTemplates ?? []),
  'learned-behavior': () => createLearnedBehaviorEditor(),
  'web-research': () => createAgentWorkspaceWebResearchEditor('research'),
  'web-fetch': () => createAgentWorkspaceWebResearchEditor('fetch'),
  'research-run': () => createAgentResearchRunEditor(),
  'research-source': () => createAgentResearchSourceEditor(),
  'research-report': () => createAgentResearchReportEditor(),
  'artifact-browser': () => createAgentArtifactBrowserEditor(),
  'artifact-show': () => createAgentArtifactShowEditor(),
  'artifact-export-file': () => createAgentArtifactExportEditor(),
  'artifact-export-package': () => createAgentArtifactPackageEditor(),
  'artifact-promote-knowledge': () => createAgentArtifactPromoteKnowledgeEditor(),
  'document-browse': () => createAgentDocumentBrowseEditor(),
  'document-show': () => createAgentDocumentShowEditor(),
  'document-create': () => createAgentDocumentCreateEditor(),
  'document-update': () => createAgentDocumentUpdateEditor(),
  'document-review': () => createAgentDocumentReviewEditor(),
  'document-comment': () => createAgentDocumentCommentEditor(),
  'document-resolve-comment': () => createAgentDocumentResolveCommentEditor(),
  'document-suggest': () => createAgentDocumentSuggestEditor(),
  'document-accept-suggestion': () => createAgentDocumentAcceptSuggestionEditor(),
  'document-reject-suggestion': () => createAgentDocumentRejectSuggestionEditor(),
  'document-insert-artifact': () => createAgentDocumentInsertArtifactEditor(),
  'document-attach-artifact': () => createAgentDocumentAttachArtifactEditor(),
  'document-export': (o) => createAgentDocumentExportEditor(o.reviewPacketDefaults ?? null),
  'document-reviewer-readiness': () => createAgentDocumentReviewerReadinessEditor(),
  'document-review-packet-wizard': () => createAgentDocumentReviewPacketWizardEditor(),
  'document-review-packet-preset': (o) => createAgentDocumentReviewPacketPresetEditor(o.reviewPacketDefaults ?? null),
  'document-review-packet-preset-refresh': () => createAgentDocumentReviewPacketPresetRefreshEditor(),
  'document-review-packet-share': (o) => createAgentDocumentReviewPacketShareEditor(o.reviewPacketDefaults ?? null),
  'model-compare': () => createAgentModelCompareEditor(),
  'local-model-benchmark': () => createAgentLocalModelBenchmarkEditor(),
  'model-compare-review': () => createAgentModelCompareReviewEditor(),
  'model-compare-handoff-diff': (o) => createAgentModelCompareHandoffDiffEditor(o.recentReviewerHandoffArtifacts ?? []),
  'model-compare-judge': () => createAgentModelCompareJudgmentEditor(),
  'model-compare-apply': (o) => createAgentModelCompareApplyEditor(o.reviewPacketDefaults ?? null),
  'model-compare-route-decision': (o) => createAgentModelCompareRouteDecisionEditor(o.reviewPacketDefaults ?? null),
  'model-compare-export': (o) => createAgentModelCompareExportEditor(o.reviewPacketDefaults ?? null),
  'model-compare-analytics': () => createAgentModelCompareAnalyticsEditor(),
  'knowledge-ask': () => createAgentKnowledgeQueryEditor('ask'),
  'knowledge-search': () => createAgentKnowledgeQueryEditor('search'),
  'routine-schedule': (o) => createRoutineScheduleEditor(o.selectedRoutine ?? null),
};

const LOCAL_REGISTRY_EDITOR_KINDS = new Set<AgentWorkspaceEditorKind>(['memory', 'note', 'persona', 'skill', 'routine', 'knowledge-url']);

export function createAgentWorkspaceEditor(
  editorKind: AgentWorkspaceEditorKind,
  options: AgentWorkspaceEditorOptions = {},
): AgentWorkspaceLocalEditor | null {
  const construct = EDITOR_CONSTRUCTORS[editorKind];
  if (construct) return construct(options);
  if (isAgentWorkspaceBasicCommandEditorKind(editorKind)) return createAgentWorkspaceBasicCommandEditor(editorKind);
  if (LOCAL_REGISTRY_EDITOR_KINDS.has(editorKind)) return createLocalEditor(editorKind as Parameters<typeof createLocalEditor>[0]);
  return null;
}

function handleGuidanceOrWorkspaceAction(
  workspace: AgentWorkspaceActivationHost,
  action: AgentWorkspaceCategory['actions'][number],
): void {
  if (action.kind === 'workspace' && action.targetCategoryId) {
    const targetIndex = workspace.categories.findIndex((category) => category.id === action.targetCategoryId);
    if (targetIndex >= 0) {
      workspace.selectedCategoryIndex = targetIndex;
      workspace.selectedActionIndex = 0;
      workspace.focusActions();
      workspace.status = `Opened ${workspace.selectedCategory.label}.`;
      workspace.lastActionResult = {
        kind: 'refreshed',
        title: `Opened ${workspace.selectedCategory.label}`,
        detail: action.detail,
        safety: action.safety,
      };
      workspace.clampSelection();
      return;
    }
    workspace.status = `Workspace area unavailable: ${action.targetCategoryId}.`;
    workspace.lastActionResult = {
      kind: 'error',
      title: 'Workspace area unavailable',
      detail: `No Agent workspace category exists for ${action.targetCategoryId}.`,
      safety: action.safety,
    };
    return;
  }
  workspace.status = action.detail;
  workspace.lastActionResult = {
    kind: 'guidance',
    title: action.label,
    detail: action.detail,
    safety: action.safety,
  };
}
