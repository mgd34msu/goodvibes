import type { InputToken } from '@goodvibes-jev/engine/platform/platform/core';
import { withModalState as withState, type ModalTokenSnapshot } from './modal-input-routes.js';
export type ModalTokenResult = ReturnType<typeof withState>;
export type CommonModalRoutingState = ModalTokenSnapshot &
  Readonly<
    Partial<
      Record<
        | 'searchManager'
        | 'scroll'
        | 'getScrollTop'
        | 'getViewportHeight'
        | 'conversationManager'
        | 'history'
        | 'searchShortcutMatch'
        | 'selectionModal'
        | 'getSelectionCallback'
        | 'setSelectionCallback'
        | 'modalStack'
        | 'bookmarkModal'
        | 'commandContext'
        | 'settingsModal'
        | 'openModelPickerWithTarget'
        | 'openProviderModelPickerWithTarget'
        | 'mcpWorkspace'
        | 'sessionPickerModal'
        | 'profilePickerModal'
        | 'overlayFilters'
        | 'historySearch'
        | 'modelPicker'
        | 'onModelPickerCommit'
        | 'filePicker'
        | 'imageRegistry'
        | 'saveUndoState'
        | 'ensureInputCursorVisible'
        | 'formatFileSize'
        | 'mediaTypeFromExt'
        | 'imageExtensions'
        | 'blockActionsMenu'
        | 'executeBlockAction',
        unknown
      >
    >
  > & {
    readonly requestRender: () => void;
    readonly handleEscape: () => void;
    readonly contextInspectorModal: {
      readonly active: boolean;
      scrollBy(delta: number): void;
    };
  };
export function createModalTokenPipeline<State extends CommonModalRoutingState>(
  bindings: {
    handleSearchModeToken: (
      value: {
        searchManager: State['searchManager'];
        requestRender: State['requestRender'];
        scroll: State['scroll'];
        getScrollTop: State['getScrollTop'];
        getViewportHeight: State['getViewportHeight'];
        conversationManager: State['conversationManager'];
      },
      arg1: InputToken,
      arg2: State['history'],
      arg3: State['searchShortcutMatch'],
    ) => boolean;
    handleSelectionModalToken: (
      value: {
        selectionModal: State['selectionModal'];
        selectionCallback: State['selectionCallback'];
        getSelectionCallback: State['getSelectionCallback'];
        setSelectionCallback: State['setSelectionCallback'];
        modalStack: State['modalStack'];
        requestRender: State['requestRender'];
        handleEscape: State['handleEscape'];
      },
      arg1: InputToken,
    ) => boolean;
    handleBookmarkModalToken: (
      value: {
        bookmarkModal: State['bookmarkModal'];
        commandContext: State['commandContext'];
        requestRender: State['requestRender'];
        handleEscape: State['handleEscape'];
      },
      arg1: InputToken,
    ) => boolean;
    handleSettingsModalToken: (
      value: {
        settingsModal: State['settingsModal'];
        commandContext: State['commandContext'];
        openModelPickerWithTarget: State['openModelPickerWithTarget'];
        openProviderModelPickerWithTarget: State['openProviderModelPickerWithTarget'];
        requestRender: State['requestRender'];
        handleEscape: State['handleEscape'];
      },
      arg1: InputToken,
    ) => boolean;
    handleMcpWorkspaceToken: (
      arg0: State['mcpWorkspace'],
      arg1: InputToken,
      arg2: State['handleEscape'],
      arg3: State['requestRender'],
    ) => boolean;
    handleSessionPickerToken: (
      value: {
        sessionPickerModal: State['sessionPickerModal'];
        commandContext: State['commandContext'];
        requestRender: State['requestRender'];
        handleEscape: State['handleEscape'];
      },
      arg1: InputToken,
    ) => boolean;
    handleProfilePickerToken: (
      value: {
        profilePickerModal: State['profilePickerModal'];
        commandContext: State['commandContext'];
        requestRender: State['requestRender'];
        handleEscape: State['handleEscape'];
      },
      arg1: InputToken,
    ) => boolean;
    handleOverlayToken: (
      value: {
        helpOverlayActive: State['helpOverlayActive'];
        helpScrollOffset: State['helpScrollOffset'];
        shortcutsOverlayActive: State['shortcutsOverlayActive'];
        shortcutsScrollOffset: State['shortcutsScrollOffset'];
        overlayFilters: State['overlayFilters'];
        requestRender: State['requestRender'];
        handleEscape: State['handleEscape'];
      },
      arg1: InputToken,
    ) => boolean;
    handleHistorySearchToken: (
      value: {
        historySearch: State['historySearch'];
        prompt: State['prompt'];
        cursorPos: State['cursorPos'];
        requestRender: State['requestRender'];
      },
      arg1: InputToken,
    ) => boolean;
    handleModelPickerToken: (
      value: {
        modelPicker: State['modelPicker'];
        modalStack: State['modalStack'];
        commandContext: State['commandContext'];
        getViewportHeight: State['getViewportHeight'];
        requestRender: State['requestRender'];
        handleEscape: State['handleEscape'];
        onModelPickerCommit: State['onModelPickerCommit'];
      },
      arg1: InputToken,
    ) => boolean;
    handleEscapeOnlyModalToken: (
      value: {
        active: State['contextInspectorModal']['active'];
        requestRender: State['requestRender'];
        handleEscape: State['handleEscape'];
        scroll: (delta: number) => void;
      },
      arg1: InputToken,
    ) => boolean;
    handleFilePickerToken: (
      value: {
        filePicker: State['filePicker'];
        prompt: State['prompt'];
        cursorPos: State['cursorPos'];
        imageRegistry: State['imageRegistry'];
        nextImageId: State['nextImageId'];
        requestRender: State['requestRender'];
        handleEscape: State['handleEscape'];
        saveUndoState: State['saveUndoState'];
        ensureInputCursorVisible: State['ensureInputCursorVisible'];
        formatFileSize: State['formatFileSize'];
        mediaTypeFromExt: State['mediaTypeFromExt'];
        imageExtensions: State['imageExtensions'];
      },
      arg1: InputToken,
    ) => boolean;
    handleBlockActionsToken: (
      value: {
        blockActionsMenu: State['blockActionsMenu'];
        executeBlockAction: State['executeBlockAction'];
        requestRender: State['requestRender'];
        handleEscape: State['handleEscape'];
      },
      arg1: InputToken,
    ) => boolean;
  },
  options: {
    readonly order: readonly (
      | 'handleSearchModeToken'
      | 'handleSelectionModalToken'
      | 'handleBookmarkModalToken'
      | 'handleSettingsModalToken'
      | 'handleMcpWorkspaceToken'
      | 'handleSessionPickerToken'
      | 'handleProfilePickerToken'
      | 'handleOverlayToken'
      | 'handleHistorySearchToken'
      | 'handleModelPickerToken'
      | 'handleEscapeOnlyModalToken'
      | 'handleFilePickerToken'
      | 'handleBlockActionsToken'
      | 'config'
      | 'onboarding'
      | 'agent-workspace'
      | 'live-tail'
      | 'process'
    )[];
    readonly additional?:
      | Readonly<
          Partial<
            Record<'config' | 'onboarding' | 'agent-workspace' | 'live-tail' | 'process', (state: State, token: InputToken) => boolean>
          >
        >
      | undefined;
  },
) {
  function handleSearchModeToken(state: State, token: InputToken): ModalTokenResult | undefined {
    if (
      bindings.handleSearchModeToken(
        {
          searchManager: state.searchManager,
          requestRender: state.requestRender,
          scroll: state.scroll,
          getScrollTop: state.getScrollTop,
          getViewportHeight: state.getViewportHeight,
          conversationManager: state.conversationManager,
        },
        token,
        state.history,
        state.searchShortcutMatch,
      )
    ) {
      return withState(state, true);
    }
  }
  function handleSelectionModalToken(state: State, token: InputToken): ModalTokenResult | undefined {
    const selectionState = {
      selectionModal: state.selectionModal,
      selectionCallback: state.selectionCallback,
      getSelectionCallback: state.getSelectionCallback,
      setSelectionCallback: state.setSelectionCallback,
      modalStack: state.modalStack,
      requestRender: state.requestRender,
      handleEscape: state.handleEscape,
    };
    if (bindings.handleSelectionModalToken(selectionState, token)) {
      return withState(state, true, {
        selectionCallback: selectionState.getSelectionCallback
          ? selectionState.getSelectionCallback() : selectionState.selectionCallback,
      });
    }
  }
  function handleBookmarkModalToken(state: State, token: InputToken): ModalTokenResult | undefined {
    if (
      bindings.handleBookmarkModalToken(
        {
          bookmarkModal: state.bookmarkModal,
          commandContext: state.commandContext,
          requestRender: state.requestRender,
          handleEscape: state.handleEscape,
        },
        token,
      )
    ) {
      return withState(state, true);
    }
  }
  function handleSettingsModalToken(state: State, token: InputToken): ModalTokenResult | undefined {
    if (
      bindings.handleSettingsModalToken(
        {
          settingsModal: state.settingsModal,
          commandContext: state.commandContext,
          openModelPickerWithTarget: state.openModelPickerWithTarget,
          openProviderModelPickerWithTarget: state.openProviderModelPickerWithTarget,
          requestRender: state.requestRender,
          handleEscape: state.handleEscape,
        },
        token,
      )
    ) {
      return withState(state, true);
    }
  }
  function handleMcpWorkspaceToken(state: State, token: InputToken): ModalTokenResult | undefined {
    if (bindings.handleMcpWorkspaceToken(state.mcpWorkspace, token, state.handleEscape, state.requestRender)) {
      return withState(state, true);
    }
  }
  function handleSessionPickerToken(state: State, token: InputToken): ModalTokenResult | undefined {
    if (
      bindings.handleSessionPickerToken(
        {
          sessionPickerModal: state.sessionPickerModal,
          commandContext: state.commandContext,
          requestRender: state.requestRender,
          handleEscape: state.handleEscape,
        },
        token,
      )
    ) {
      return withState(state, true);
    }
  }
  function handleProfilePickerToken(state: State, token: InputToken): ModalTokenResult | undefined {
    if (
      bindings.handleProfilePickerToken(
        {
          profilePickerModal: state.profilePickerModal,
          commandContext: state.commandContext,
          requestRender: state.requestRender,
          handleEscape: state.handleEscape,
        },
        token,
      )
    ) {
      return withState(state, true);
    }
  }
  function handleOverlayToken(state: State, token: InputToken): ModalTokenResult | undefined {
    const overlayState = {
      helpOverlayActive: state.helpOverlayActive,
      helpScrollOffset: state.helpScrollOffset,
      shortcutsOverlayActive: state.shortcutsOverlayActive,
      shortcutsScrollOffset: state.shortcutsScrollOffset,
      overlayFilters: state.overlayFilters,
      requestRender: state.requestRender,
      handleEscape: state.handleEscape,
    };
    if (bindings.handleOverlayToken(overlayState, token)) {
      return withState(state, true, overlayState);
    }
  }
  function handleHistorySearchToken(state: State, token: InputToken): ModalTokenResult | undefined {
    const historyState = {
      historySearch: state.historySearch,
      prompt: state.prompt,
      cursorPos: state.cursorPos,
      requestRender: state.requestRender,
    };
    if (bindings.handleHistorySearchToken(historyState, token)) {
      return withState(state, true, historyState);
    }
  }
  function handleModelPickerToken(state: State, token: InputToken): ModalTokenResult | undefined {
    if (
      bindings.handleModelPickerToken(
        {
          modelPicker: state.modelPicker,
          modalStack: state.modalStack,
          commandContext: state.commandContext,
          getViewportHeight: state.getViewportHeight,
          requestRender: state.requestRender,
          handleEscape: state.handleEscape,
          onModelPickerCommit: state.onModelPickerCommit,
        },
        token,
      )
    ) {
      return withState(state, true);
    }
  }
  function handleEscapeOnlyModalToken(state: State, token: InputToken): ModalTokenResult | undefined {
    if (
      bindings.handleEscapeOnlyModalToken(
        {
          active: state.contextInspectorModal.active,
          requestRender: state.requestRender,
          handleEscape: state.handleEscape,
          scroll: (delta) => state.contextInspectorModal.scrollBy(delta),
        },
        token,
      )
    ) {
      return withState(state, true);
    }
  }
  function handleFilePickerToken(state: State, token: InputToken): ModalTokenResult | undefined {
    const filePickerState = {
      filePicker: state.filePicker,
      prompt: state.prompt,
      cursorPos: state.cursorPos,
      imageRegistry: state.imageRegistry,
      nextImageId: state.nextImageId,
      requestRender: state.requestRender,
      handleEscape: state.handleEscape,
      saveUndoState: state.saveUndoState,
      ensureInputCursorVisible: state.ensureInputCursorVisible,
      formatFileSize: state.formatFileSize,
      mediaTypeFromExt: state.mediaTypeFromExt,
      imageExtensions: state.imageExtensions,
    };
    if (bindings.handleFilePickerToken(filePickerState, token)) {
      return withState(state, true, {
        prompt: filePickerState.prompt,
        cursorPos: filePickerState.cursorPos,
        nextImageId: filePickerState.nextImageId,
      });
    }
  }
  function handleBlockActionsToken(state: State, token: InputToken): ModalTokenResult | undefined {
    if (
      bindings.handleBlockActionsToken(
        {
          blockActionsMenu: state.blockActionsMenu,
          executeBlockAction: state.executeBlockAction,
          requestRender: state.requestRender,
          handleEscape: state.handleEscape,
        },
        token,
      )
    ) {
      return withState(state, true);
    }
  }
  const routes = {
    handleSearchModeToken,
    handleSelectionModalToken,
    handleBookmarkModalToken,
    handleSettingsModalToken,
    handleMcpWorkspaceToken,
    handleSessionPickerToken,
    handleProfilePickerToken,
    handleOverlayToken,
    handleHistorySearchToken,
    handleModelPickerToken,
    handleEscapeOnlyModalToken,
    handleFilePickerToken,
    handleBlockActionsToken,
  };
  return function handleModalTokenRoutes(state: State, token: InputToken): ModalTokenResult {
    for (const name of options.order) {
      if (name in routes) {
        const result = routes[name as keyof typeof routes](state, token);
        if (result) return result;
      } else {
        const extra = options.additional?.[name as keyof NonNullable<typeof options.additional>];
        if (extra?.(state, token)) return withState(state, true);
      }
    }
    return withState(state, false);
  };
}
