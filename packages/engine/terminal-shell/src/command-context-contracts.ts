import type { ModelPickerTarget } from './model-picker-types.js';
import type { SettingsTargetOutcome } from './settings-navigation.js';
import type { PermissionRequestHandler } from '@goodvibes/engine/platform/platform/permissions';
import type { OpenSelection } from '@goodvibes/engine/terminal-shell/selection-modal';
import type { ProviderRegistry } from '@goodvibes/engine/platform/platform/providers';
import type { FileUndoManager } from '@goodvibes/engine/platform/platform/state';
import type { DeepReadonly } from '@goodvibes/engine/platform/platform/config';
import type { GoodVibesConfig } from '@goodvibes/engine/platform/platform/config';
import type { ConfigManager } from '@goodvibes/engine/platform/platform/config';
import type { VoiceProviderRegistry } from '@goodvibes/engine/platform/platform/voice';
import type { VoiceService } from '@goodvibes/engine/platform/platform/voice';
import type { ToolRegistry } from '@goodvibes/engine/platform/platform/tools';
import type { McpRegistry } from '@goodvibes/engine/platform/platform/mcp';
/** Shared command capabilities; products extend these contracts with their own policy and UI actions. */
export interface TerminalCommandRuntimeState {
  model: string;
  provider: string;
  systemPrompt: string;
  reasoningEffort: string;
  sessionId: string;
}

export interface TerminalCommandUiActions<Target extends ModelPickerTarget> {
  renderRequest: () => void;
  print: (text: string) => void;
  /** A line later calls replace in place (a progress line); null when this output cannot (the line was printed as it is). */
  printLive?: (text: string) => ((next: string) => void) | null;
  exit: () => void;
  submitSpokenInput?: (text: string, content?: import('@goodvibes/engine/platform/platform/providers').ContentPart[]) => void;
  /**
   * Send text as a conversation turn exactly as given, with none of the
   * composer's grammar (`!` shell, `# ` note, `!#` pin, `@model:` switch).
   * Skill bodies, retries, templates, image prompts, forms and speech use this;
   * only text typed into the composer goes through `submitInput`.
   */
  submitTurn?: (
    text: string,
    content?: import('@goodvibes/engine/platform/platform/providers').ContentPart[],
    context?: import('./native/native-conversation-input.js').ProductInputContext,
  ) => void;
  stopSpokenOutput?: () => void;
  /** `/voice wake-again`: start listening for the wake word again after it stopped itself; says what happened. */
  listenForWakeAgain?: () => Promise<string>;
  pasteFromClipboard?: () => {
    pasted: boolean;
    kind: 'image' | 'text' | 'none';
    /** Lines of pasted text (0 for an image): what a receipt may report. */
    lines: number;
    marker?: string;
  };
  executeCommand?: (name: string, args: string[]) => Promise<boolean>;
  cancelGeneration?: () => void;
  isGenerating?: () => boolean;
  completeModelSelection?: (selection: {
    model: { id: string; provider: string; displayName: string; registryKey: string };
    effort: string;
    contextCap?: number | null;
    /** Which config target to write the selected model to. Defaults to 'main'. */
    target?: Target;
    /**
     * True only when `effort` came from the picker's effort STEP, an explicit
     * user choice, which is the only thing allowed to update the stored
     * preference `provider.reasoningEffort`. The model-only and context-cap
     * commit routes pass a level merely carried over from the previous model;
     * storing that is how a one-time snap down used to become permanent.
     */
    effortChosenByUser?: boolean;
    /** Write no "Switched to model" line into the conversation; the caller says it (first run). */
    quiet?: boolean;
  }) => void;
  clearScreen?: () => void;
  beginConcealedInput?: (request: import('./concealed-input.js').ConcealedInputRequest) => void;
  activatePlan?: (planId: string, task: string) => void;
  requestPermission?: PermissionRequestHandler;
}

export interface TerminalCommandShellUiOpeners<Target extends ModelPickerTarget> {
  reloadSystemPrompt?: () => string;
  /** `onClosed` hears once how this picker session ends: true when a main-model selection was applied. */
  openModelPicker?: (onClosed?: (chosen: boolean) => void) => void;
  openModelPickerWithTarget?: (target: Target) => boolean;
  openProviderModelPickerWithTarget?: (target: Target) => boolean;
  openProviderPicker?: () => void;
  openContextInspector?: () => void;
  openBookmarkModal?: () => void;
  jumpToBookmark?: (key: string) => void;
  scrollToLine?: (line: number) => void;
  openSelection?: OpenSelection;
  /** Opens settings at `target`; the outcome says where it landed (`not-found`: the text became the search). */
  openSettingsModal?: (target?: string) => SettingsTargetOutcome | 'unreported' | void;
  /** Opens the three-step first run again (`/setup` → Run first-run again), whether or not a model is ready. */
  openFirstRun?: () => void;
  /** Opens first run's "Who decides" step alone when no decision model can be asked now; false when it is not needed. */
  openWhoDecides?: () => Promise<boolean>;
  openSessionPicker?: () => void;
  openProfilePicker?: () => void;
  getScrollTop?: () => number;
  openSessionView?: (target: { readonly kind: 'agent' | 'process'; readonly id: string }) => boolean;
  openNotifications?: () => void;
  /**
   * Alt+O / Alt+I / Alt+S (and the Agent's Alt+R) on the newest failed turn's
   * row: use another model, show the details, sign in again, try again
   * (turn-failure-actions.ts). False when no failed turn offers it (the key
   * does nothing).
   */
  failedTurnAction?: (action: 'retry' | 'other-model' | 'details' | 'sign-in') => boolean;
  focusPrompt?: () => void;
  openMcpWorkspace?: () => void;
}

export interface TerminalCommandSessionServices {
  readonly sessionManager?: import('@goodvibes/engine/platform/platform/sessions').SessionManager;
  readonly sessionMemoryStore?: import('@goodvibes/engine/platform/platform/core').SessionMemoryStore;
  readonly sessionLineageTracker?: import('@goodvibes/engine/platform/platform/core').SessionLineageTracker;
  readonly changeTracker?: import('@goodvibes/engine/platform/platform/sessions').SessionChangeTracker;
  readonly hydrateSessionUsage?: () => void;
  /** The contract operator `/workstream` lists, inspects, stops, answers, retries and re-budgets contracts through. */
  readonly contractOperator?: import('@goodvibes/engine/platform/platform/contract').ContractOperatorService;
  /** Workstream drafts: propose a plan, review and edit it, approve and launch it as a contract (`/workstream propose`). */
  readonly workstreamDrafts?: import('@goodvibes/engine/platform/platform/orchestration').WorkstreamDraftService;
}

export interface TerminalCommandProviderServices {
  readonly providerRegistry: ProviderRegistry;
  readonly providerOptimizer?: import('@goodvibes/engine/platform/platform/providers').ProviderOptimizer;
  readonly favoritesStore?: import('@goodvibes/engine/platform/platform/providers').FavoritesStore;
  readonly benchmarkStore?: import('@goodvibes/engine/platform/platform/providers').BenchmarkStore;
}

export interface TerminalCommandWorkspaceUiServices {
  fileUndoManager?: FileUndoManager;
  profileManager?: import('@goodvibes/engine/platform/platform/profiles').ProfileManager;
  bookmarkManager?: import('@goodvibes/engine/platform/platform/bookmarks').BookmarkManager;
  projectPlanningService?: import('@goodvibes/engine/platform/platform/knowledge').ProjectPlanningService;
  projectPlanningProjectId?: string;
  workPlan?: import('@goodvibes/engine/platform/platform/knowledge').ProjectWorkPlan;
}

export interface TerminalCommandPlatformConfigServices {
  readonly config: DeepReadonly<GoodVibesConfig>;
  readonly configManager: ConfigManager;
  readonly voiceProviderRegistry?: VoiceProviderRegistry;
  readonly voiceService?: VoiceService;
}

export interface TerminalCommandExtensionRegistryServices {
  readonly toolRegistry: ToolRegistry;
  readonly mcpRegistry: McpRegistry;
}
