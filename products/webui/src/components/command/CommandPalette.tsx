/**
 * CommandPalette (Ctrl K), design doc "Menus and modals": 640 wide glass over the
 * scrim, a search field on top, results grouped Chats / Go to / Actions /
 * Settings. On a phone it is a full-height sheet. Typing filters the registered
 * commands in the page at once; nothing is sent while typing. A search of three
 * characters or more ends in one more row, "Find what does …": choosing it asks
 * the daemon's `capabilities.find` once, and what it found replaces the row.
 *
 * Keyboard: Up and Down (or Tab and Shift Tab) move, Enter runs, Escape closes the
 * palette and nothing else. Focus stays in the search field (the options are an
 * aria-activedescendant listbox), is trapped inside the palette, and returns to
 * whatever held it before the palette opened.
 */
import { ArrowRight, CornerDownLeft, MessageSquare, Search, Settings, Zap } from 'lucide-react';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { classicCommandIndices } from '@goodvibes/engine/platform/browser/decision-policy';
import { type CommandDef, getCommands, subscribeCommands } from '../../lib/commands';
import { formatError } from '../../lib/errors';
import { invokeOwnerMethod } from '../../lib/goodvibes';
import { formatShortcut } from '../../lib/shortcut-keys';
import {
  buildPaletteSections,
  PALETTE_SECTION_LABELS,
  type PaletteSection,
} from '../../lib/command-groups';
import { PHONE_QUERY, useMediaQuery, useModalFocus, useOverlayLayer, useTopLayerEscape } from '../ui/overlay';
import '../../styles/components/command.css';

interface CommandPaletteProps {
  open: boolean;
  onClose: () => void;
  /** The search it opens on ("/schedule" from the composer's slash command); empty by default. */
  initialQuery?: string;
  /**
   * Open a capability by id (its form, then `capabilities.run`). With it, a search offers one more row: find what
   * does the words typed, asked of the daemon's `capabilities.find` when that row is chosen (never while typing).
   */
  onRunCapability?: (id: string) => void;
}

/** What `capabilities.find` answered for the words typed. */
interface FoundAnswer {
  readonly need: string;
  readonly status: 'reading' | 'ready' | 'failed';
  readonly found: readonly { readonly id: string; readonly does: string; readonly runsIn: string }[];
  readonly reason?: string;
}

const FIND_ROW = 'found.ask';

function readFound(output: unknown): FoundAnswer['found'] {
  const list = output && typeof output === 'object' ? (output as { capabilities?: unknown }).capabilities : undefined;
  return (Array.isArray(list) ? list : []).flatMap((entry: unknown) => {
    const row = entry && typeof entry === 'object' ? entry as Record<string, unknown> : {};
    return typeof row.id === 'string' && typeof row.does === 'string'
      ? [{ id: row.id, does: row.does, runsIn: typeof row.runsIn === 'string' ? row.runsIn : 'daemon' }]
      : [];
  });
}

const SECTION_ICONS: Record<PaletteSection, ReactNode> = {
  chats: <MessageSquare aria-hidden="true" />,
  goto: <ArrowRight aria-hidden="true" />,
  actions: <Zap aria-hidden="true" />,
  settings: <Settings aria-hidden="true" />,
};

export function CommandPalette({ open, onClose, initialQuery = '', onRunCapability }: CommandPaletteProps) {
  const [query, setQuery] = useState('');
  const [commands, setCommands] = useState(getCommands);
  const [answer, setAnswer] = useState<FoundAnswer | null>(null);
  const [activeIndex, setActiveIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const phone = useMediaQuery(PHONE_QUERY);
  useModalFocus(open, panelRef, inputRef);
  const isTop = useOverlayLayer(open);
  useTopLayerEscape(open, isTop, onClose);

  // Clear before the next visible frame, including a close/open in quick succession.
  useLayoutEffect(() => {
    if (!open) { setQuery(''); setActiveIndex(0); return; }
    if (initialQuery) { setQuery(initialQuery); setActiveIndex(0); }
  }, [open, initialQuery]);

  useEffect(() => subscribeCommands(() => setCommands(getCommands())), []);

  const searching = query.trim().length > 0;
  const need = query.trim();
  /** Ask the daemon what does the words typed: one request, when the row is chosen. */
  const findNeed = useCallback(() => {
    if (!need) return;
    setAnswer({ need, status: 'reading', found: [] });
    invokeOwnerMethod('capabilities.find', { need }).then(
      (output) => setAnswer((now) => (now?.need === need ? { need, status: 'ready', found: readFound(output) } : now)),
      (error: unknown) => setAnswer((now) => (now?.need === need ? { need, status: 'failed', found: [], reason: formatError(error) } : now)),
    );
  }, [need]);
  // The rows of the find: the one that asks, then what it found (each opens its form), or why nothing came.
  const foundRows = useMemo((): CommandDef[] => {
    if (!onRunCapability || need.length < 3) return [];
    if (!answer || answer.need !== need) {
      return [{ id: FIND_ROW, title: `Find what does “${need}”`, group: 'system', run: findNeed }];
    }
    if (answer.status === 'reading') return [{ id: 'found.reading', title: 'Finding…', group: 'system', run: () => undefined }];
    if (answer.status === 'failed') return [{ id: 'found.failed', title: `Could not find: ${answer.reason ?? 'no reason was given'}`, group: 'system', run: findNeed }];
    if (answer.found.length === 0) return [{ id: 'found.none', title: `Nothing found for “${need}”`, group: 'system', run: () => undefined }];
    return answer.found.map((found) => ({
      id: `found.${found.id}`,
      title: `${found.does.charAt(0).toUpperCase()}${found.does.slice(1)}${found.runsIn === 'daemon' ? '' : ' (in the terminal app or the Agent)'}`,
      group: 'system' as const,
      run: () => onRunCapability(found.id),
    }));
  }, [answer, findNeed, need, onRunCapability]);
  // Matching runs here on every keystroke: title, id, group and keywords, no request.
  const visibleCommands = useMemo(
    () => (searching ? [...classicCommandIndices(query, commands).map((index) => commands[index]!), ...foundRows] : commands),
    [commands, query, searching, foundRows],
  );
  const sections = useMemo(() => buildPaletteSections(visibleCommands), [visibleCommands]);
  // The keyboard order is the on-screen order: section by section.
  const ordered = useMemo(() => sections.flatMap((group) => group.commands), [sections]);
  // Each command's keyboard position, so a row knows whether it is the active one.
  const orderIndex = useMemo(() => new Map(ordered.map((cmd, index) => [cmd, index])), [ordered]);

  useEffect(() => {
    if (activeIndex < 0 || activeIndex >= ordered.length) setActiveIndex(Math.max(0, Math.min(activeIndex, ordered.length - 1)));
  }, [ordered.length, activeIndex]);

  useEffect(() => {
    const active = listRef.current?.querySelector('[aria-selected="true"]');
    if (active && typeof (active as HTMLElement).scrollIntoView === 'function') {
      (active as HTMLElement).scrollIntoView({ block: 'nearest' });
    }
  }, [activeIndex]);

  const runCommand = useCallback(
    (cmd: CommandDef) => {
      if (!open || !ordered.includes(cmd)) return;
      // The find's own rows stay in the palette: asking fills it with what was found.
      if (cmd.id === FIND_ROW || cmd.id === 'found.failed') { cmd.run(); return; }
      if (cmd.id === 'found.reading' || cmd.id === 'found.none') return;
      onClose();
      cmd.run();
    },
    [onClose, open, ordered],
  );

  const onKeyDown = useCallback(
    (event: KeyboardEvent<HTMLDivElement>) => {
      switch (event.key) {
        case 'Escape':
          // Closes the palette only: never reaches the view (a running turn) below.
          event.preventDefault();
          event.stopPropagation();
          onClose();
          return;
        case 'ArrowDown':
          event.preventDefault();
          setActiveIndex((i) => Math.max(0, Math.min(i + 1, ordered.length - 1)));
          return;
        case 'ArrowUp':
          event.preventDefault();
          setActiveIndex((i) => Math.max(i - 1, 0));
          return;
        case 'Home':
          if (event.target === inputRef.current && query) return;
          event.preventDefault();
          setActiveIndex(0);
          return;
        case 'End':
          if (event.target === inputRef.current && query) return;
          event.preventDefault();
          setActiveIndex(Math.max(0, ordered.length - 1));
          return;
        case 'Enter': {
          if (event.target instanceof Element && event.target.closest('button')) return;
          event.preventDefault();
          const cmd = ordered[activeIndex];
          if (cmd) runCommand(cmd);
          return;
        }
        case 'Tab':
          if (!ordered.length) return;
          // Focus stays in the search field; Tab steps through the results.
          event.preventDefault();
          setActiveIndex((i) => (event.shiftKey ? Math.max(i - 1, 0) : Math.min(i + 1, ordered.length - 1)));
          return;
        default:
      }
    },
    [activeIndex, ordered, onClose, query, runCommand],
  );

  if (!open || typeof document === 'undefined') return null;

  const activeCommand = ordered[activeIndex];

  return createPortal(
    <div className="gv-overlay cmd-overlay" data-gv-layer="">
      <div className="scrim" role="presentation" aria-hidden="true" onClick={onClose} />
      <div
        ref={panelRef}
        className={['glass', 'cmd-palette', phone ? 'cmd-palette--sheet' : ''].filter(Boolean).join(' ')}
        role="dialog"
        aria-modal="true"
        aria-label="Command palette"
        tabIndex={-1}
        onKeyDown={onKeyDown}
      >
        {phone && <div className="gv-sheet__grabber" aria-hidden="true" />}
        <div className="cmd-search">
          <Search className="cmd-search__icon" aria-hidden="true" />
          <input
            ref={inputRef}
            className="cmd-input"
            type="text"
            placeholder="Search chats, places, actions and settings"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setActiveIndex(0);
            }}
            aria-label="Search commands"
            aria-autocomplete="list"
            aria-controls="cmd-listbox"
            aria-activedescendant={activeCommand ? `cmd-item-${activeCommand.id}` : undefined}
            autoComplete="off"
            spellCheck={false}
          />
          {phone && (
            <button type="button" className="cmd-search__cancel" onClick={onClose}>
              Cancel
            </button>
          )}
        </div>

        {ordered.length === 0 ? (
          <p className="cmd-empty" role="status">{searching ? `No results for “${query.trim()}”` : 'No commands available'}</p>
        ) : (
          <div ref={listRef} id="cmd-listbox" className="cmd-list" role="listbox" aria-label={searching ? 'Matching commands' : 'Browse all commands'}>
            {sections.map(({ section, commands }) => (
              <div key={section} className="cmd-group" role="group" aria-labelledby={`cmd-group-label-${section}`}>
                <div id={`cmd-group-label-${section}`} className="cmd-group-label" role="presentation">
                  {PALETTE_SECTION_LABELS[section]}
                </div>
                {commands.map((cmd) => {
                  const index = orderIndex.get(cmd) ?? -1;
                  const isActive = index === activeIndex;
                  return (
                    <div
                      key={cmd.id}
                      id={`cmd-item-${cmd.id}`}
                      className={isActive ? 'cmd-item cmd-item--active' : 'cmd-item'}
                      role="option"
                      aria-selected={isActive}
                      onClick={() => runCommand(cmd)}
                      onMouseMove={() => {
                        if (!isActive) setActiveIndex(index);
                      }}
                    >
                      <span className="cmd-item-icon">{SECTION_ICONS[section]}</span>
                      <span className="cmd-item-title">{cmd.title}</span>
                      {cmd.shortcut && !phone && <kbd className="cmd-item-kbd">{formatShortcut(cmd.shortcut)}</kbd>}
                    </div>
                  );
                })}
              </div>
            ))}
          </div>
        )}

        {!phone && (
          <div className="cmd-footer" aria-hidden="true">
            <span><kbd>↑</kbd><kbd>↓</kbd> to move</span>
            <span><kbd><CornerDownLeft /></kbd> to open</span>
            <span><kbd>Esc</kbd> to close</span>
          </div>
        )}
      </div>
    </div>,
    document.body,
  );
}
