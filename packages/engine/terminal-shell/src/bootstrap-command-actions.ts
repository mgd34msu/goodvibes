import type { PermissionRequestHandler } from '@goodvibes-jev/engine/sdk/platform/permissions';
import type { createModelSelectionAction } from './model-selection-action.js';
import { activeTokens } from './renderer/theme.js';
/** Initial command actions before the product shell attaches live routes. */
export function createBootstrapActionBase(
  options: {
    readonly requestRender: () => void;
    readonly conversation: { log(message: string, style: { readonly fg: string }): unknown };
    readonly activatePlan: (planId: string, task: string) => void;
    readonly requestPermission: PermissionRequestHandler;
    readonly loadSystemPrompt: () => string;
  },
  policy: {
    readonly unwiredMessage: (name: string) => string;
    readonly completeModelSelection: ReturnType<typeof createModelSelectionAction>;
  },
) {
  const unwired = (name: string): never => {
    throw new Error(policy.unwiredMessage(name));
  };
  return {
    renderRequest: options.requestRender,
    submitInput: () => unwired('submitInput'),
    executeCommand: async () => unwired('executeCommand'),
    cancelGeneration: () => unwired('cancelGeneration'),
    clearScreen: () => unwired('clearScreen'),
    activatePlan: options.activatePlan,
    requestPermission: ((request) => options.requestPermission(request)) as PermissionRequestHandler,
    completeModelSelection: policy.completeModelSelection,
    jumpToBookmark: () => unwired('jumpToBookmark'),
    scrollToLine: () => unwired('scrollToLine'),
    print: (text: string) => {
      options.conversation.log(text, { fg: activeTokens().text });
      options.requestRender();
    },
    exit: () => unwired('exit'),
    reloadSystemPrompt: options.loadSystemPrompt,
    openMcpWorkspace: () => unwired('openMcpWorkspace'),
  };
}
