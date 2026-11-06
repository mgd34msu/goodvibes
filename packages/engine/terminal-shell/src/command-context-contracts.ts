import type { ModelPickerTarget } from './model-picker-types.js';
import type { PermissionRequestHandler } from '@goodvibes-jev/engine/sdk/platform/permissions';
import type { OpenSelection } from '@goodvibes-jev/engine/terminal-shell/selection-modal';
import type { ProviderRegistry } from '@goodvibes-jev/engine/sdk/platform/providers';
import type { FileUndoManager } from '@goodvibes-jev/engine/sdk/platform/state';
import type { DeepReadonly } from '@goodvibes-jev/engine/sdk/platform/config';
import type { GoodVibesConfig } from '@goodvibes-jev/engine/sdk/platform/config';
import type { ConfigManager } from '@goodvibes-jev/engine/sdk/platform/config';
import type { VoiceProviderRegistry } from '@goodvibes-jev/engine/sdk/platform/voice';
import type { VoiceService } from '@goodvibes-jev/engine/sdk/platform/voice';
import type { ToolRegistry } from '@goodvibes-jev/engine/sdk/platform/tools';
import type { McpRegistry } from '@goodvibes-jev/engine/sdk/platform/mcp';
/** Shared command capabilities; products extend these contracts with their own policy and UI actions. */
export interface TerminalCommandRuntimeState {
  model: string;
  provider: string;
  debugMode: boolean;
  systemPrompt: string;
  reasoningEffort: string;
  sessionId: string;
}

export interface TerminalCommandUiActions<Target extends ModelPickerTarget> {
  renderRequest: () => void;
  print: (text: string) => void;
  exit: () => void;
  submitSpokenInput?: (text: string, content?: import('@goodvibes-jev/engine/sdk/platform/providers').ContentPart[]) => void;
  stopSpokenOutput?: () => void;
  pasteFromClipboard?: () => {
    pasted: boolean;
    kind: 'image' | 'text' | 'none';
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
  }) => void;
  clearScreen?: () => void;
  beginConcealedInput?: (request: import('./concealed-input.js').ConcealedInputRequest) => void;
  activatePlan?: (planId: string, task: string) => void;
  requestPermission?: PermissionRequestHandler;
}

export interface TerminalCommandShellUiOpeners<Target extends ModelPickerTarget> {
  reloadSystemPrompt?: () => string;
  openModelPicker?: () => void;
  openModelPickerWithTarget?: (target: Target) => boolean;
  openProviderModelPickerWithTarget?: (target: Target) => boolean;
  openProviderPicker?: () => void;
  openContextInspector?: () => void;
  openBookmarkModal?: () => void;
  jumpToBookmark?: (key: string) => void;
  scrollToLine?: (line: number) => void;
  openHelpOverlay?: () => void;
  openSelection?: OpenSelection;
  openSettingsModal?: (target?: string) => void;
  openSessionPicker?: () => void;
  openProfilePicker?: () => void;
  openShortcutsOverlay?: () => void;
  getScrollTop?: () => number;
  openSessionView?: (target: { readonly kind: 'agent' | 'process'; readonly id: string }) => boolean;
  openNotifications?: () => void;
  focusPrompt?: () => void;
  openMcpWorkspace?: () => void;
}

export interface TerminalCommandSessionServices {
  readonly sessionManager?: import('@goodvibes-jev/engine/sdk/platform/sessions').SessionManager;
  readonly sessionMemoryStore?: import('@goodvibes-jev/engine/sdk/platform/core').SessionMemoryStore;
  readonly sessionLineageTracker?: import('@goodvibes-jev/engine/sdk/platform/core').SessionLineageTracker;
  readonly changeTracker?: import('@goodvibes-jev/engine/sdk/platform/sessions').SessionChangeTracker;
  readonly hydrateSessionUsage?: () => void;
}

export interface TerminalCommandProviderServices {
  readonly providerRegistry: ProviderRegistry;
  readonly providerOptimizer?: import('@goodvibes-jev/engine/sdk/platform/providers').ProviderOptimizer;
  readonly favoritesStore?: import('@goodvibes-jev/engine/sdk/platform/providers').FavoritesStore;
  readonly benchmarkStore?: import('@goodvibes-jev/engine/sdk/platform/providers').BenchmarkStore;
}

export interface TerminalCommandWorkspaceUiServices {
  fileUndoManager?: FileUndoManager;
  profileManager?: import('@goodvibes-jev/engine/sdk/platform/profiles').ProfileManager;
  bookmarkManager?: import('@goodvibes-jev/engine/sdk/platform/bookmarks').BookmarkManager;
  projectPlanningService?: import('@goodvibes-jev/engine/sdk/platform/knowledge').ProjectPlanningService;
  projectPlanningProjectId?: string;
  workPlanStore?: import('@goodvibes-jev/engine/sdk/platform/workflow').WorkPlanStore;
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
