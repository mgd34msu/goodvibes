// ============================================================================
// USE TERMINAL HOOK - Terminal lifecycle and cleanup management
// ============================================================================
//
// This hook manages the lifecycle of a terminal instance, including:
// - IPC data subscription and cleanup
// - Window focus/visibility event handling
// - Keyboard shortcuts for copy/paste
// - Context menu handling
// - All cleanup functions are properly registered and executed on unmount
//
// ============================================================================

import { useCallback, useEffect, useRef } from 'react';
import type { Terminal as XTermTerminal } from '@xterm/xterm';
import { createLogger } from '../../shared/logger';
import { toast } from '../stores/toastStore';

const logger = createLogger('useTerminal');

// Debounce tracking for terminal error toasts to prevent spam
let lastInputErrorToastTime = 0;
let lastResizeErrorToastTime = 0;
const ERROR_TOAST_DEBOUNCE_MS = 5000; // Only show error toast once per 5 seconds

/**
 * Input for terminal input handling with error handling and debounced toast notifications.
 */
async function sendTerminalInput(id: number, data: string): Promise<void> {
  try {
    await window.goodvibes.terminalInput(id, data);
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    logger.error('Failed to send terminal input', { id, error: errorMessage });

    const now = Date.now();
    if (now - lastInputErrorToastTime > ERROR_TOAST_DEBOUNCE_MS) {
      lastInputErrorToastTime = now;
      toast.error('Failed to send input to terminal', {
        title: 'Terminal Error',
      });
    }
  }
}

/**
 * Handles terminal resize with error handling and debounced toast notifications.
 */
async function sendTerminalResize(id: number, cols: number, rows: number): Promise<void> {
  try {
    await window.goodvibes.terminalResize(id, cols, rows);
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    logger.error('Failed to resize terminal', { id, cols, rows, error: errorMessage });

    const now = Date.now();
    if (now - lastResizeErrorToastTime > ERROR_TOAST_DEBOUNCE_MS) {
      lastResizeErrorToastTime = now;
      toast.error('Failed to resize terminal', {
        title: 'Terminal Error',
      });
    }
  }
}

// ============================================================================
// TYPES
// ============================================================================

export interface UseTerminalOptions {
  /** Terminal instance ID */
  id: number;
  /** Whether this terminal is currently active/visible */
  isActive: boolean;
}

export interface UseTerminalReturn {
  /** Send input data to the terminal */
  sendInput: (data: string) => Promise<void>;
  /** Send resize event to the terminal */
  sendResize: (cols: number, rows: number) => Promise<void>;
  /** Copy selected text from terminal */
  copySelection: () => void;
  /** Paste text into terminal */
  pasteToTerminal: () => Promise<void>;
  /** Handle context menu */
  handleContextMenu: (e: React.MouseEvent) => Promise<void>;
}

// ============================================================================
// HOOK
// ============================================================================

/**
 * Hook for managing terminal lifecycle, IPC subscriptions, and cleanup.
 *
 * This hook handles:
 * - IPC terminal data subscription with proper cleanup
 * - Window focus/visibility event listeners with cleanup
 * - Keyboard shortcut handlers for copy/paste with cleanup
 * - Context menu handling
 *
 * All subscriptions and event listeners are properly cleaned up on unmount
 * or when dependencies change.
 */
export function useTerminal(
  terminalRef: React.RefObject<XTermTerminal | null>,
  containerRef: React.RefObject<HTMLDivElement | null>,
  options: UseTerminalOptions
): UseTerminalReturn {
  const { id, isActive } = options;

  // Track cleanup functions for IPC listeners
  const ipcCleanupRef = useRef<(() => void) | null>(null);

  // ============================================================================
  // TERMINAL INPUT/OUTPUT HANDLERS
  // ============================================================================

  const sendInput = useCallback(
    async (data: string): Promise<void> => {
      await sendTerminalInput(id, data);
    },
    [id]
  );

  const sendResize = useCallback(
    async (cols: number, rows: number): Promise<void> => {
      await sendTerminalResize(id, cols, rows);
    },
    [id]
  );

  // ============================================================================
  // CLIPBOARD OPERATIONS
  // ============================================================================

  const copySelection = useCallback((): void => {
    const terminal = terminalRef.current;
    if (!terminal) return;

    const selection = terminal.getSelection();
    if (selection) {
      window.goodvibes.clipboardWrite(selection);
    }
  }, [terminalRef]);

  const pasteToTerminal = useCallback(async (): Promise<void> => {
    const terminal = terminalRef.current;
    if (!terminal) return;

    const text = await window.goodvibes.clipboardRead();
    if (text) {
      await sendTerminalInput(id, text);
    }
  }, [id, terminalRef]);

  // ============================================================================
  // CONTEXT MENU
  // ============================================================================

  const handleContextMenu = useCallback(
    async (e: React.MouseEvent): Promise<void> => {
      e.preventDefault();
      const terminal = terminalRef.current;
      if (!terminal) return;

      const hasSelection = terminal.hasSelection();
      const selectedText = hasSelection ? terminal.getSelection() : undefined;

      const action = await window.goodvibes.showTerminalContextMenu({
        hasSelection,
        selectedText,
      });

      if (action === 'paste') {
        await pasteToTerminal();
      } else if (action === 'clear') {
        terminal.clear();
      }
      // 'copy' action is handled by the main process directly
    },
    [pasteToTerminal, terminalRef]
  );

  // ============================================================================
  // IPC DATA SUBSCRIPTION
  // ============================================================================

  useEffect(() => {
    const handleData = (data: { id: number; data: string }): void => {
      if (data.id === id && terminalRef.current) {
        terminalRef.current.write(data.data);
      }
    };

    // Subscribe to terminal data
    const cleanup = window.goodvibes.onTerminalData(handleData);
    ipcCleanupRef.current = cleanup;

    // Cleanup on unmount or when id changes
    return () => {
      if (ipcCleanupRef.current) {
        ipcCleanupRef.current();
        ipcCleanupRef.current = null;
      }
    };
  }, [id, terminalRef]);

  // ============================================================================
  // KEYBOARD SHORTCUTS (COPY/PASTE)
  // ============================================================================

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const handleKeyDown = (e: KeyboardEvent): void => {
      // Check for Ctrl+C (copy) when there's a selection
      if ((e.ctrlKey || e.metaKey) && e.key === 'c') {
        const terminal = terminalRef.current;
        if (terminal?.hasSelection()) {
          e.preventDefault();
          e.stopPropagation();
          copySelection();
          return;
        }
        // If no selection, let Ctrl+C pass through as SIGINT
      }

      // Check for Ctrl+V (paste)
      if ((e.ctrlKey || e.metaKey) && e.key === 'v') {
        e.preventDefault();
        e.stopPropagation();
        pasteToTerminal();
        return;
      }

      // Check for Ctrl+Shift+C (copy - alternative)
      if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key === 'C') {
        e.preventDefault();
        e.stopPropagation();
        copySelection();
        return;
      }

      // Check for Ctrl+Shift+V (paste - alternative)
      if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key === 'V') {
        e.preventDefault();
        e.stopPropagation();
        pasteToTerminal();
        return;
      }
    };

    container.addEventListener('keydown', handleKeyDown, true);

    // Cleanup event listener on unmount
    return () => {
      container.removeEventListener('keydown', handleKeyDown, true);
    };
  }, [containerRef, copySelection, pasteToTerminal, terminalRef]);

  // ============================================================================
  // WINDOW FOCUS/VISIBILITY HANDLERS
  // ============================================================================

  useEffect(() => {
    if (!isActive) return;

    // Track timeout for cleanup
    let focusTimeoutId: ReturnType<typeof setTimeout> | null = null;

    // Focus terminal with debounce to prevent rapid focus calls
    const focusTerminalDebounced = (): void => {
      // Clear any pending timeout
      if (focusTimeoutId) {
        clearTimeout(focusTimeoutId);
      }
      focusTimeoutId = setTimeout(() => {
        if (isActive && terminalRef.current) {
          terminalRef.current.focus();
        }
        focusTimeoutId = null;
      }, 50);
    };

    const handleVisibilityChange = (): void => {
      if (document.visibilityState === 'visible') {
        focusTerminalDebounced();
      }
    };

    window.addEventListener('focus', focusTerminalDebounced);
    document.addEventListener('visibilitychange', handleVisibilityChange);

    // Cleanup all event listeners and timeouts on unmount
    return () => {
      window.removeEventListener('focus', focusTerminalDebounced);
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      if (focusTimeoutId) {
        clearTimeout(focusTimeoutId);
      }
    };
  }, [isActive, terminalRef]);

  return {
    sendInput,
    sendResize,
    copySelection,
    pasteToTerminal,
    handleContextMenu,
  };
}

export default useTerminal;
