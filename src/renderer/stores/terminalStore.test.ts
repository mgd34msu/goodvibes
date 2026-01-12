// ============================================================================
// TERMINAL STORE TESTS
// ============================================================================

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { useTerminalStore } from './terminalStore';

// Helper function to add a terminal directly to the store (bypasses IPC)
function addTerminalToStore(id: number, name: string, cwd: string) {
  useTerminalStore.setState((state) => {
    const newMap = new Map(state.terminals);
    newMap.set(id, {
      id,
      name,
      cwd,
      startTime: new Date(),
      isLoading: false,
    });
    return { terminals: newMap, activeTerminalId: id };
  });
}

describe('useTerminalStore', () => {
  beforeEach(() => {
    // Reset store state using the actual store structure
    useTerminalStore.setState({
      terminals: new Map(),
      activeTerminalId: null,
      zoomLevel: 100,
      nextPreviewId: -1,
    });
    vi.clearAllMocks();
  });

  describe('terminal management', () => {
    it('stores terminal metadata', () => {
      addTerminalToStore(1, 'My Terminal', '/home/user/project');

      const { getTerminal } = useTerminalStore.getState();
      const terminal = getTerminal(1);
      expect(terminal?.name).toBe('My Terminal');
      expect(terminal?.cwd).toBe('/home/user/project');
      expect(terminal?.id).toBe(1);
    });

    it('sets active terminal when adding', () => {
      addTerminalToStore(1, 'Terminal 1', '/home/user');
      expect(useTerminalStore.getState().activeTerminalId).toBe(1);

      addTerminalToStore(2, 'Terminal 2', '/home/user');
      expect(useTerminalStore.getState().activeTerminalId).toBe(2);
    });
  });

  describe('closeTerminal', () => {
    it('removes a terminal from state', async () => {
      addTerminalToStore(1, 'Test', '/');
      addTerminalToStore(2, 'Test 2', '/');

      const { closeTerminal } = useTerminalStore.getState();
      await closeTerminal(1);

      expect(useTerminalStore.getState().terminals.size).toBe(1);
      expect(useTerminalStore.getState().terminals.has(1)).toBe(false);
    });

    it('updates active terminal when removing active', async () => {
      addTerminalToStore(1, 'Test 1', '/');
      addTerminalToStore(2, 'Test 2', '/');
      useTerminalStore.getState().setActiveTerminal(1);

      const { closeTerminal } = useTerminalStore.getState();
      await closeTerminal(1);

      // Should switch to remaining terminal
      expect(useTerminalStore.getState().activeTerminalId).toBe(2);
    });

    it('sets active to null when removing last terminal', async () => {
      addTerminalToStore(1, 'Test', '/');

      const { closeTerminal } = useTerminalStore.getState();
      await closeTerminal(1);

      expect(useTerminalStore.getState().activeTerminalId).toBeNull();
    });
  });

  describe('setActiveTerminal', () => {
    it('sets the active terminal', () => {
      addTerminalToStore(1, 'Test 1', '/');
      addTerminalToStore(2, 'Test 2', '/');

      const { setActiveTerminal } = useTerminalStore.getState();

      setActiveTerminal(1);
      expect(useTerminalStore.getState().activeTerminalId).toBe(1);

      setActiveTerminal(2);
      expect(useTerminalStore.getState().activeTerminalId).toBe(2);
    });
  });

  describe('updateTerminal', () => {
    it('updates terminal metadata', () => {
      addTerminalToStore(1, 'Original', '/home');

      const { updateTerminal, getTerminal } = useTerminalStore.getState();
      updateTerminal(1, { name: 'Updated', cwd: '/new/path' });

      const terminal = getTerminal(1);
      expect(terminal?.name).toBe('Updated');
      expect(terminal?.cwd).toBe('/new/path');
    });

    it('preserves unchanged fields', () => {
      addTerminalToStore(1, 'Original', '/home');

      const { updateTerminal, getTerminal } = useTerminalStore.getState();
      updateTerminal(1, { name: 'Updated' });

      const terminal = getTerminal(1);
      expect(terminal?.name).toBe('Updated');
      expect(terminal?.cwd).toBe('/home');
    });
  });

  describe('getTerminalList', () => {
    it('returns array of terminals', () => {
      addTerminalToStore(1, 'Terminal 1', '/');
      addTerminalToStore(2, 'Terminal 2', '/');
      addTerminalToStore(3, 'Terminal 3', '/');

      const { getTerminalList } = useTerminalStore.getState();
      const list = getTerminalList();
      expect(list).toHaveLength(3);
      expect(list.map((t) => t.id).sort()).toEqual([1, 2, 3]);
    });

    it('returns empty array when no terminals', () => {
      const { getTerminalList } = useTerminalStore.getState();
      expect(getTerminalList()).toEqual([]);
    });
  });

  describe('getActiveTerminal', () => {
    it('returns the active terminal', () => {
      addTerminalToStore(1, 'Terminal 1', '/path1');
      addTerminalToStore(2, 'Terminal 2', '/path2');
      useTerminalStore.getState().setActiveTerminal(2);

      const { getActiveTerminal } = useTerminalStore.getState();
      const active = getActiveTerminal();
      expect(active?.id).toBe(2);
      expect(active?.name).toBe('Terminal 2');
    });

    it('returns undefined when no active terminal', () => {
      const { getActiveTerminal } = useTerminalStore.getState();
      expect(getActiveTerminal()).toBeUndefined();
    });
  });

  describe('switchToNextTab / switchToPrevTab', () => {
    it('cycles through terminals forward', () => {
      addTerminalToStore(1, 'T1', '/');
      addTerminalToStore(2, 'T2', '/');
      addTerminalToStore(3, 'T3', '/');
      useTerminalStore.getState().setActiveTerminal(1);

      const { switchToNextTab } = useTerminalStore.getState();

      switchToNextTab();
      expect(useTerminalStore.getState().activeTerminalId).toBe(2);

      switchToNextTab();
      expect(useTerminalStore.getState().activeTerminalId).toBe(3);

      switchToNextTab(); // Should wrap around
      expect(useTerminalStore.getState().activeTerminalId).toBe(1);
    });

    it('cycles through terminals backward', () => {
      addTerminalToStore(1, 'T1', '/');
      addTerminalToStore(2, 'T2', '/');
      addTerminalToStore(3, 'T3', '/');
      useTerminalStore.getState().setActiveTerminal(1);

      const { switchToPrevTab } = useTerminalStore.getState();

      switchToPrevTab(); // Should wrap to end
      expect(useTerminalStore.getState().activeTerminalId).toBe(3);

      switchToPrevTab();
      expect(useTerminalStore.getState().activeTerminalId).toBe(2);
    });
  });

  describe('zoom functionality', () => {
    it('sets zoom level within bounds', () => {
      const { setZoomLevel } = useTerminalStore.getState();

      setZoomLevel(150);
      expect(useTerminalStore.getState().zoomLevel).toBe(150);

      // Test min bound
      setZoomLevel(10);
      expect(useTerminalStore.getState().zoomLevel).toBe(50);

      // Test max bound
      setZoomLevel(300);
      expect(useTerminalStore.getState().zoomLevel).toBe(200);
    });
  });

  describe('preview terminals', () => {
    it('creates preview terminal with negative ID', () => {
      const { createPreviewTerminal, getTerminal } = useTerminalStore.getState();

      const id = createPreviewTerminal('session-123', 'Preview Session', '/home');

      expect(id).toBe(-1);
      const terminal = getTerminal(id);
      expect(terminal?.isPreview).toBe(true);
      expect(terminal?.previewSessionId).toBe('session-123');
      expect(terminal?.name).toBe('Preview: Preview Session');
    });

    it('decrements preview ID for each new preview', () => {
      const { createPreviewTerminal } = useTerminalStore.getState();

      const id1 = createPreviewTerminal('session-1', 'Preview 1', '/');
      const id2 = createPreviewTerminal('session-2', 'Preview 2', '/');

      expect(id1).toBe(-1);
      expect(id2).toBe(-2);
    });
  });

  describe('createTerminal', () => {
    it('calls IPC to start claude and returns result', async () => {
      vi.mocked(window.goodvibes.startClaude).mockResolvedValue({
        id: 1,
        name: 'New Terminal',
        cwd: '/home/test',
      });

      const { createTerminal } = useTerminalStore.getState();
      const result = await createTerminal('/home/test', 'New Terminal');

      expect(result.id).toBe(1);
      expect(result.name).toBe('New Terminal');
      expect(window.goodvibes.startClaude).toHaveBeenCalledWith({
        cwd: '/home/test',
        name: 'New Terminal',
        resumeSessionId: undefined,
      });
    });

    it('handles errors gracefully', async () => {
      vi.mocked(window.goodvibes.startClaude).mockRejectedValue(new Error('Failed to start'));

      const { createTerminal } = useTerminalStore.getState();
      const result = await createTerminal('/home/test');

      expect(result.error).toBe('Failed to start');
    });
  });
});
