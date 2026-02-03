// ============================================================================
// APP STORE TESTS
// ============================================================================

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { useAppStore } from './appStore';
import type { ViewName } from '../../shared/constants';

describe('useAppStore', () => {
  beforeEach(() => {
    // Reset store to initial state before each test
    useAppStore.setState({
      currentView: 'terminal',
      isLoading: false,
      loadingMessage: null,
      loadingProgress: null,
      isCommandPaletteOpen: false,
      isQuickSwitcherOpen: false,
      isFolderPickerOpen: false,
      isTextEditorPickerOpen: false,
      activeModal: null,
    });
    vi.clearAllMocks();
  });

  describe('initial state', () => {
    it('has correct default values', () => {
      const state = useAppStore.getState();

      expect(state.currentView).toBe('terminal');
      expect(state.isLoading).toBe(false);
      expect(state.loadingMessage).toBeNull();
      expect(state.loadingProgress).toBeNull();
      expect(state.isCommandPaletteOpen).toBe(false);
      expect(state.isQuickSwitcherOpen).toBe(false);
      expect(state.isFolderPickerOpen).toBe(false);
      expect(state.isTextEditorPickerOpen).toBe(false);
      expect(state.activeModal).toBeNull();
    });
  });

  describe('setCurrentView', () => {
    it('sets the current view to a valid view name', () => {
      const { setCurrentView } = useAppStore.getState();

      setCurrentView('sessions');

      expect(useAppStore.getState().currentView).toBe('sessions');
    });

    it('navigates to all valid view names', () => {
      const validViews: ViewName[] = [
        'terminal',
        'sessions',
        'analytics',
        'tasks',
        'notebook',
        'hooks',
        'mcp',
        'plugins',
        'agents',
        'memory',
        'skills',
        'commands',
        'projects',
        'settings',
      ];

      validViews.forEach((view) => {
        const { setCurrentView } = useAppStore.getState();
        setCurrentView(view);
        expect(useAppStore.getState().currentView).toBe(view);
      });
    });

    it('overwrites previous view when setting new view', () => {
      const { setCurrentView } = useAppStore.getState();

      setCurrentView('analytics');
      expect(useAppStore.getState().currentView).toBe('analytics');

      setCurrentView('settings');
      expect(useAppStore.getState().currentView).toBe('settings');

      setCurrentView('terminal');
      expect(useAppStore.getState().currentView).toBe('terminal');
    });

    it('can set to the same view without issue', () => {
      const { setCurrentView } = useAppStore.getState();

      setCurrentView('terminal');
      setCurrentView('terminal');

      expect(useAppStore.getState().currentView).toBe('terminal');
    });
  });

  describe('setLoading', () => {
    it('sets loading state to true', () => {
      const { setLoading } = useAppStore.getState();

      setLoading(true);

      const state = useAppStore.getState();
      expect(state.isLoading).toBe(true);
      expect(state.loadingMessage).toBeNull();
      expect(state.loadingProgress).toBeNull();
    });

    it('sets loading state to false', () => {
      // First set to true
      useAppStore.setState({ isLoading: true, loadingMessage: 'Loading...' });

      const { setLoading } = useAppStore.getState();
      setLoading(false);

      const state = useAppStore.getState();
      expect(state.isLoading).toBe(false);
      expect(state.loadingMessage).toBeNull();
      expect(state.loadingProgress).toBeNull();
    });

    it('sets loading state with message', () => {
      const { setLoading } = useAppStore.getState();

      setLoading(true, 'Loading sessions...');

      const state = useAppStore.getState();
      expect(state.isLoading).toBe(true);
      expect(state.loadingMessage).toBe('Loading sessions...');
      expect(state.loadingProgress).toBeNull();
    });

    it('sets loading state with progress', () => {
      const { setLoading } = useAppStore.getState();

      setLoading(true, 'Processing files...', { current: 5, total: 10 });

      const state = useAppStore.getState();
      expect(state.isLoading).toBe(true);
      expect(state.loadingMessage).toBe('Processing files...');
      expect(state.loadingProgress).toEqual({ current: 5, total: 10 });
    });

    it('clears message and progress when loading is false', () => {
      // First set with message and progress
      useAppStore.setState({
        isLoading: true,
        loadingMessage: 'Loading...',
        loadingProgress: { current: 3, total: 10 },
      });

      const { setLoading } = useAppStore.getState();
      setLoading(false);

      const state = useAppStore.getState();
      expect(state.isLoading).toBe(false);
      expect(state.loadingMessage).toBeNull();
      expect(state.loadingProgress).toBeNull();
    });

    it('updates progress during loading', () => {
      const { setLoading } = useAppStore.getState();

      setLoading(true, 'Processing...', { current: 1, total: 5 });
      expect(useAppStore.getState().loadingProgress).toEqual({ current: 1, total: 5 });

      setLoading(true, 'Processing...', { current: 3, total: 5 });
      expect(useAppStore.getState().loadingProgress).toEqual({ current: 3, total: 5 });

      setLoading(true, 'Processing...', { current: 5, total: 5 });
      expect(useAppStore.getState().loadingProgress).toEqual({ current: 5, total: 5 });
    });

    it('handles empty string message', () => {
      const { setLoading } = useAppStore.getState();

      setLoading(true, '');

      const state = useAppStore.getState();
      expect(state.isLoading).toBe(true);
      expect(state.loadingMessage).toBe('');
    });

    it('handles zero progress values', () => {
      const { setLoading } = useAppStore.getState();

      setLoading(true, 'Starting...', { current: 0, total: 0 });

      const state = useAppStore.getState();
      expect(state.loadingProgress).toEqual({ current: 0, total: 0 });
    });
  });

  describe('command palette', () => {
    describe('openCommandPalette', () => {
      it('opens the command palette', () => {
        const { openCommandPalette } = useAppStore.getState();

        openCommandPalette();

        expect(useAppStore.getState().isCommandPaletteOpen).toBe(true);
      });

      it('keeps command palette open when called multiple times', () => {
        const { openCommandPalette } = useAppStore.getState();

        openCommandPalette();
        openCommandPalette();

        expect(useAppStore.getState().isCommandPaletteOpen).toBe(true);
      });
    });

    describe('closeCommandPalette', () => {
      it('closes the command palette', () => {
        // First open it
        useAppStore.setState({ isCommandPaletteOpen: true });

        const { closeCommandPalette } = useAppStore.getState();
        closeCommandPalette();

        expect(useAppStore.getState().isCommandPaletteOpen).toBe(false);
      });

      it('keeps command palette closed when called multiple times', () => {
        const { closeCommandPalette } = useAppStore.getState();

        closeCommandPalette();
        closeCommandPalette();

        expect(useAppStore.getState().isCommandPaletteOpen).toBe(false);
      });
    });

    describe('toggleCommandPalette', () => {
      it('opens command palette when closed', () => {
        expect(useAppStore.getState().isCommandPaletteOpen).toBe(false);

        const { toggleCommandPalette } = useAppStore.getState();
        toggleCommandPalette();

        expect(useAppStore.getState().isCommandPaletteOpen).toBe(true);
      });

      it('closes command palette when open', () => {
        useAppStore.setState({ isCommandPaletteOpen: true });

        const { toggleCommandPalette } = useAppStore.getState();
        toggleCommandPalette();

        expect(useAppStore.getState().isCommandPaletteOpen).toBe(false);
      });

      it('toggles multiple times correctly', () => {
        const { toggleCommandPalette } = useAppStore.getState();

        toggleCommandPalette(); // open
        expect(useAppStore.getState().isCommandPaletteOpen).toBe(true);

        toggleCommandPalette(); // close
        expect(useAppStore.getState().isCommandPaletteOpen).toBe(false);

        toggleCommandPalette(); // open
        expect(useAppStore.getState().isCommandPaletteOpen).toBe(true);
      });
    });
  });

  describe('quick switcher', () => {
    describe('openQuickSwitcher', () => {
      it('opens the quick switcher', () => {
        const { openQuickSwitcher } = useAppStore.getState();

        openQuickSwitcher();

        expect(useAppStore.getState().isQuickSwitcherOpen).toBe(true);
      });

      it('keeps quick switcher open when called multiple times', () => {
        const { openQuickSwitcher } = useAppStore.getState();

        openQuickSwitcher();
        openQuickSwitcher();

        expect(useAppStore.getState().isQuickSwitcherOpen).toBe(true);
      });
    });

    describe('closeQuickSwitcher', () => {
      it('closes the quick switcher', () => {
        useAppStore.setState({ isQuickSwitcherOpen: true });

        const { closeQuickSwitcher } = useAppStore.getState();
        closeQuickSwitcher();

        expect(useAppStore.getState().isQuickSwitcherOpen).toBe(false);
      });

      it('keeps quick switcher closed when called multiple times', () => {
        const { closeQuickSwitcher } = useAppStore.getState();

        closeQuickSwitcher();
        closeQuickSwitcher();

        expect(useAppStore.getState().isQuickSwitcherOpen).toBe(false);
      });
    });

    describe('toggleQuickSwitcher', () => {
      it('opens quick switcher when closed', () => {
        expect(useAppStore.getState().isQuickSwitcherOpen).toBe(false);

        const { toggleQuickSwitcher } = useAppStore.getState();
        toggleQuickSwitcher();

        expect(useAppStore.getState().isQuickSwitcherOpen).toBe(true);
      });

      it('closes quick switcher when open', () => {
        useAppStore.setState({ isQuickSwitcherOpen: true });

        const { toggleQuickSwitcher } = useAppStore.getState();
        toggleQuickSwitcher();

        expect(useAppStore.getState().isQuickSwitcherOpen).toBe(false);
      });

      it('toggles multiple times correctly', () => {
        const { toggleQuickSwitcher } = useAppStore.getState();

        toggleQuickSwitcher(); // open
        expect(useAppStore.getState().isQuickSwitcherOpen).toBe(true);

        toggleQuickSwitcher(); // close
        expect(useAppStore.getState().isQuickSwitcherOpen).toBe(false);

        toggleQuickSwitcher(); // open
        expect(useAppStore.getState().isQuickSwitcherOpen).toBe(true);
      });
    });
  });

  describe('folder picker', () => {
    describe('openFolderPicker', () => {
      it('opens the folder picker', () => {
        const { openFolderPicker } = useAppStore.getState();

        openFolderPicker();

        expect(useAppStore.getState().isFolderPickerOpen).toBe(true);
      });

      it('keeps folder picker open when called multiple times', () => {
        const { openFolderPicker } = useAppStore.getState();

        openFolderPicker();
        openFolderPicker();

        expect(useAppStore.getState().isFolderPickerOpen).toBe(true);
      });
    });

    describe('closeFolderPicker', () => {
      it('closes the folder picker', () => {
        useAppStore.setState({ isFolderPickerOpen: true });

        const { closeFolderPicker } = useAppStore.getState();
        closeFolderPicker();

        expect(useAppStore.getState().isFolderPickerOpen).toBe(false);
      });

      it('keeps folder picker closed when called multiple times', () => {
        const { closeFolderPicker } = useAppStore.getState();

        closeFolderPicker();
        closeFolderPicker();

        expect(useAppStore.getState().isFolderPickerOpen).toBe(false);
      });
    });
  });

  describe('text editor picker', () => {
    describe('openTextEditorPicker', () => {
      it('opens the text editor picker', () => {
        const { openTextEditorPicker } = useAppStore.getState();

        openTextEditorPicker();

        expect(useAppStore.getState().isTextEditorPickerOpen).toBe(true);
      });

      it('keeps text editor picker open when called multiple times', () => {
        const { openTextEditorPicker } = useAppStore.getState();

        openTextEditorPicker();
        openTextEditorPicker();

        expect(useAppStore.getState().isTextEditorPickerOpen).toBe(true);
      });
    });

    describe('closeTextEditorPicker', () => {
      it('closes the text editor picker', () => {
        useAppStore.setState({ isTextEditorPickerOpen: true });

        const { closeTextEditorPicker } = useAppStore.getState();
        closeTextEditorPicker();

        expect(useAppStore.getState().isTextEditorPickerOpen).toBe(false);
      });

      it('keeps text editor picker closed when called multiple times', () => {
        const { closeTextEditorPicker } = useAppStore.getState();

        closeTextEditorPicker();
        closeTextEditorPicker();

        expect(useAppStore.getState().isTextEditorPickerOpen).toBe(false);
      });
    });
  });

  describe('modal management', () => {
    describe('openModal', () => {
      it('opens a modal with given id', () => {
        const { openModal } = useAppStore.getState();

        openModal('settings-modal');

        expect(useAppStore.getState().activeModal).toBe('settings-modal');
      });

      it('replaces current modal when opening new one', () => {
        useAppStore.setState({ activeModal: 'modal-1' });

        const { openModal } = useAppStore.getState();
        openModal('modal-2');

        expect(useAppStore.getState().activeModal).toBe('modal-2');
      });

      it('handles various modal id formats', () => {
        const { openModal } = useAppStore.getState();
        const modalIds = [
          'simple',
          'kebab-case-modal',
          'camelCaseModal',
          'snake_case_modal',
          'modal.with.dots',
          'modal123',
        ];

        modalIds.forEach((id) => {
          openModal(id);
          expect(useAppStore.getState().activeModal).toBe(id);
        });
      });

      it('handles empty string modal id', () => {
        const { openModal } = useAppStore.getState();

        openModal('');

        expect(useAppStore.getState().activeModal).toBe('');
      });
    });

    describe('closeModal', () => {
      it('closes the active modal', () => {
        useAppStore.setState({ activeModal: 'test-modal' });

        const { closeModal } = useAppStore.getState();
        closeModal();

        expect(useAppStore.getState().activeModal).toBeNull();
      });

      it('does nothing when no modal is open', () => {
        expect(useAppStore.getState().activeModal).toBeNull();

        const { closeModal } = useAppStore.getState();
        closeModal();

        expect(useAppStore.getState().activeModal).toBeNull();
      });

      it('can be called multiple times safely', () => {
        useAppStore.setState({ activeModal: 'test-modal' });

        const { closeModal } = useAppStore.getState();
        closeModal();
        closeModal();
        closeModal();

        expect(useAppStore.getState().activeModal).toBeNull();
      });
    });
  });

  describe('state isolation', () => {
    it('changing view does not affect loading state', () => {
      useAppStore.setState({ isLoading: true, loadingMessage: 'Loading...' });

      const { setCurrentView } = useAppStore.getState();
      setCurrentView('settings');

      const state = useAppStore.getState();
      expect(state.currentView).toBe('settings');
      expect(state.isLoading).toBe(true);
      expect(state.loadingMessage).toBe('Loading...');
    });

    it('changing loading state does not affect view', () => {
      useAppStore.setState({ currentView: 'analytics' });

      const { setLoading } = useAppStore.getState();
      setLoading(true, 'Processing...');

      const state = useAppStore.getState();
      expect(state.currentView).toBe('analytics');
      expect(state.isLoading).toBe(true);
    });

    it('opening modals does not affect other UI states', () => {
      useAppStore.setState({
        currentView: 'sessions',
        isQuickSwitcherOpen: true,
        isFolderPickerOpen: true,
      });

      const { openModal } = useAppStore.getState();
      openModal('export-modal');

      const state = useAppStore.getState();
      expect(state.currentView).toBe('sessions');
      expect(state.isQuickSwitcherOpen).toBe(true);
      expect(state.isFolderPickerOpen).toBe(true);
      expect(state.activeModal).toBe('export-modal');
    });

    it('multiple UI overlays can be open simultaneously', () => {
      const state = useAppStore.getState();

      state.openCommandPalette();
      state.openQuickSwitcher();
      state.openFolderPicker();
      state.openTextEditorPicker();
      state.openModal('test-modal');

      const finalState = useAppStore.getState();
      expect(finalState.isCommandPaletteOpen).toBe(true);
      expect(finalState.isQuickSwitcherOpen).toBe(true);
      expect(finalState.isFolderPickerOpen).toBe(true);
      expect(finalState.isTextEditorPickerOpen).toBe(true);
      expect(finalState.activeModal).toBe('test-modal');
    });
  });

  describe('zustand store behavior', () => {
    it('getState returns current state', () => {
      const state = useAppStore.getState();

      expect(state).toHaveProperty('currentView');
      expect(state).toHaveProperty('setCurrentView');
      expect(state).toHaveProperty('isLoading');
      expect(state).toHaveProperty('setLoading');
      expect(state).toHaveProperty('isCommandPaletteOpen');
      expect(state).toHaveProperty('openCommandPalette');
      expect(state).toHaveProperty('closeCommandPalette');
      expect(state).toHaveProperty('toggleCommandPalette');
    });

    it('setState merges partial state updates', () => {
      useAppStore.setState({
        currentView: 'analytics',
        isLoading: true,
      });

      const state = useAppStore.getState();
      expect(state.currentView).toBe('analytics');
      expect(state.isLoading).toBe(true);
      // Other properties should remain at their default values
      expect(state.isCommandPaletteOpen).toBe(false);
    });

    it('actions are stable across getState calls', () => {
      const state1 = useAppStore.getState();
      const state2 = useAppStore.getState();

      // Actions should be the same function references
      expect(state1.setCurrentView).toBe(state2.setCurrentView);
      expect(state1.setLoading).toBe(state2.setLoading);
      expect(state1.openCommandPalette).toBe(state2.openCommandPalette);
    });
  });
});
