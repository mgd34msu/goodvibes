/**
 * What Enter on a workspace row does. A row that does something opens the
 * described action it names (its guided form, the same one the slash command
 * opens); a setting row changes or opens that setting; the rest open a picker
 * or an area of this workspace, or say what to do in the conversation.
 */
import { parseSlashCommand } from './slash-command-parser.ts';
import { workspaceActionLine, type WorkspaceActionTarget } from './workspace-actions.ts';
import type {
  AgentWorkspaceActionResult,
  AgentWorkspaceCategory,
  AgentWorkspaceFocusPane,
} from './agent-workspace-types.ts';

type AgentWorkspaceAction = AgentWorkspaceCategory['actions'][number];

interface AgentWorkspaceActivationHost {
  readonly categories: readonly AgentWorkspaceCategory[];
  readonly selectedCategory: AgentWorkspaceCategory;
  readonly selectedAction: AgentWorkspaceAction | null;
  focusPane: AgentWorkspaceFocusPane;
  selectedCategoryIndex: number;
  selectedActionIndex: number;
  status: string;
  lastActionResult: AgentWorkspaceActionResult | null;
  focusActions(): void;
  clampSelection(): void;
  applySettingAction(action: AgentWorkspaceAction, requestRender?: () => void): void;
  importTuiSettings(requestRender?: () => void): void;
  openModelPickerAction(action: AgentWorkspaceAction, requestRender?: () => void): void;
  openSettingsModalAction(action: AgentWorkspaceAction, requestRender?: () => void): void;
  completeOnboarding(): void;
  hasCommandDispatch(): boolean;
  dispatchWorkspaceCommand(command: string, behavior?: 'inline' | 'compose' | 'exit', displayCommand?: string): void;
  commitActionSearchSelection(): boolean;
  closeToComposer(): void;
  /** Open the row's described action over the composer; false when this surface cannot. */
  openGuidedAction(target: WorkspaceActionTarget): boolean;
}

export function activateAgentWorkspaceSelection(
  workspace: AgentWorkspaceActivationHost,
  requestRender?: () => void,
): void {
  if (workspace.focusPane === 'categories') {
    workspace.focusActions();
    return;
  }
  if (!workspace.commitActionSearchSelection()) return;
  const action = workspace.selectedAction;
  if (!action) return;
  if (action.kind === 'act' && action.act) {
    if (workspace.openGuidedAction(action.act)) return;
    // No guided form on this surface, or the command is not described: run its typed line.
    dispatchLine(workspace, action, workspaceActionLine(action.act));
    return;
  }
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
  if (action.kind === 'onboarding-complete') {
    workspace.completeOnboarding();
    return;
  }
  // A row that exits with no command to run is a "back to the conversation" row.
  if (action.commandBehavior === 'exit' && !action.command) {
    workspace.closeToComposer();
    return;
  }
  if (action.kind === 'guidance' || action.kind === 'workspace' || !action.command) {
    handleGuidanceOrWorkspaceAction(workspace, action);
    return;
  }
  dispatchLine(workspace, action, action.command);
}

function dispatchLine(workspace: AgentWorkspaceActivationHost, action: AgentWorkspaceAction, line: string): void {
  if (action.safety === 'blocked') {
    workspace.status = `Blocked here: ${action.label}.`;
    workspace.lastActionResult = { kind: 'blocked', title: `${action.label} is blocked in Agent`, detail: action.detail, command: line, safety: action.safety };
    return;
  }
  if (!parseSlashCommand(line).name || !workspace.hasCommandDispatch()) {
    workspace.status = `${line} cannot be run from this workspace.`;
    workspace.lastActionResult = { kind: 'error', title: `${action.label} is not available here`, detail: `Type ${line} in the conversation instead.`, command: line, safety: action.safety };
    return;
  }
  workspace.status = `Opening ${line}.`;
  workspace.lastActionResult = { kind: 'dispatched', title: `Opening ${action.label}`, detail: `Runs ${line}.`, command: line, safety: action.safety };
  workspace.dispatchWorkspaceCommand(line, action.commandBehavior);
}

function handleGuidanceOrWorkspaceAction(
  workspace: AgentWorkspaceActivationHost,
  action: AgentWorkspaceAction,
): void {
  if (action.kind === 'workspace' && action.targetCategoryId) {
    const targetIndex = workspace.categories.findIndex((category) => category.id === action.targetCategoryId);
    if (targetIndex >= 0) {
      workspace.selectedCategoryIndex = targetIndex;
      workspace.selectedActionIndex = 0;
      workspace.focusActions();
      workspace.status = `Opened ${workspace.selectedCategory.label}.`;
      workspace.lastActionResult = { kind: 'refreshed', title: `Opened ${workspace.selectedCategory.label}`, detail: action.detail, safety: action.safety };
      workspace.clampSelection();
      return;
    }
    workspace.status = `Workspace area unavailable: ${action.targetCategoryId}.`;
    workspace.lastActionResult = { kind: 'error', title: 'Workspace area unavailable', detail: `No Agent workspace area is called ${action.targetCategoryId}.`, safety: action.safety };
    return;
  }
  workspace.status = action.detail;
  workspace.lastActionResult = { kind: 'guidance', title: action.label, detail: action.detail, safety: action.safety };
}
