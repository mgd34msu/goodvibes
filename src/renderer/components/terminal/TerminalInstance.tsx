// ============================================================================
// TERMINAL INSTANCE - XTerm.js terminal component
// ============================================================================

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Terminal as XTermTerminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { SearchAddon } from '@xterm/addon-search';
import { TERMINAL_THEMES } from '../../../shared/constants';
import { useSettingsStore } from '../../stores/settingsStore';
import '@xterm/xterm/css/xterm.css';

// ============================================================================
// TYPES
// ============================================================================

import type { TerminalInstanceProps } from './types';

// ============================================================================
// COMPONENT
// ============================================================================

export function TerminalInstance({ id, zoomLevel, isActive }: TerminalInstanceProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<XTermTerminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const theme = useSettingsStore((s) => s.settings.theme);

  // Track if user has scrolled up (for showing scroll-to-bottom button)
  const [isUserScrolledUp, setIsUserScrolledUp] = useState(false);
  const isUserScrolledUpRef = useRef(false); // Ref for immediate access in callbacks
  const scrollDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

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
      cursorBlink: false,
      cursorStyle: 'bar',
      cursorWidth: 1,
      cursorInactiveStyle: 'none',
      theme: {
        ...TERMINAL_THEMES[theme],
        cursor: 'transparent',
        cursorAccent: 'transparent',
      },
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

    // Detect when user scrolls manually
    const viewportElement = containerRef.current?.querySelector('.xterm-viewport');
    const handleScroll = () => {
      const viewport = terminal.element?.querySelector('.xterm-viewport');
      if (!viewport) return;

      // Check if scrolled to bottom (with small tolerance for rounding)
      const isAtBottom = viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight < 5;

      // Update both ref (for immediate callback access) and state (for UI)
      isUserScrolledUpRef.current = !isAtBottom;
      setIsUserScrolledUp(!isAtBottom);
    };

    if (viewportElement) {
      viewportElement.addEventListener('scroll', handleScroll);
    }

    terminalRef.current = terminal;
    fitAddonRef.current = fitAddon;

    // Initial resize
    const cols = terminal.cols;
    const rows = terminal.rows;
    window.goodvibes.terminalResize(id, cols, rows);

    return () => {
      if (viewportElement) {
        viewportElement.removeEventListener('scroll', handleScroll);
      }
      if (scrollDebounceRef.current) {
        clearTimeout(scrollDebounceRef.current);
      }
      terminal.dispose();
      terminalRef.current = null;
      fitAddonRef.current = null;
    };
  }, [id, theme]);

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
        const terminal = terminalRef.current;
        terminal.write(data.data);
        // Only auto-scroll if user hasn't manually scrolled up
        // Use ref for immediate access without re-subscribing
        if (!isUserScrolledUpRef.current) {
          terminal.scrollToBottom();
        }
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
      terminalRef.current.options.theme = {
        ...TERMINAL_THEMES[theme],
        cursor: 'transparent',
        cursorAccent: 'transparent',
      };
    }
  }, [theme]);

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

  // Scroll to bottom handler for the button
  const handleScrollToBottom = useCallback(() => {
    if (terminalRef.current) {
      terminalRef.current.scrollToBottom();
      isUserScrolledUpRef.current = false;
      setIsUserScrolledUp(false);
    }
  }, []);

  return (
    <div className="relative h-full w-full p-2" onContextMenu={handleContextMenu}>
      <div ref={containerRef} className="h-full w-full" />
      {/* Scroll to bottom button - shown when user has scrolled up */}
      {isUserScrolledUp && (
        <button
          onClick={handleScrollToBottom}
          className="absolute bottom-4 right-4 p-2 bg-surface-700 hover:bg-surface-600 text-surface-200 rounded-full shadow-lg transition-all duration-200 opacity-80 hover:opacity-100 z-10"
          title="Scroll to bottom"
          aria-label="Scroll to bottom"
        >
          <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" aria-hidden="true">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 14l-7 7m0 0l-7-7m7 7V3" />
          </svg>
        </button>
      )}
    </div>
  );
}

export default TerminalInstance;
