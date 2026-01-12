// ============================================================================
// TERMINAL STORE - Terminal instance management
// ============================================================================
//
// Note: This store uses Map<number, TerminalInstance> for storing terminals.
// While Maps can cause reference equality issues in React/Zustand (mutations
// don't trigger re-renders), we handle this by always creating a new Map
// instance when making changes (e.g., `new Map(state.terminals)`) instead of
// mutating the existing Map. This ensures proper React re-renders.
//
// Alternative approaches considered:
// - Using Record<number, TerminalInstance>: Works but loses insertion order
// - Using immer: Adds complexity for a simple use case
// - Using array with find(): Less efficient for frequent lookups by ID
// ============================================================================

import { create } from 'zustand';
import type { TerminalInfo, TerminalStartResult } from '../../shared/types';
import { createLogger } from '../../shared/logger';

const logger = createLogger('TerminalStore');

interface TerminalInstance extends TerminalInfo {
  isLoading: boolean;
  error?: string;
  isPlainTerminal?: boolean;
}

interface TerminalState {
  // Using Map for O(1) lookups. Always create new Map instances on updates
  // to ensure React detects the change and triggers re-renders.
  terminals: Map<number, TerminalInstance>;
  activeTerminalId: number | null;
  zoomLevel: number;
  nextPreviewId: number;

  // Actions
  createTerminal: (cwd?: string, name?: string, resumeSessionId?: string) => Promise<TerminalStartResult>;
  createPlainTerminal: (cwd?: string, name?: string) => Promise<TerminalStartResult>;
  createPreviewTerminal: (sessionId: string, name: string, cwd?: string) => number;
  closeTerminal: (id: number) => Promise<void>;
  closePreviewTerminal: (id: number) => void;
  setActiveTerminal: (id: number | null) => void;
  switchToNextTab: () => void;
  switchToPrevTab: () => void;
  setZoomLevel: (level: number) => void;
  updateTerminal: (id: number, updates: Partial<TerminalInstance>) => void;

  // Getters
  getTerminal: (id: number) => TerminalInstance | undefined;
  getActiveTerminal: () => TerminalInstance | undefined;
  getTerminalList: () => TerminalInstance[];
}

export const useTerminalStore = create<TerminalState>((set, get) => ({
  terminals: new Map(),
  activeTerminalId: null,
  zoomLevel: 100,
  nextPreviewId: -1, // Preview IDs are negative to avoid conflicts

  createTerminal: async (cwd, name, resumeSessionId) => {
    try {
      const result = await window.goodvibes.startClaude({
        cwd,
        name,
        resumeSessionId,
      });

      if (result.error) {
        return result;
      }

      if (result.id !== undefined) {
        const terminalId = result.id;
        const terminal: TerminalInstance = {
          id: terminalId,
          name: result.name || 'Terminal',
          cwd: result.cwd || cwd || '',
          startTime: new Date(),
          resumeSessionId: result.resumeSessionId,
          sessionType: result.sessionType as 'user' | 'subagent' | undefined,
          isLoading: false,
        };

        set((state) => {
          const newMap = new Map(state.terminals);
          newMap.set(terminalId, terminal);
          return { terminals: newMap, activeTerminalId: result.id };
        });
      }

      return result;
    } catch (error) {
      return { error: error instanceof Error ? error.message : 'Unknown error' };
    }
  },

  createPlainTerminal: async (cwd, name) => {
    try {
      const result = await window.goodvibes.startPlainTerminal({
        cwd,
        name,
      });

      if (result.error) {
        return result;
      }

      if (result.id !== undefined) {
        const terminalId = result.id;
        const terminal: TerminalInstance = {
          id: terminalId,
          name: result.name || 'Terminal',
          cwd: result.cwd || cwd || '',
          startTime: new Date(),
          isLoading: false,
          isPlainTerminal: true,
        };

        set((state) => {
          const newMap = new Map(state.terminals);
          newMap.set(terminalId, terminal);
          return { terminals: newMap, activeTerminalId: result.id };
        });
      }

      return result;
    } catch (error) {
      return { error: error instanceof Error ? error.message : 'Unknown error' };
    }
  },

  createPreviewTerminal: (sessionId, name, cwd) => {
    const state = get();
    const previewId = state.nextPreviewId;
    
    const terminal: TerminalInstance = {
      id: previewId,
      name: `Preview: ${name}`,
      cwd: cwd || '',
      startTime: new Date(),
      isPreview: true,
      previewSessionId: sessionId,
      isLoading: false,
    };

    set((state) => {
      const newMap = new Map(state.terminals);
      newMap.set(previewId, terminal);
      return { 
        terminals: newMap, 
        activeTerminalId: previewId,
        nextPreviewId: state.nextPreviewId - 1,
      };
    });

    return previewId;
  },

  closeTerminal: async (id) => {
    const terminal = get().terminals.get(id);
    
    // For preview terminals, just remove from state
    if (terminal?.isPreview) {
      get().closePreviewTerminal(id);
      return;
    }

    try {
      await window.goodvibes.killTerminal(id);
    } catch (error) {
      logger.error('Failed to kill terminal:', error);
    }

    set((state) => {
      const newMap = new Map(state.terminals);
      newMap.delete(id);

      // Select next terminal if active was closed
      let newActiveId: number | null = state.activeTerminalId;
      if (state.activeTerminalId === id) {
        const ids = Array.from(newMap.keys());
        newActiveId = ids.length > 0 ? ids[ids.length - 1] ?? null : null;
      }

      return { terminals: newMap, activeTerminalId: newActiveId };
    });
  },

  closePreviewTerminal: (id) => {
    set((state) => {
      const newMap = new Map(state.terminals);
      newMap.delete(id);

      // Select next terminal if active was closed
      let newActiveId: number | null = state.activeTerminalId;
      if (state.activeTerminalId === id) {
        const ids = Array.from(newMap.keys());
        newActiveId = ids.length > 0 ? ids[ids.length - 1] ?? null : null;
      }

      return { terminals: newMap, activeTerminalId: newActiveId };
    });
  },

  setActiveTerminal: (id) => set({ activeTerminalId: id }),

  switchToNextTab: () => {
    const { terminals, activeTerminalId } = get();
    const ids = Array.from(terminals.keys());
    if (ids.length === 0) return;

    const currentIndex = activeTerminalId ? ids.indexOf(activeTerminalId) : -1;
    const nextIndex = (currentIndex + 1) % ids.length;
    set({ activeTerminalId: ids[nextIndex] });
  },

  switchToPrevTab: () => {
    const { terminals, activeTerminalId } = get();
    const ids = Array.from(terminals.keys());
    if (ids.length === 0) return;

    const currentIndex = activeTerminalId ? ids.indexOf(activeTerminalId) : 0;
    const prevIndex = (currentIndex - 1 + ids.length) % ids.length;
    set({ activeTerminalId: ids[prevIndex] });
  },

  setZoomLevel: (level) => set({ zoomLevel: Math.max(50, Math.min(200, level)) }),

  updateTerminal: (id, updates) => {
    set((state) => {
      const terminal = state.terminals.get(id);
      if (!terminal) return state;

      const newMap = new Map(state.terminals);
      newMap.set(id, { ...terminal, ...updates });
      return { terminals: newMap };
    });
  },

  getTerminal: (id) => get().terminals.get(id),

  getActiveTerminal: () => {
    const { terminals, activeTerminalId } = get();
    return activeTerminalId ? terminals.get(activeTerminalId) : undefined;
  },

  getTerminalList: () => Array.from(get().terminals.values()),
}));
