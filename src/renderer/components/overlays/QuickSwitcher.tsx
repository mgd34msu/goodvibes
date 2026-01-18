// ============================================================================
// QUICK SWITCHER COMPONENT
// Premium cinematic terminal switcher with glass morphism
// ============================================================================

import { useState, useEffect, useCallback, useMemo } from 'react';
import { clsx } from 'clsx';
import { Terminal, Search } from 'lucide-react';
import { useAppStore } from '../../stores/appStore';
import { useTerminalStore } from '../../stores/terminalStore';

export function QuickSwitcher(): React.JSX.Element | null {
  const isOpen = useAppStore((s) => s.isQuickSwitcherOpen);
  const close = useAppStore((s) => s.closeQuickSwitcher);

  const terminalsMap = useTerminalStore((s) => s.terminals);
  const terminals = useMemo(() => Array.from(terminalsMap.values()), [terminalsMap]);
  const setActiveTerminal = useTerminalStore((s) => s.setActiveTerminal);
  const setCurrentView = useAppStore((s) => s.setCurrentView);

  const [search, setSearch] = useState('');
  const [selectedIndex, setSelectedIndex] = useState(0);

  // Filter terminals
  const filteredTerminals = useMemo(() => {
    if (!search.trim()) return terminals;
    const lower = search.toLowerCase();
    return terminals.filter(
      (t) =>
        t.name.toLowerCase().includes(lower) ||
        t.cwd.toLowerCase().includes(lower)
    );
  }, [terminals, search]);

  // Reset selection when search changes
  useEffect(() => {
    setSelectedIndex(0);
  }, [search]);

  // Keyboard navigation
  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        setSelectedIndex((i) => Math.min(i + 1, filteredTerminals.length - 1));
        break;
      case 'ArrowUp':
        e.preventDefault();
        setSelectedIndex((i) => Math.max(i - 1, 0));
        break;
      case 'Enter':
        e.preventDefault();
        if (filteredTerminals[selectedIndex]) {
          setActiveTerminal(filteredTerminals[selectedIndex].id);
          setCurrentView('terminal');
          close();
        }
        break;
      case 'Escape':
        e.preventDefault();
        close();
        break;
    }
  }, [filteredTerminals, selectedIndex, setActiveTerminal, setCurrentView, close]);

  // Reset on open
  useEffect(() => {
    if (isOpen) {
      setSearch('');
      setSelectedIndex(0);
    }
  }, [isOpen]);

  if (!isOpen) return null;

  return (
    <div
      className="modal-backdrop-premium items-start pt-[15vh]"
      onClick={close}
    >
      <div
        className="modal-palette-premium max-w-md"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Search input */}
        <div className="modal-search-premium">
          <Terminal className="w-5 h-5 search-icon" />
          <input
            type="text"
            placeholder="Search terminals..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            onKeyDown={handleKeyDown}
            autoFocus
          />
          <kbd className="kbd-premium">esc</kbd>
        </div>

        {/* Terminals list */}
        <div className="modal-list-premium max-h-72">
          {filteredTerminals.map((terminal, index) => (
            <button
              key={terminal.id}
              onClick={() => {
                setActiveTerminal(terminal.id);
                setCurrentView('terminal');
                close();
              }}
              className={clsx(
                'modal-list-item-premium',
                index === selectedIndex && 'selected'
              )}
            >
              <div className="item-icon">
                <Terminal className="w-4 h-4" />
              </div>
              <div className="item-content">
                <div className="item-title">{terminal.name}</div>
                <div className="item-subtitle">{terminal.cwd}</div>
              </div>
              {terminal.sessionType === 'subagent' && (
                <span className="px-2 py-0.5 text-xs font-medium rounded-md bg-violet-500/20 text-violet-300 border border-violet-500/30">
                  Subagent
                </span>
              )}
            </button>
          ))}

          {filteredTerminals.length === 0 && (
            <div className="py-12 text-center">
              <Search className="w-10 h-10 mx-auto mb-3 text-slate-600" />
              <p className="text-slate-500">
                {terminals.length === 0 ? 'No terminals open' : 'No matching terminals'}
              </p>
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
              <span className="ml-1">Select</span>
            </span>
          </div>
          <span className="hint">
            <kbd className="kbd-premium">Ctrl</kbd>
            <kbd className="kbd-premium">Tab</kbd>
            <span className="ml-1">Toggle</span>
          </span>
        </div>
      </div>
    </div>
  );
}
