// ============================================================================
// COMMAND PALETTE COMPONENT
// ============================================================================

import { useState, useEffect, useCallback, useMemo } from 'react';
import { clsx } from 'clsx';
import { useAppStore } from '../../stores/appStore';
import { VIEWS } from '../../../shared/constants';

interface Command {
  id: string;
  label: string;
  description?: string;
  category: string;
  shortcut?: string;
  action: () => void;
}

export function CommandPalette() {
  const isOpen = useAppStore((s) => s.isCommandPaletteOpen);
  const close = useAppStore((s) => s.closeCommandPalette);
  const setCurrentView = useAppStore((s) => s.setCurrentView);
  const openFolderPicker = useAppStore((s) => s.openFolderPicker);
  const openModal = useAppStore((s) => s.openModal);

  const [search, setSearch] = useState('');
  const [selectedIndex, setSelectedIndex] = useState(0);

  // Define commands
  const commands = useMemo<Command[]>(() => [
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
        const current = await window.goodvibes.getSetting('theme');
        const next = current === 'dark' ? 'light' : 'dark';
        await window.goodvibes.setSetting('theme', next);
        close();
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
  }, {} as Record<string, Command[]>);

  return (
    <div
      className="fixed inset-0 z-[9999] flex items-start justify-center pt-[20vh] bg-surface-950/80 backdrop-blur-sm"
      onClick={close}
    >
      <div
        className="w-full max-w-lg bg-surface-900 border border-surface-700 rounded-xl shadow-elevation-5 overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Search input */}
        <div className="flex items-center gap-3 px-4 py-3 border-b border-surface-700">
          <svg className="w-5 h-5 text-surface-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
          </svg>
          <input
            type="text"
            placeholder="Type a command..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            onKeyDown={handleKeyDown}
            className="flex-1 bg-transparent text-surface-100 placeholder:text-surface-500 outline-none"
            autoFocus
          />
        </div>

        {/* Commands list */}
        <div className="max-h-80 overflow-y-auto">
          {Object.entries(groupedCommands).map(([category, cmds]) => (
            <div key={category}>
              <div className="px-4 py-2 text-xs font-medium text-surface-500 uppercase tracking-wide">
                {category}
              </div>
              {cmds.map((cmd) => {
                const globalIndex = filteredCommands.indexOf(cmd);
                return (
                  <button
                    key={cmd.id}
                    onClick={cmd.action}
                    className={clsx(
                      'w-full flex items-center justify-between px-4 py-2 text-left transition-colors',
                      globalIndex === selectedIndex
                        ? 'bg-primary-500/20 text-surface-100'
                        : 'text-surface-300 hover:bg-surface-800'
                    )}
                  >
                    <div>
                      <div className="text-sm">{cmd.label}</div>
                      {cmd.description && (
                        <div className="text-xs text-surface-500">{cmd.description}</div>
                      )}
                    </div>
                    {cmd.shortcut && (
                      <kbd className="text-xs text-surface-500 bg-surface-800 px-2 py-0.5 rounded">
                        {cmd.shortcut}
                      </kbd>
                    )}
                  </button>
                );
              })}
            </div>
          ))}

          {filteredCommands.length === 0 && (
            <div className="px-4 py-8 text-center text-surface-500">
              No commands found
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between px-4 py-2 border-t border-surface-700 text-xs text-surface-500">
          <div className="flex gap-4">
            <span><kbd className="px-1.5 py-0.5 bg-surface-800 rounded">↑↓</kbd> Navigate</span>
            <span><kbd className="px-1.5 py-0.5 bg-surface-800 rounded">Enter</kbd> Execute</span>
          </div>
          <span><kbd className="px-1.5 py-0.5 bg-surface-800 rounded">Esc</kbd> Close</span>
        </div>
      </div>
    </div>
  );
}
