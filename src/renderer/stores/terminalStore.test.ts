// ============================================================================
// TERMINAL STORE TESTS
// ============================================================================

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { useTerminalStore } from './terminalStore';

// Helper function to add a terminal directly to the store (bypasses IPC)
function addTerminalToStore(
  id: number,
  name: string,
  cwd: string,
  options?: {
    isPreview?: boolean;
    previewSessionId?: string;
    isPlainTerminal?: boolean;
    resumeSessionId?: string;
    sessionType?: 'user' | 'subagent';
  }
) {
  useTerminalStore.setState((state) => {
    const newMap = new Map(state.terminals);
    newMap.set(id, {
      id,
      name,
      cwd,
      startTime: new Date(),
      isLoading: false,
      ...options,
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

  describe('initial state', () => {
    it('has empty terminals map', () => {
      const { terminals } = useTerminalStore.getState();
      expect(terminals.size).toBe(0);
    });

    it('has null activeTerminalId', () => {
      const { activeTerminalId } = useTerminalStore.getState();
      expect(activeTerminalId).toBeNull();
    });

    it('has default zoom level of 100', () => {
      const { zoomLevel } = useTerminalStore.getState();
      expect(zoomLevel).toBe(100);
    });

    it('has nextPreviewId of -1', () => {
      const { nextPreviewId } = useTerminalStore.getState();
      expect(nextPreviewId).toBe(-1);
    });
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

    it('stores isLoading state correctly', () => {
      addTerminalToStore(1, 'Test', '/');
      const terminal = useTerminalStore.getState().getTerminal(1);
      expect(terminal?.isLoading).toBe(false);
    });

    it('stores terminal startTime', () => {
      const beforeAdd = new Date();
      addTerminalToStore(1, 'Test', '/');
      const terminal = useTerminalStore.getState().getTerminal(1);
      expect(terminal?.startTime).toBeDefined();
      expect(terminal?.startTime.getTime()).toBeGreaterThanOrEqual(beforeAdd.getTime());
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

    it('adds terminal to store on success', async () => {
      vi.mocked(window.goodvibes.startClaude).mockResolvedValue({
        id: 5,
        name: 'Created Terminal',
        cwd: '/test/path',
      });

      const { createTerminal, getTerminal } = useTerminalStore.getState();
      await createTerminal('/test/path', 'Created Terminal');

      const terminal = getTerminal(5);
      expect(terminal).toBeDefined();
      expect(terminal?.name).toBe('Created Terminal');
      expect(terminal?.cwd).toBe('/test/path');
      expect(terminal?.isLoading).toBe(false);
    });

    it('sets activeTerminalId to new terminal on success', async () => {
      vi.mocked(window.goodvibes.startClaude).mockResolvedValue({
        id: 10,
        name: 'Test',
        cwd: '/',
      });

      const { createTerminal } = useTerminalStore.getState();
      await createTerminal('/', 'Test');

      expect(useTerminalStore.getState().activeTerminalId).toBe(10);
    });

    it('passes resumeSessionId to IPC when provided', async () => {
      vi.mocked(window.goodvibes.startClaude).mockResolvedValue({
        id: 1,
        resumeSessionId: 'session-abc',
      });

      const { createTerminal } = useTerminalStore.getState();
      await createTerminal('/home', 'Resume Test', 'session-abc');

      expect(window.goodvibes.startClaude).toHaveBeenCalledWith({
        cwd: '/home',
        name: 'Resume Test',
        resumeSessionId: 'session-abc',
      });
    });

    it('stores resumeSessionId when returned from IPC', async () => {
      vi.mocked(window.goodvibes.startClaude).mockResolvedValue({
        id: 1,
        name: 'Resumed',
        cwd: '/',
        resumeSessionId: 'session-xyz',
      });

      const { createTerminal, getTerminal } = useTerminalStore.getState();
      await createTerminal('/', 'Resumed', 'session-xyz');

      const terminal = getTerminal(1);
      expect(terminal?.resumeSessionId).toBe('session-xyz');
    });

    it('stores sessionType when returned from IPC', async () => {
      vi.mocked(window.goodvibes.startClaude).mockResolvedValue({
        id: 1,
        name: 'Agent',
        cwd: '/',
        sessionType: 'subagent',
      });

      const { createTerminal, getTerminal } = useTerminalStore.getState();
      await createTerminal('/', 'Agent');

      const terminal = getTerminal(1);
      expect(terminal?.sessionType).toBe('subagent');
    });

    it('returns error result when IPC returns error', async () => {
      vi.mocked(window.goodvibes.startClaude).mockResolvedValue({
        error: 'Claude not found',
      });

      const { createTerminal, getTerminalList } = useTerminalStore.getState();
      const result = await createTerminal('/');

      expect(result.error).toBe('Claude not found');
      expect(getTerminalList()).toHaveLength(0);
    });

    it('handles IPC rejection gracefully', async () => {
      vi.mocked(window.goodvibes.startClaude).mockRejectedValue(new Error('Failed to start'));

      const { createTerminal } = useTerminalStore.getState();
      const result = await createTerminal('/home/test');

      expect(result.error).toBe('Failed to start');
    });

    it('handles non-Error rejection gracefully', async () => {
      vi.mocked(window.goodvibes.startClaude).mockRejectedValue('String error');

      const { createTerminal } = useTerminalStore.getState();
      const result = await createTerminal('/');

      expect(result.error).toBe('Unknown error');
    });

    it('uses default name when not provided in result', async () => {
      vi.mocked(window.goodvibes.startClaude).mockResolvedValue({
        id: 1,
        cwd: '/test',
      });

      const { createTerminal, getTerminal } = useTerminalStore.getState();
      await createTerminal('/test');

      const terminal = getTerminal(1);
      expect(terminal?.name).toBe('Terminal');
    });

    it('uses provided cwd as fallback when not in result', async () => {
      vi.mocked(window.goodvibes.startClaude).mockResolvedValue({
        id: 1,
      });

      const { createTerminal, getTerminal } = useTerminalStore.getState();
      await createTerminal('/fallback/path');

      const terminal = getTerminal(1);
      expect(terminal?.cwd).toBe('/fallback/path');
    });

    it('does not add terminal when id is undefined', async () => {
      vi.mocked(window.goodvibes.startClaude).mockResolvedValue({
        name: 'Test',
        cwd: '/',
      });

      const { createTerminal, getTerminalList } = useTerminalStore.getState();
      await createTerminal('/');

      expect(getTerminalList()).toHaveLength(0);
    });
  });

  describe('createPlainTerminal', () => {
    it('calls IPC to start plain terminal and returns result', async () => {
      vi.mocked(window.goodvibes.startPlainTerminal).mockResolvedValue({
        id: 2,
        name: 'Plain Terminal',
        cwd: '/home/user',
      });

      const { createPlainTerminal } = useTerminalStore.getState();
      const result = await createPlainTerminal('/home/user', 'Plain Terminal');

      expect(result.id).toBe(2);
      expect(window.goodvibes.startPlainTerminal).toHaveBeenCalledWith({
        cwd: '/home/user',
        name: 'Plain Terminal',
      });
    });

    it('adds terminal to store with isPlainTerminal flag', async () => {
      vi.mocked(window.goodvibes.startPlainTerminal).mockResolvedValue({
        id: 3,
        name: 'Shell',
        cwd: '/tmp',
      });

      const { createPlainTerminal, getTerminal } = useTerminalStore.getState();
      await createPlainTerminal('/tmp', 'Shell');

      const terminal = getTerminal(3);
      expect(terminal).toBeDefined();
      expect(terminal?.isPlainTerminal).toBe(true);
    });

    it('sets activeTerminalId to new terminal on success', async () => {
      vi.mocked(window.goodvibes.startPlainTerminal).mockResolvedValue({
        id: 7,
        name: 'Plain',
        cwd: '/',
      });

      const { createPlainTerminal } = useTerminalStore.getState();
      await createPlainTerminal('/');

      expect(useTerminalStore.getState().activeTerminalId).toBe(7);
    });

    it('returns error result when IPC returns error', async () => {
      vi.mocked(window.goodvibes.startPlainTerminal).mockResolvedValue({
        error: 'Shell not available',
      });

      const { createPlainTerminal, getTerminalList } = useTerminalStore.getState();
      const result = await createPlainTerminal('/');

      expect(result.error).toBe('Shell not available');
      expect(getTerminalList()).toHaveLength(0);
    });

    it('handles IPC rejection gracefully', async () => {
      vi.mocked(window.goodvibes.startPlainTerminal).mockRejectedValue(
        new Error('PTY creation failed')
      );

      const { createPlainTerminal } = useTerminalStore.getState();
      const result = await createPlainTerminal('/');

      expect(result.error).toBe('PTY creation failed');
    });

    it('handles non-Error rejection gracefully', async () => {
      vi.mocked(window.goodvibes.startPlainTerminal).mockRejectedValue('Unknown failure');

      const { createPlainTerminal } = useTerminalStore.getState();
      const result = await createPlainTerminal('/');

      expect(result.error).toBe('Unknown error');
    });

    it('does not add terminal when id is undefined', async () => {
      vi.mocked(window.goodvibes.startPlainTerminal).mockResolvedValue({
        name: 'Test',
        cwd: '/',
      });

      const { createPlainTerminal, getTerminalList } = useTerminalStore.getState();
      await createPlainTerminal('/');

      expect(getTerminalList()).toHaveLength(0);
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

    it('calls killTerminal IPC for regular terminals', async () => {
      addTerminalToStore(1, 'Test', '/');

      const { closeTerminal } = useTerminalStore.getState();
      await closeTerminal(1);

      expect(window.goodvibes.killTerminal).toHaveBeenCalledWith(1);
    });

    it('does not call killTerminal for preview terminals', async () => {
      addTerminalToStore(-1, 'Preview', '/', {
        isPreview: true,
        previewSessionId: 'session-123',
      });

      const { closeTerminal } = useTerminalStore.getState();
      await closeTerminal(-1);

      expect(window.goodvibes.killTerminal).not.toHaveBeenCalled();
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

    it('handles killTerminal IPC error gracefully', async () => {
      vi.mocked(window.goodvibes.killTerminal).mockRejectedValue(new Error('Kill failed'));
      addTerminalToStore(1, 'Test', '/');

      const { closeTerminal } = useTerminalStore.getState();
      // Should not throw
      await expect(closeTerminal(1)).resolves.toBeUndefined();

      // Terminal should still be removed from state
      expect(useTerminalStore.getState().terminals.has(1)).toBe(false);
    });

    it('keeps non-active terminal as active when closing other terminal', async () => {
      addTerminalToStore(1, 'Test 1', '/');
      addTerminalToStore(2, 'Test 2', '/');
      useTerminalStore.getState().setActiveTerminal(2);

      const { closeTerminal } = useTerminalStore.getState();
      await closeTerminal(1);

      expect(useTerminalStore.getState().activeTerminalId).toBe(2);
    });
  });

  describe('closePreviewTerminal', () => {
    it('removes preview terminal from state', () => {
      addTerminalToStore(-1, 'Preview', '/', { isPreview: true });

      const { closePreviewTerminal } = useTerminalStore.getState();
      closePreviewTerminal(-1);

      expect(useTerminalStore.getState().terminals.has(-1)).toBe(false);
    });

    it('does not call killTerminal IPC', () => {
      addTerminalToStore(-1, 'Preview', '/', { isPreview: true });

      const { closePreviewTerminal } = useTerminalStore.getState();
      closePreviewTerminal(-1);

      expect(window.goodvibes.killTerminal).not.toHaveBeenCalled();
    });

    it('updates active terminal when removing active preview', () => {
      addTerminalToStore(1, 'Regular', '/');
      addTerminalToStore(-1, 'Preview', '/', { isPreview: true });
      useTerminalStore.getState().setActiveTerminal(-1);

      const { closePreviewTerminal } = useTerminalStore.getState();
      closePreviewTerminal(-1);

      expect(useTerminalStore.getState().activeTerminalId).toBe(1);
    });

    it('sets active to null when removing last terminal', () => {
      addTerminalToStore(-1, 'Preview', '/', { isPreview: true });

      const { closePreviewTerminal } = useTerminalStore.getState();
      closePreviewTerminal(-1);

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

    it('allows setting to null', () => {
      addTerminalToStore(1, 'Test', '/');

      const { setActiveTerminal } = useTerminalStore.getState();
      setActiveTerminal(null);

      expect(useTerminalStore.getState().activeTerminalId).toBeNull();
    });

    it('allows setting to non-existent ID', () => {
      const { setActiveTerminal } = useTerminalStore.getState();
      setActiveTerminal(999);

      expect(useTerminalStore.getState().activeTerminalId).toBe(999);
    });
  });

  describe('removeTerminal', () => {
    it('removes a terminal from state without calling kill', () => {
      addTerminalToStore(1, 'Test', '/');
      addTerminalToStore(2, 'Test 2', '/');

      const { removeTerminal } = useTerminalStore.getState();
      removeTerminal(1);

      expect(useTerminalStore.getState().terminals.size).toBe(1);
      expect(useTerminalStore.getState().terminals.has(1)).toBe(false);
      // Should NOT call killTerminal IPC
      expect(window.goodvibes.killTerminal).not.toHaveBeenCalled();
    });

    it('updates active terminal when removing active', () => {
      addTerminalToStore(1, 'Test 1', '/');
      addTerminalToStore(2, 'Test 2', '/');
      useTerminalStore.getState().setActiveTerminal(1);

      const { removeTerminal } = useTerminalStore.getState();
      removeTerminal(1);

      // Should switch to remaining terminal
      expect(useTerminalStore.getState().activeTerminalId).toBe(2);
    });

    it('sets active to null when removing last terminal', () => {
      addTerminalToStore(1, 'Test', '/');

      const { removeTerminal } = useTerminalStore.getState();
      removeTerminal(1);

      expect(useTerminalStore.getState().activeTerminalId).toBeNull();
    });

    it('handles removing non-existent terminal gracefully', () => {
      const { removeTerminal } = useTerminalStore.getState();

      // Should not throw when removing non-existent terminal
      expect(() => removeTerminal(999)).not.toThrow();
      expect(useTerminalStore.getState().terminals.size).toBe(0);
    });

    it('selects last remaining terminal when active is removed', () => {
      addTerminalToStore(1, 'T1', '/');
      addTerminalToStore(2, 'T2', '/');
      addTerminalToStore(3, 'T3', '/');
      useTerminalStore.getState().setActiveTerminal(2);

      const { removeTerminal } = useTerminalStore.getState();
      removeTerminal(2);

      // Should select the last terminal in the map (3)
      expect(useTerminalStore.getState().activeTerminalId).toBe(3);
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

    it('can update isLoading state', () => {
      addTerminalToStore(1, 'Test', '/');

      const { updateTerminal, getTerminal } = useTerminalStore.getState();
      updateTerminal(1, { isLoading: true });

      expect(getTerminal(1)?.isLoading).toBe(true);
    });

    it('can update error state', () => {
      addTerminalToStore(1, 'Test', '/');

      const { updateTerminal, getTerminal } = useTerminalStore.getState();
      updateTerminal(1, { error: 'Connection lost' });

      expect(getTerminal(1)?.error).toBe('Connection lost');
    });

    it('does nothing when terminal does not exist', () => {
      const initialState = useTerminalStore.getState();
      const { updateTerminal } = useTerminalStore.getState();

      updateTerminal(999, { name: 'Should not exist' });

      expect(useTerminalStore.getState().terminals.size).toBe(initialState.terminals.size);
    });

    it('creates new Map instance for immutability', () => {
      addTerminalToStore(1, 'Test', '/');
      const originalMap = useTerminalStore.getState().terminals;

      const { updateTerminal } = useTerminalStore.getState();
      updateTerminal(1, { name: 'Updated' });

      const newMap = useTerminalStore.getState().terminals;
      expect(newMap).not.toBe(originalMap);
    });
  });

  describe('getTerminal', () => {
    it('returns terminal by ID', () => {
      addTerminalToStore(5, 'Target', '/path');

      const { getTerminal } = useTerminalStore.getState();
      const terminal = getTerminal(5);

      expect(terminal?.id).toBe(5);
      expect(terminal?.name).toBe('Target');
    });

    it('returns undefined for non-existent ID', () => {
      const { getTerminal } = useTerminalStore.getState();
      expect(getTerminal(999)).toBeUndefined();
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

    it('returns array with all terminal properties', () => {
      addTerminalToStore(1, 'Test', '/home', { isPlainTerminal: true });

      const { getTerminalList } = useTerminalStore.getState();
      const list = getTerminalList();

      expect(list[0]?.id).toBe(1);
      expect(list[0]?.name).toBe('Test');
      expect(list[0]?.cwd).toBe('/home');
      expect(list[0]?.isPlainTerminal).toBe(true);
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

    it('returns undefined when activeTerminalId points to non-existent terminal', () => {
      useTerminalStore.setState({ activeTerminalId: 999 });

      const { getActiveTerminal } = useTerminalStore.getState();
      expect(getActiveTerminal()).toBeUndefined();
    });
  });

  describe('switchToNextTab', () => {
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

    it('does nothing when no terminals', () => {
      const { switchToNextTab } = useTerminalStore.getState();
      switchToNextTab();

      expect(useTerminalStore.getState().activeTerminalId).toBeNull();
    });

    it('stays on same terminal when only one exists', () => {
      addTerminalToStore(1, 'Only', '/');
      useTerminalStore.getState().setActiveTerminal(1);

      const { switchToNextTab } = useTerminalStore.getState();
      switchToNextTab();

      expect(useTerminalStore.getState().activeTerminalId).toBe(1);
    });

    it('handles null activeTerminalId', () => {
      addTerminalToStore(1, 'T1', '/');
      addTerminalToStore(2, 'T2', '/');
      useTerminalStore.setState({ activeTerminalId: null });

      const { switchToNextTab } = useTerminalStore.getState();
      switchToNextTab();

      // Should go to index 0 (first terminal)
      expect(useTerminalStore.getState().activeTerminalId).toBe(1);
    });
  });

  describe('switchToPrevTab', () => {
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

    it('does nothing when no terminals', () => {
      const { switchToPrevTab } = useTerminalStore.getState();
      switchToPrevTab();

      expect(useTerminalStore.getState().activeTerminalId).toBeNull();
    });

    it('stays on same terminal when only one exists', () => {
      addTerminalToStore(1, 'Only', '/');
      useTerminalStore.getState().setActiveTerminal(1);

      const { switchToPrevTab } = useTerminalStore.getState();
      switchToPrevTab();

      expect(useTerminalStore.getState().activeTerminalId).toBe(1);
    });

    it('handles null activeTerminalId', () => {
      addTerminalToStore(1, 'T1', '/');
      addTerminalToStore(2, 'T2', '/');
      useTerminalStore.setState({ activeTerminalId: null });

      const { switchToPrevTab } = useTerminalStore.getState();
      switchToPrevTab();

      // With null, currentIndex is 0, so prev wraps to last
      expect(useTerminalStore.getState().activeTerminalId).toBe(2);
    });
  });

  describe('zoom functionality', () => {
    it('sets zoom level within bounds', () => {
      const { setZoomLevel } = useTerminalStore.getState();

      setZoomLevel(150);
      expect(useTerminalStore.getState().zoomLevel).toBe(150);
    });

    it('clamps zoom level to minimum of 50', () => {
      const { setZoomLevel } = useTerminalStore.getState();

      setZoomLevel(10);
      expect(useTerminalStore.getState().zoomLevel).toBe(50);

      setZoomLevel(0);
      expect(useTerminalStore.getState().zoomLevel).toBe(50);

      setZoomLevel(-100);
      expect(useTerminalStore.getState().zoomLevel).toBe(50);
    });

    it('clamps zoom level to maximum of 200', () => {
      const { setZoomLevel } = useTerminalStore.getState();

      setZoomLevel(300);
      expect(useTerminalStore.getState().zoomLevel).toBe(200);

      setZoomLevel(250);
      expect(useTerminalStore.getState().zoomLevel).toBe(200);
    });

    it('accepts boundary values exactly', () => {
      const { setZoomLevel } = useTerminalStore.getState();

      setZoomLevel(50);
      expect(useTerminalStore.getState().zoomLevel).toBe(50);

      setZoomLevel(200);
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
      const id3 = createPreviewTerminal('session-3', 'Preview 3', '/');

      expect(id1).toBe(-1);
      expect(id2).toBe(-2);
      expect(id3).toBe(-3);
    });

    it('sets preview terminal as active', () => {
      const { createPreviewTerminal } = useTerminalStore.getState();

      const id = createPreviewTerminal('session-abc', 'Test Preview', '/');

      expect(useTerminalStore.getState().activeTerminalId).toBe(id);
    });

    it('stores cwd for preview terminal', () => {
      const { createPreviewTerminal, getTerminal } = useTerminalStore.getState();

      const id = createPreviewTerminal('session-xyz', 'Preview', '/custom/path');

      expect(getTerminal(id)?.cwd).toBe('/custom/path');
    });

    it('uses empty string for cwd when not provided', () => {
      const { createPreviewTerminal, getTerminal } = useTerminalStore.getState();

      const id = createPreviewTerminal('session-no-cwd', 'No CWD Preview');

      expect(getTerminal(id)?.cwd).toBe('');
    });

    it('sets isLoading to false for preview terminals', () => {
      const { createPreviewTerminal, getTerminal } = useTerminalStore.getState();

      const id = createPreviewTerminal('session', 'Preview', '/');

      expect(getTerminal(id)?.isLoading).toBe(false);
    });

    it('updates nextPreviewId after creation', () => {
      const { createPreviewTerminal } = useTerminalStore.getState();

      expect(useTerminalStore.getState().nextPreviewId).toBe(-1);

      createPreviewTerminal('s1', 'P1', '/');
      expect(useTerminalStore.getState().nextPreviewId).toBe(-2);

      createPreviewTerminal('s2', 'P2', '/');
      expect(useTerminalStore.getState().nextPreviewId).toBe(-3);
    });
  });

  describe('Map immutability', () => {
    it('creates new Map instance when adding terminal', async () => {
      vi.mocked(window.goodvibes.startClaude).mockResolvedValue({
        id: 1,
        name: 'Test',
        cwd: '/',
      });

      const originalMap = useTerminalStore.getState().terminals;

      const { createTerminal } = useTerminalStore.getState();
      await createTerminal('/');

      const newMap = useTerminalStore.getState().terminals;
      expect(newMap).not.toBe(originalMap);
    });

    it('creates new Map instance when closing terminal', async () => {
      addTerminalToStore(1, 'Test', '/');
      const originalMap = useTerminalStore.getState().terminals;

      const { closeTerminal } = useTerminalStore.getState();
      await closeTerminal(1);

      const newMap = useTerminalStore.getState().terminals;
      expect(newMap).not.toBe(originalMap);
    });

    it('creates new Map instance when removing terminal', () => {
      addTerminalToStore(1, 'Test', '/');
      const originalMap = useTerminalStore.getState().terminals;

      const { removeTerminal } = useTerminalStore.getState();
      removeTerminal(1);

      const newMap = useTerminalStore.getState().terminals;
      expect(newMap).not.toBe(originalMap);
    });
  });
});
