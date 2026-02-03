// ============================================================================
// APP STORE - Global application state
// ============================================================================

import { create } from 'zustand';
import type { ViewName } from '../../shared/constants';

interface AppState {
  // View state
  currentView: ViewName;
  setCurrentView: (view: ViewName) => void;

  // Loading state
  isLoading: boolean;
  loadingMessage: string | null;
  loadingProgress: { current: number; total: number } | null;
  setLoading: (isLoading: boolean, message?: string | null, progress?: { current: number; total: number } | null) => void;

  // Command palette
  isCommandPaletteOpen: boolean;
  openCommandPalette: () => void;
  closeCommandPalette: () => void;
  toggleCommandPalette: () => void;

  // Quick switcher
  isQuickSwitcherOpen: boolean;
  openQuickSwitcher: () => void;
  closeQuickSwitcher: () => void;
  toggleQuickSwitcher: () => void;

  // Folder picker
  isFolderPickerOpen: boolean;
  openFolderPicker: () => void;
  closeFolderPicker: () => void;

  // Text editor picker
  isTextEditorPickerOpen: boolean;
  openTextEditorPicker: () => void;
  closeTextEditorPicker: () => void;

  // Active modal
  activeModal: string | null;
  openModal: (modalId: string) => void;
  closeModal: () => void;
}

export const useAppStore = create<AppState>((set) => ({
  // View state
  currentView: 'terminal',
  setCurrentView: (view) => set({ currentView: view }),

  // Loading state
  isLoading: false,
  loadingMessage: null,
  loadingProgress: null,
  setLoading: (isLoading, message = null, progress = null) =>
    set({ isLoading, loadingMessage: message, loadingProgress: progress }),

  // Command palette
  isCommandPaletteOpen: false,
  openCommandPalette: () => set({ isCommandPaletteOpen: true }),
  closeCommandPalette: () => set({ isCommandPaletteOpen: false }),
  toggleCommandPalette: () => set((s) => ({ isCommandPaletteOpen: !s.isCommandPaletteOpen })),

  // Quick switcher
  isQuickSwitcherOpen: false,
  openQuickSwitcher: () => set({ isQuickSwitcherOpen: true }),
  closeQuickSwitcher: () => set({ isQuickSwitcherOpen: false }),
  toggleQuickSwitcher: () => set((s) => ({ isQuickSwitcherOpen: !s.isQuickSwitcherOpen })),

  // Folder picker
  isFolderPickerOpen: false,
  openFolderPicker: () => set({ isFolderPickerOpen: true }),
  closeFolderPicker: () => set({ isFolderPickerOpen: false }),

  // Text editor picker
  isTextEditorPickerOpen: false,
  openTextEditorPicker: () => set({ isTextEditorPickerOpen: true }),
  closeTextEditorPicker: () => set({ isTextEditorPickerOpen: false }),

  // Active modal
  activeModal: null,
  openModal: (modalId) => set({ activeModal: modalId }),
  closeModal: () => set({ activeModal: null }),
}));
