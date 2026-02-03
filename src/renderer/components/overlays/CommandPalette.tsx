// ============================================================================
// COMMAND PALETTE COMPONENT
// Premium cinematic command palette with glass morphism
// ============================================================================

import { useState, useEffect, useCallback, useMemo } from 'react';
import { clsx } from 'clsx';
import { Search, Command } from 'lucide-react';
import { useAppStore } from '../../stores/appStore';
import { VIEWS } from '../../../shared/constants';
import { toast } from '../../stores/toastStore';
import { createLogger } from '../../../shared/logger';
import { ErrorBoundary } from '../common/ErrorBoundary';

const logger = createLogger('CommandPalette');

interface CommandItem {
  id: string;
  label: string;
  description?: string;
  category: string;
  shortcut?: string;
  action: () => void;
}

export function CommandPalette(): React.JSX.Element | null {
  const isOpen = useAppStore((s) => s.isCommandPaletteOpen);
  const close = useAppStore((s) => s.closeCommandPalette);
  const setCurrentView = useAppStore((s) => s.setCurrentView);
  const openFolderPicker = useAppStore((s) => s.openFolderPicker);
  const openModal = useAppStore((s) => s.openModal);

  const [search, setSearch] = useState('');
  const [selectedIndex, setSelectedIndex] = useState(0);

  // Define commands
  const commands = useMemo<CommandItem[]>(() => [
    // View commands
    ...VIEWS.map((view, i) => ({
      id: `view-${view}`,
      label: `Go to ${view.charAt(0).toUpperCase() + view.slice(1)}`,
      category: 'Navigation',
      shortcut: `Ctrl+${i + 1}`,
      action: () => {
        setCurrentView(view);
        close();
      },
    })),

    // Terminal commands
    {
      id: 'new-terminal',
      label: 'New Terminal',
      description: 'Start a new Claude session',
      category: 'Terminal',
      shortcut: 'Ctrl+N',
      action: () => {
        openFolderPicker();
        close();
      },
    },

    // Settings
    {
      id: 'open-settings',
      label: 'Open Settings',
      category: 'Settings',
      shortcut: 'Ctrl+,',
      action: () => {
        setCurrentView('settings');
        close();
      },
    },

    // Toggle theme
    {
      id: 'toggle-theme',
      label: 'Toggle Theme',
      description: 'Switch between light and dark mode',
      category: 'Settings',
      action: async () => {
        try {
          const current = await window.goodvibes.getSetting('theme');
          const next = current === 'dark' ? 'light' : 'dark';
          await window.goodvibes.setSetting('theme', next);
          close();
        } catch (error) {
          logger.error('Failed to toggle theme:', error);
          toast.error('Failed to toggle theme');
        }
      },
    },

    // About
    {
      id: 'show-about',
      label: 'About GoodVibes',
      description: 'Show application information',
      category: 'Help',
      action: () => {
        openModal('about');
        close();
      },
    },
  ], [setCurrentView, openFolderPicker, openModal, close]);

  // Filter commands
  const filteredCommands = useMemo(() => {
    if (!search.trim()) return commands;
    const lower = search.toLowerCase();
    return commands.filter(
      (c) =>
        c.label.toLowerCase().includes(lower) ||
        c.description?.toLowerCase().includes(lower) ||
        c.category.toLowerCase().includes(lower)
    );
  }, [commands, search]);

  // Reset selection when search changes
  useEffect(() => {
    setSelectedIndex(0);
  }, [search]);

  // Keyboard navigation
  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        setSelectedIndex((i) => Math.min(i + 1, filteredCommands.length - 1));
        break;
      case 'ArrowUp':
        e.preventDefault();
        setSelectedIndex((i) => Math.max(i - 1, 0));
        break;
      case 'Enter':
        e.preventDefault();
        if (filteredCommands[selectedIndex]) {
          filteredCommands[selectedIndex].action();
        }
        break;
      case 'Escape':
        e.preventDefault();
        close();
        break;
    }
  }, [filteredCommands, selectedIndex, close]);

  // Reset on open
  useEffect(() => {
    if (isOpen) {
      setSearch('');
      setSelectedIndex(0);
    }
  }, [isOpen]);

  if (!isOpen) return null;

  // Group commands by category
  const groupedCommands = filteredCommands.reduce((groups, cmd) => {
    const categoryGroup = groups[cmd.category];
    if (!categoryGroup) {
      groups[cmd.category] = [cmd];
    } else {
      categoryGroup.push(cmd);
    }
    return groups;
  }, {} as Record<string, CommandItem[]>);

  return (
    <div
      className="modal-backdrop-premium items-start pt-[15vh]"
      onClick={close}
    >
      <ErrorBoundary
        fallback={
          <div className="modal-palette-premium">
            <div className="p-8 text-center">
              <p className="text-slate-400">Command Palette encountered an error</p>
              <button onClick={close} className="btn btn-secondary mt-4">
                Close
              </button>
            </div>
          </div>
        }
        onReset={close}
      >
        <div
          className="modal-palette-premium"
          onClick={(e) => e.stopPropagation()}
        >
          {/* Search input */}
          <div className="modal-search-premium">
            <Command className="w-5 h-5 search-icon" />
            <input
              type="text"
              placeholder="Type a command..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              onKeyDown={handleKeyDown}
              autoFocus
            />
            <kbd className="kbd-premium">esc</kbd>
          </div>

          {/* Commands list */}
          <div className="modal-list-premium">
            {Object.entries(groupedCommands).map(([category, cmds]) => (
              <div key={category}>
                <div className="modal-category-header">
                  {category}
                </div>
                {cmds.map((cmd) => {
                  const globalIndex = filteredCommands.indexOf(cmd);
                  return (
                    <button
                      key={cmd.id}
                      onClick={cmd.action}
                      className={clsx(
                        'modal-list-item-premium',
                        globalIndex === selectedIndex && 'selected'
                      )}
                    >
                      <div className="item-icon">
                        <Command className="w-4 h-4" />
                      </div>
                      <div className="item-content">
                        <div className="item-title">{cmd.label}</div>
                        {cmd.description && (
                          <div className="item-subtitle">{cmd.description}</div>
                        )}
                      </div>
                      {cmd.shortcut && (
                        <kbd className="kbd-premium">
                          {cmd.shortcut}
                        </kbd>
                      )}
                    </button>
                  );
                })}
              </div>
            ))}

            {filteredCommands.length === 0 && (
              <div className="py-12 text-center">
                <Search className="w-10 h-10 mx-auto mb-3 text-slate-600" />
                <p className="text-slate-500">No commands found</p>
              </div>
            )}
          </div>

          {/* Footer */}
          <div className="modal-footer-hints">
            <div className="hint-group">
              <span className="hint">
                <kbd className="kbd-premium">↑</kbd>
                <kbd className="kbd-premium">↓</kbd>
                <span className="ml-1">Navigate</span>
              </span>
              <span className="hint">
                <kbd className="kbd-premium">Enter</kbd>
                <span className="ml-1">Execute</span>
              </span>
            </div>
            <span className="hint">
              <kbd className="kbd-premium">Ctrl</kbd>
              <kbd className="kbd-premium">K</kbd>
              <span className="ml-1">Toggle</span>
            </span>
          </div>
        </div>
      </ErrorBoundary>
    </div>
  );
}
