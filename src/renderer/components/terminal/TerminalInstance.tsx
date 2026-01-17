// ============================================================================
// TERMINAL INSTANCE - XTerm.js terminal component
// ============================================================================

import React, { useCallback, useEffect, useRef, useMemo } from 'react';
import { Terminal as XTermTerminal, type ITheme } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { SearchAddon } from '@xterm/addon-search';
import { useTheme } from '../../contexts/ThemeContext';
import type { TerminalColors } from '../../../shared/types/theme-types';
import '@xterm/xterm/css/xterm.css';

// ============================================================================
// TYPES
// ============================================================================

import type { TerminalInstanceProps } from './types';

// ============================================================================
// HELPERS
// ============================================================================

/**
 * Converts TerminalColors from theme to xterm.js ITheme format.
 * The cursor is set to transparent to hide it (app uses custom cursor rendering).
 */
function terminalColorsToXtermTheme(colors: TerminalColors): ITheme {
  return {
    background: colors.background,
    foreground: colors.foreground,
    cursor: 'transparent',
    cursorAccent: 'transparent',
    selectionBackground: colors.selectionBackground,
    selectionForeground: colors.foreground,
    black: colors.black,
    red: colors.red,
    green: colors.green,
    yellow: colors.yellow,
    blue: colors.blue,
    magenta: colors.magenta,
    cyan: colors.cyan,
    white: colors.white,
    brightBlack: colors.brightBlack,
    brightRed: colors.brightRed,
    brightGreen: colors.brightGreen,
    brightYellow: colors.brightYellow,
    brightBlue: colors.brightBlue,
    brightMagenta: colors.brightMagenta,
    brightCyan: colors.brightCyan,
    brightWhite: colors.brightWhite,
  };
}

// ============================================================================
// COMPONENT
// ============================================================================

export function TerminalInstance({ id, zoomLevel, isActive }: TerminalInstanceProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<XTermTerminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const { theme } = useTheme();

  // Memoize the xterm theme to prevent unnecessary recalculations
  const xtermTheme = useMemo(
    () => terminalColorsToXtermTheme(theme.colors.terminal),
    [theme]
  );

  // Copy selected text from terminal
  const copySelection = useCallback(() => {
    const terminal = terminalRef.current;
    if (!terminal) return;

    const selection = terminal.getSelection();
    if (selection) {
      window.goodvibes.clipboardWrite(selection);
    }
  }, []);

  // Paste text into terminal
  const pasteToTerminal = useCallback(async () => {
    const terminal = terminalRef.current;
    if (!terminal) return;

    const text = await window.goodvibes.clipboardRead();
    if (text) {
      // Send the pasted text to the terminal PTY
      window.goodvibes.terminalInput(id, text);
    }
  }, [id]);

  // Handle context menu
  const handleContextMenu = useCallback(async (e: React.MouseEvent) => {
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
      pasteToTerminal();
    } else if (action === 'clear') {
      terminal.clear();
    }
    // 'copy' action is handled by the main process directly
  }, [pasteToTerminal]);

  // Initialize terminal
  useEffect(() => {
    if (!containerRef.current || terminalRef.current) return;

    const terminal = new XTermTerminal({
      fontFamily: "'CaskaydiaMonoNerdFontMono', 'JetBrains Mono', 'Fira Code', Consolas, monospace",
      fontSize: 14,
      lineHeight: 1.2,
      cursorBlink: true,
      cursorStyle: 'block',
      cursorWidth: 1,
      cursorInactiveStyle: 'bar',
      theme: xtermTheme,
      allowProposedApi: true,
      scrollOnUserInput: true,
    });

    const fitAddon = new FitAddon();
    const webLinksAddon = new WebLinksAddon();
    const searchAddon = new SearchAddon();

    terminal.loadAddon(fitAddon);
    terminal.loadAddon(webLinksAddon);
    terminal.loadAddon(searchAddon);

    terminal.open(containerRef.current);
    fitAddon.fit();

    // Handle terminal input
    terminal.onData((data) => {
      window.goodvibes.terminalInput(id, data);
    });

    // Handle terminal resize
    terminal.onResize(({ cols, rows }) => {
      window.goodvibes.terminalResize(id, cols, rows);
    });

    terminalRef.current = terminal;
    fitAddonRef.current = fitAddon;

    // Initial resize
    const cols = terminal.cols;
    const rows = terminal.rows;
    window.goodvibes.terminalResize(id, cols, rows);

    return () => {
      terminal.dispose();
      terminalRef.current = null;
      fitAddonRef.current = null;
    };
    // Note: xtermTheme is intentionally excluded from dependencies.
    // Theme changes are handled by the separate "Handle theme change" useEffect below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  // Handle keyboard shortcuts for copy/paste in terminal
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const handleKeyDown = (e: KeyboardEvent) => {
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
    return () => {
      container.removeEventListener('keydown', handleKeyDown, true);
    };
  }, [copySelection, pasteToTerminal]);

  // Handle terminal data from main process
  useEffect(() => {
    const handleData = (data: { id: number; data: string }) => {
      if (data.id === id && terminalRef.current) {
        terminalRef.current.write(data.data);
      }
    };

    const cleanup = window.goodvibes.onTerminalData(handleData);
    return cleanup;
  }, [id]);

  // Handle resize with debounce to prevent cursor jumping during rapid resizes
  useEffect(() => {
    let resizeTimeout: ReturnType<typeof setTimeout> | null = null;
    let rafId: number | null = null;

    const handleResize = () => {
      // Cancel any pending resize
      if (resizeTimeout) {
        clearTimeout(resizeTimeout);
      }
      if (rafId) {
        cancelAnimationFrame(rafId);
      }

      // Debounce resize to prevent cursor position corruption
      resizeTimeout = setTimeout(() => {
        // Use requestAnimationFrame to ensure DOM is stable
        rafId = requestAnimationFrame(() => {
          if (fitAddonRef.current && terminalRef.current) {
            fitAddonRef.current.fit();
          }
        });
      }, 100); // 100ms debounce
    };

    const resizeObserver = new ResizeObserver(handleResize);
    if (containerRef.current) {
      resizeObserver.observe(containerRef.current);
    }

    return () => {
      if (resizeTimeout) {
        clearTimeout(resizeTimeout);
      }
      if (rafId) {
        cancelAnimationFrame(rafId);
      }
      resizeObserver.disconnect();
    };
  }, []);

  // Handle zoom with debounce to prevent cursor jumping
  useEffect(() => {
    if (terminalRef.current) {
      terminalRef.current.options.fontSize = Math.round(14 * (zoomLevel / 100));
      // Debounce fit to prevent cursor position corruption during zoom
      const timeout = setTimeout(() => {
        fitAddonRef.current?.fit();
      }, 50);
      return () => clearTimeout(timeout);
    }
    return undefined;
  }, [zoomLevel]);

  // Handle theme change
  useEffect(() => {
    if (terminalRef.current) {
      terminalRef.current.options.theme = xtermTheme;
    }
  }, [xtermTheme]);

  // Focus terminal when it becomes active (with 500ms delay)
  useEffect(() => {
    if (isActive && terminalRef.current) {
      const timeout = setTimeout(() => {
        terminalRef.current?.focus();
      }, 500);
      return () => clearTimeout(timeout);
    }
    return undefined;
  }, [isActive]);

  return (
    <div className="relative h-full w-full p-2" onContextMenu={handleContextMenu}>
      <div ref={containerRef} className="h-full w-full" />
    </div>
  );
}

export default TerminalInstance;
