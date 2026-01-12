// ============================================================================
// KEYBOARD SHORTCUTS HOOK
// Global shortcut registry with conflict detection and customization
// ============================================================================

import { useEffect, useCallback, useMemo } from 'react';
import { create } from 'zustand';
import { useAppStore } from '../stores/appStore';
import { useTerminalStore } from '../stores/terminalStore';
import { VIEWS, type ViewName } from '../../shared/constants';

// ============================================================================
// Types
// ============================================================================

export interface KeyBinding {
  key: string;
  ctrlKey?: boolean;
  shiftKey?: boolean;
  altKey?: boolean;
  metaKey?: boolean;
}

export interface ShortcutDefinition {
  id: string;
  label: string;
  description: string;
  category: ShortcutCategory;
  binding: KeyBinding;
  action: () => void;
  enabled?: boolean;
  /** If true, works even in input fields */
  global?: boolean;
}

export type ShortcutCategory =
  | 'navigation'
  | 'terminal'
  | 'views'
  | 'overlays'
  | 'editing'
  | 'general';

export interface ShortcutConflict {
  shortcutId: string;
  conflictingId: string;
  binding: KeyBinding;
}

// ============================================================================
// Shortcut Registry Store
// ============================================================================

interface ShortcutRegistryState {
  shortcuts: Map<string, ShortcutDefinition>;
  customBindings: Map<string, KeyBinding>;
  isHelpOpen: boolean;

  register: (shortcut: ShortcutDefinition) => void;
  unregister: (id: string) => void;
  setCustomBinding: (id: string, binding: KeyBinding) => void;
  resetBinding: (id: string) => void;
  resetAllBindings: () => void;
  openHelp: () => void;
  closeHelp: () => void;
  toggleHelp: () => void;

  getEffectiveBinding: (id: string) => KeyBinding | undefined;
  findConflicts: () => ShortcutConflict[];
  getShortcutsByCategory: () => Map<ShortcutCategory, ShortcutDefinition[]>;
}

export const useShortcutRegistry = create<ShortcutRegistryState>((set, get) => ({
  shortcuts: new Map(),
  customBindings: new Map(),
  isHelpOpen: false,

  register: (shortcut) => {
    set((state) => {
      const newShortcuts = new Map(state.shortcuts);
      newShortcuts.set(shortcut.id, shortcut);
      return { shortcuts: newShortcuts };
    });
  },

  unregister: (id) => {
    set((state) => {
      const newShortcuts = new Map(state.shortcuts);
      newShortcuts.delete(id);
      return { shortcuts: newShortcuts };
    });
  },

  setCustomBinding: (id, binding) => {
    set((state) => {
      const newBindings = new Map(state.customBindings);
      newBindings.set(id, binding);
      // Persist to localStorage
      try {
        const stored = Object.fromEntries(newBindings);
        localStorage.setItem('goodvibes-shortcuts', JSON.stringify(stored));
      } catch (e) {
        console.error('Failed to save shortcuts:', e);
      }
      return { customBindings: newBindings };
    });
  },

  resetBinding: (id) => {
    set((state) => {
      const newBindings = new Map(state.customBindings);
      newBindings.delete(id);
      // Persist to localStorage
      try {
        const stored = Object.fromEntries(newBindings);
        localStorage.setItem('goodvibes-shortcuts', JSON.stringify(stored));
      } catch (e) {
        console.error('Failed to save shortcuts:', e);
      }
      return { customBindings: newBindings };
    });
  },

  resetAllBindings: () => {
    set({ customBindings: new Map() });
    try {
      localStorage.removeItem('goodvibes-shortcuts');
    } catch (e) {
      console.error('Failed to clear shortcuts:', e);
    }
  },

  openHelp: () => set({ isHelpOpen: true }),
  closeHelp: () => set({ isHelpOpen: false }),
  toggleHelp: () => set((s) => ({ isHelpOpen: !s.isHelpOpen })),

  getEffectiveBinding: (id) => {
    const { shortcuts, customBindings } = get();
    return customBindings.get(id) || shortcuts.get(id)?.binding;
  },

  findConflicts: () => {
    const { shortcuts, customBindings } = get();
    const conflicts: ShortcutConflict[] = [];
    const bindingMap = new Map<string, string>();

    for (const [id, shortcut] of shortcuts) {
      const binding = customBindings.get(id) || shortcut.binding;
      const key = bindingToString(binding);

      if (bindingMap.has(key)) {
        const existingId = bindingMap.get(key);
        if (existingId) {
          conflicts.push({
            shortcutId: id,
            conflictingId: existingId,
            binding,
          });
        }
      } else {
        bindingMap.set(key, id);
      }
    }

    return conflicts;
  },

  getShortcutsByCategory: () => {
    const { shortcuts } = get();
    const byCategory = new Map<ShortcutCategory, ShortcutDefinition[]>();

    for (const shortcut of shortcuts.values()) {
      const existing = byCategory.get(shortcut.category) || [];
      existing.push(shortcut);
      byCategory.set(shortcut.category, existing);
    }

    return byCategory;
  },
}));

// ============================================================================
// Helper Functions
// ============================================================================

export function bindingToString(binding: KeyBinding): string {
  const parts: string[] = [];
  if (binding.ctrlKey) parts.push('Ctrl');
  if (binding.altKey) parts.push('Alt');
  if (binding.shiftKey) parts.push('Shift');
  if (binding.metaKey) parts.push('Meta');
  parts.push(normalizeKey(binding.key));
  return parts.join('+');
}

export function bindingToDisplayString(binding: KeyBinding): string {
  const parts: string[] = [];
  if (binding.ctrlKey) parts.push('Ctrl');
  if (binding.altKey) parts.push('Alt');
  if (binding.shiftKey) parts.push('Shift');
  if (binding.metaKey) parts.push('Cmd');
  parts.push(formatKeyForDisplay(binding.key));
  return parts.join(' + ');
}

function normalizeKey(key: string): string {
  return key.toLowerCase();
}

function formatKeyForDisplay(key: string): string {
  const displayNames: Record<string, string> = {
    ' ': 'Space',
    arrowup: 'Up',
    arrowdown: 'Down',
    arrowleft: 'Left',
    arrowright: 'Right',
    escape: 'Esc',
    tab: 'Tab',
    enter: 'Enter',
    backspace: 'Backspace',
    delete: 'Delete',
  };
  return displayNames[key.toLowerCase()] || key.toUpperCase();
}

function matchesBinding(e: KeyboardEvent, binding: KeyBinding): boolean {
  return (
    e.key.toLowerCase() === binding.key.toLowerCase() &&
    !!e.ctrlKey === !!binding.ctrlKey &&
    !!e.shiftKey === !!binding.shiftKey &&
    !!e.altKey === !!binding.altKey &&
    !!e.metaKey === !!binding.metaKey
  );
}

// ============================================================================
// Category Labels
// ============================================================================

export const CATEGORY_LABELS: Record<ShortcutCategory, string> = {
  navigation: 'Navigation',
  terminal: 'Terminal',
  views: 'Views',
  overlays: 'Overlays & Palettes',
  editing: 'Editing',
  general: 'General',
};

export const CATEGORY_ORDER: ShortcutCategory[] = [
  'navigation',
  'views',
  'terminal',
  'overlays',
  'editing',
  'general',
];

// ============================================================================
// Main Hook
// ============================================================================

export function useKeyboardShortcuts() {
  const setCurrentView = useAppStore((s) => s.setCurrentView);
  const toggleCommandPalette = useAppStore((s) => s.toggleCommandPalette);
  const toggleQuickSwitcher = useAppStore((s) => s.toggleQuickSwitcher);
  const openFolderPicker = useAppStore((s) => s.openFolderPicker);

  const switchToNextTab = useTerminalStore((s) => s.switchToNextTab);
  const switchToPrevTab = useTerminalStore((s) => s.switchToPrevTab);
  const setZoomLevel = useTerminalStore((s) => s.setZoomLevel);
  const zoomLevel = useTerminalStore((s) => s.zoomLevel);

  const { register, shortcuts, customBindings, toggleHelp } = useShortcutRegistry();

  // Load custom bindings from localStorage
  useEffect(() => {
    try {
      const stored = localStorage.getItem('goodvibes-shortcuts');
      if (stored) {
        const parsed = JSON.parse(stored) as Record<string, KeyBinding>;
        const bindings = new Map(Object.entries(parsed));
        useShortcutRegistry.setState({ customBindings: bindings });
      }
    } catch (e) {
      console.error('Failed to load shortcuts:', e);
    }
  }, []);

  // Register all shortcuts
  useEffect(() => {
    const shortcutsToRegister: ShortcutDefinition[] = [
      // Navigation
      {
        id: 'new-terminal',
        label: 'New Terminal',
        description: 'Open a new terminal session',
        category: 'terminal',
        binding: { key: 'n', ctrlKey: true },
        action: openFolderPicker,
      },
      {
        id: 'next-tab',
        label: 'Next Tab',
        description: 'Switch to the next terminal tab',
        category: 'terminal',
        binding: { key: 'Tab', ctrlKey: true },
        action: switchToNextTab,
      },
      {
        id: 'prev-tab',
        label: 'Previous Tab',
        description: 'Switch to the previous terminal tab',
        category: 'terminal',
        binding: { key: 'Tab', ctrlKey: true, shiftKey: true },
        action: switchToPrevTab,
      },
      {
        id: 'zoom-in',
        label: 'Zoom In',
        description: 'Increase terminal font size',
        category: 'terminal',
        binding: { key: '=', ctrlKey: true },
        action: () => setZoomLevel(zoomLevel + 10),
      },
      {
        id: 'zoom-out',
        label: 'Zoom Out',
        description: 'Decrease terminal font size',
        category: 'terminal',
        binding: { key: '-', ctrlKey: true },
        action: () => setZoomLevel(zoomLevel - 10),
      },
      {
        id: 'zoom-reset',
        label: 'Reset Zoom',
        description: 'Reset terminal font size to default',
        category: 'terminal',
        binding: { key: '0', ctrlKey: true },
        action: () => setZoomLevel(100),
      },

      // Overlays
      {
        id: 'command-palette',
        label: 'Command Palette',
        description: 'Open the command palette',
        category: 'overlays',
        binding: { key: 'p', ctrlKey: true, shiftKey: true },
        action: toggleCommandPalette,
        global: true,
      },
      {
        id: 'quick-switcher',
        label: 'Quick Switcher',
        description: 'Open the quick switcher',
        category: 'overlays',
        binding: { key: 'k', ctrlKey: true },
        action: toggleQuickSwitcher,
        global: true,
      },
      {
        id: 'shortcuts-help',
        label: 'Keyboard Shortcuts',
        description: 'Show all keyboard shortcuts',
        category: 'overlays',
        binding: { key: '/', ctrlKey: true },
        action: toggleHelp,
        global: true,
      },

      // Close overlays
      {
        id: 'close-overlay',
        label: 'Close Overlay',
        description: 'Close the current overlay or modal',
        category: 'overlays',
        binding: { key: 'Escape' },
        action: () => {
          const { isCommandPaletteOpen, isQuickSwitcherOpen, activeModal, closeCommandPalette, closeQuickSwitcher, closeModal } = useAppStore.getState();
          const { isHelpOpen, closeHelp } = useShortcutRegistry.getState();

          if (isHelpOpen) {
            closeHelp();
          } else if (isCommandPaletteOpen) {
            closeCommandPalette();
          } else if (isQuickSwitcherOpen) {
            closeQuickSwitcher();
          } else if (activeModal) {
            closeModal();
          }
        },
        global: true,
      },
    ];

    // View shortcuts (Ctrl+1 through Ctrl+9)
    VIEWS.forEach((view, index) => {
      if (index < 9) {
        shortcutsToRegister.push({
          id: `view-${view}`,
          label: `Go to ${formatViewName(view)}`,
          description: `Switch to the ${formatViewName(view)} view`,
          category: 'views',
          binding: { key: String(index + 1), ctrlKey: true },
          action: () => setCurrentView(view),
        });
      }
    });

    // Register all
    shortcutsToRegister.forEach(register);

    // Cleanup not needed as shortcuts persist
  }, [
    register,
    openFolderPicker,
    switchToNextTab,
    switchToPrevTab,
    setZoomLevel,
    zoomLevel,
    toggleCommandPalette,
    toggleQuickSwitcher,
    toggleHelp,
    setCurrentView,
  ]);

  // Handle keydown events
  const handleKeyDown = useCallback((e: KeyboardEvent) => {
    // Skip if in input/textarea (unless shortcut is global)
    const target = e.target as HTMLElement;
    const isInput = target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable;

    for (const [id, shortcut] of shortcuts) {
      if (!shortcut.enabled && shortcut.enabled !== undefined) continue;

      // Skip non-global shortcuts when in input
      if (isInput && !shortcut.global) continue;

      const binding = customBindings.get(id) || shortcut.binding;

      if (matchesBinding(e, binding)) {
        e.preventDefault();
        shortcut.action();
        return;
      }
    }
  }, [shortcuts, customBindings]);

  useEffect(() => {
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [handleKeyDown]);
}

// ============================================================================
// Utility Functions
// ============================================================================

function formatViewName(view: ViewName): string {
  return view.charAt(0).toUpperCase() + view.slice(1);
}

// ============================================================================
// Hook for Registering Custom Shortcuts
// ============================================================================

export function useRegisterShortcut(shortcut: ShortcutDefinition) {
  const { register, unregister } = useShortcutRegistry();

  useEffect(() => {
    register(shortcut);
    return () => unregister(shortcut.id);
  }, [shortcut, register, unregister]);
}

// ============================================================================
// Hook for Shortcut State
// ============================================================================

export function useShortcutState() {
  const shortcuts = useShortcutRegistry((s) => s.shortcuts);
  const customBindings = useShortcutRegistry((s) => s.customBindings);
  const isHelpOpen = useShortcutRegistry((s) => s.isHelpOpen);
  const openHelp = useShortcutRegistry((s) => s.openHelp);
  const closeHelp = useShortcutRegistry((s) => s.closeHelp);
  const toggleHelp = useShortcutRegistry((s) => s.toggleHelp);
  const setCustomBinding = useShortcutRegistry((s) => s.setCustomBinding);
  const resetBinding = useShortcutRegistry((s) => s.resetBinding);
  const resetAllBindings = useShortcutRegistry((s) => s.resetAllBindings);
  const findConflicts = useShortcutRegistry((s) => s.findConflicts);
  const getShortcutsByCategory = useShortcutRegistry((s) => s.getShortcutsByCategory);
  const getEffectiveBinding = useShortcutRegistry((s) => s.getEffectiveBinding);

  const shortcutsByCategory = useMemo(() => getShortcutsByCategory(), [getShortcutsByCategory, shortcuts]);
  const conflicts = useMemo(() => findConflicts(), [findConflicts, customBindings, shortcuts]);

  return {
    shortcuts,
    customBindings,
    shortcutsByCategory,
    conflicts,
    isHelpOpen,
    openHelp,
    closeHelp,
    toggleHelp,
    setCustomBinding,
    resetBinding,
    resetAllBindings,
    getEffectiveBinding,
  };
}
