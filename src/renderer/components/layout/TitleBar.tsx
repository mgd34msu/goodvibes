// ============================================================================
// TITLE BAR COMPONENT
// Modern, polished design with glass morphism and micro-interactions
// ============================================================================

import { useState, useRef, useEffect, useCallback } from 'react';
import { clsx } from 'clsx';
import {
  Terminal,
  List,
  BarChart3,
  FileText,
  Library,
  Settings,
  Bell,
  Webhook,
  Server,
  Users,
  Brain,
  Sparkles,
  FolderKanban,
  ChevronDown,
} from 'lucide-react';
import { useAppStore } from '../../stores/appStore';
import { NAV_GROUPS, type ViewName, type NavGroup } from '../../../shared/constants';
import { toast } from '../../stores/toastStore';
import { createLogger } from '../../../shared/logger';
import appIcon from '../../assets/icon.png';

const logger = createLogger('TitleBar');

const ICON_SIZE = 16;
const ICON_CLASS = "w-4 h-4 flex-shrink-0 transition-transform duration-150";

const VIEW_ICONS: Record<ViewName, React.ReactNode> = {
  terminal: <Terminal className={ICON_CLASS} size={ICON_SIZE} aria-hidden="true" />,
  sessions: <List className={ICON_CLASS} size={ICON_SIZE} aria-hidden="true" />,
  analytics: <BarChart3 className={ICON_CLASS} size={ICON_SIZE} aria-hidden="true" />,
  tasks: <FileText className={ICON_CLASS} size={ICON_SIZE} aria-hidden="true" />,
  knowledge: <Library className={ICON_CLASS} size={ICON_SIZE} aria-hidden="true" />,
  settings: <Settings className={ICON_CLASS} size={ICON_SIZE} aria-hidden="true" />,
  hooks: <Webhook className={ICON_CLASS} size={ICON_SIZE} aria-hidden="true" />,
  mcp: <Server className={ICON_CLASS} size={ICON_SIZE} aria-hidden="true" />,
  agents: <Users className={ICON_CLASS} size={ICON_SIZE} aria-hidden="true" />,
  memory: <Brain className={ICON_CLASS} size={ICON_SIZE} aria-hidden="true" />,
  skills: <Sparkles className={ICON_CLASS} size={ICON_SIZE} aria-hidden="true" />,
  commands: <Terminal className={ICON_CLASS} size={ICON_SIZE} aria-hidden="true" />,
  // Phase 9-12 views
  projects: <FolderKanban className={ICON_CLASS} size={ICON_SIZE} aria-hidden="true" />,
};

const VIEW_LABELS: Record<ViewName, string> = {
  terminal: 'Terminal',
  sessions: 'Sessions',
  analytics: 'Analytics',
  tasks: 'Tasks',
  knowledge: 'Knowledge',
  settings: 'Settings',
  hooks: 'Hooks',
  mcp: 'MCP',
  agents: 'Agents',
  memory: 'Memory',
  skills: 'Skills',
  commands: 'Commands',
  // Phase 9-12 views
  projects: 'Projects',
};

// ============================================================================
// NAV DROPDOWN COMPONENT
// ============================================================================

interface NavDropdownProps {
  group: NavGroup;
  currentView: ViewName;
  onSelectView: (view: ViewName) => void;
}

function NavDropdown({ group, currentView, onSelectView }: NavDropdownProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [focusedIndex, setFocusedIndex] = useState(-1);
  const containerRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  // Check if current view is in this group
  const isActive = group.views.includes(currentView);

  // Close on outside click
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setIsOpen(false);
        setFocusedIndex(-1);
      }
    };

    if (isOpen) {
      document.addEventListener('mousedown', handleClickOutside);
    }
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [isOpen]);

  // Handle keyboard navigation
  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (!isOpen) {
      if (e.key === 'Enter' || e.key === ' ' || e.key === 'ArrowDown') {
        e.preventDefault();
        setIsOpen(true);
        setFocusedIndex(0);
      }
      return;
    }

    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        setFocusedIndex((prev) => Math.min(prev + 1, group.views.length - 1));
        break;
      case 'ArrowUp':
        e.preventDefault();
        setFocusedIndex((prev) => Math.max(prev - 1, 0));
        break;
      case 'Enter':
      case ' ':
        e.preventDefault();
        if (focusedIndex >= 0 && focusedIndex < group.views.length) {
          const selectedView = group.views[focusedIndex];
          if (selectedView) {
            onSelectView(selectedView);
            setIsOpen(false);
            setFocusedIndex(-1);
            buttonRef.current?.focus();
          }
        }
        break;
      case 'Escape':
        e.preventDefault();
        setIsOpen(false);
        setFocusedIndex(-1);
        buttonRef.current?.focus();
        break;
      case 'Tab':
        setIsOpen(false);
        setFocusedIndex(-1);
        break;
      case 'Home':
        e.preventDefault();
        setFocusedIndex(0);
        break;
      case 'End':
        e.preventDefault();
        setFocusedIndex(group.views.length - 1);
        break;
    }
  }, [isOpen, focusedIndex, group.views, onSelectView]);

  // Focus the menu item when focusedIndex changes
  useEffect(() => {
    if (isOpen && focusedIndex >= 0 && menuRef.current) {
      const items = menuRef.current.querySelectorAll('[role="menuitem"]');
      const focusedItem = items[focusedIndex] as HTMLElement;
      focusedItem?.focus();
    }
  }, [isOpen, focusedIndex]);

  const handleToggle = () => {
    setIsOpen(!isOpen);
    if (!isOpen) {
      setFocusedIndex(0);
    } else {
      setFocusedIndex(-1);
    }
  };

  const handleItemClick = (view: ViewName) => {
    onSelectView(view);
    setIsOpen(false);
    setFocusedIndex(-1);
    buttonRef.current?.focus();
  };

  return (
    <div ref={containerRef} className="relative">
      <button
        ref={buttonRef}
        onClick={handleToggle}
        onKeyDown={handleKeyDown}
        aria-haspopup="menu"
        aria-expanded={isOpen}
        className={clsx(
          'group flex items-center gap-1.5 px-3.5 py-2 text-sm font-medium rounded-xl',
          'transition-all duration-200 ease-out',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500/50 focus-visible:ring-offset-1 focus-visible:ring-offset-surface-900',
          isActive
            ? 'bg-gradient-to-b from-primary-500 to-primary-600 text-white shadow-lg shadow-primary-600/30 hover:shadow-xl hover:shadow-primary-500/40 hover:from-primary-400 hover:to-primary-500 active:from-primary-600 active:to-primary-700 active:shadow-md'
            : isOpen
              ? 'bg-surface-800/90 text-surface-100 shadow-md'
              : 'text-surface-400 hover:text-surface-100 hover:bg-gradient-to-b hover:from-surface-700/80 hover:to-surface-800/80 hover:shadow-sm active:bg-surface-800 active:shadow-none'
        )}
      >
        <span className="transition-transform duration-150 group-hover:scale-[1.02]">{group.label}</span>
        <ChevronDown
          className={clsx(
            'w-3.5 h-3.5 transition-all duration-200',
            isOpen ? 'rotate-180 text-current' : 'group-hover:translate-y-0.5'
          )}
          aria-hidden="true"
        />
      </button>

      {isOpen && (
        <div
          ref={menuRef}
          role="menu"
          aria-label={`${group.label} submenu`}
          onKeyDown={handleKeyDown}
          className={clsx(
            'absolute left-0 top-full mt-2 min-w-[200px]',
            'bg-surface-900/95 backdrop-blur-xl',
            'border border-surface-700/60 rounded-xl',
            'shadow-elevation-5 shadow-black/40',
            'overflow-hidden z-[9999]',
            'animate-slide-down',
            'ring-1 ring-white/5'
          )}
        >
          <div className="p-1.5">
            {group.views.map((view, index) => (
              <button
                key={view}
                role="menuitem"
                tabIndex={focusedIndex === index ? 0 : -1}
                onClick={() => handleItemClick(view)}
                className={clsx(
                  'group/item w-full flex items-center gap-3 px-3 py-2.5 text-sm text-left rounded-lg',
                  'transition-all duration-150',
                  currentView === view
                    ? 'bg-gradient-to-r from-primary-500/20 to-primary-600/10 text-primary-300 shadow-sm shadow-primary-500/10'
                    : focusedIndex === index
                      ? 'bg-surface-800/80 text-surface-100'
                      : 'text-surface-300 hover:bg-surface-800/60 hover:text-surface-100 active:bg-surface-700/80'
                )}
              >
                <span className={clsx(
                  'transition-all duration-150',
                  currentView === view
                    ? 'text-primary-400'
                    : 'text-surface-500 group-hover/item:text-surface-300 group-hover/item:scale-110'
                )}>
                  {VIEW_ICONS[view]}
                </span>
                <span className="font-medium">{VIEW_LABELS[view]}</span>
                {currentView === view && (
                  <span className="ml-auto w-1.5 h-1.5 rounded-full bg-primary-400 shadow-sm shadow-primary-400/50" />
                )}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// ============================================================================
// TITLE BAR COMPONENT
// ============================================================================

export function TitleBar() {
  const currentView = useAppStore((s) => s.currentView);
  const setCurrentView = useAppStore((s) => s.setCurrentView);

  return (
    <header className={clsx(
      'flex items-center h-[var(--titlebar-height)]',
      'bg-gradient-to-b from-surface-900 via-surface-900/98 to-surface-900/95',
      'backdrop-blur-xl',
      'border-b border-surface-800/60',
      'shadow-lg shadow-black/20',
      'relative z-[9999]'
    )}>
      {/* Subtle top highlight for depth */}
      <div className="absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-surface-700/50 to-transparent" />

      {/* Logo area - more distinctive */}
      <div className="flex items-center gap-3 px-5 drag-region group">
        <div className="relative">
          <img
            src={appIcon}
            alt="GoodVibes"
            className="w-8 h-8 rounded-xl shadow-md shadow-black/30 ring-1 ring-white/10 transition-transform duration-200 group-hover:scale-105"
          />
          {/* Subtle glow effect on hover */}
          <div className="absolute inset-0 rounded-xl bg-primary-500/0 group-hover:bg-primary-500/10 transition-colors duration-300" />
        </div>
        <div className="flex flex-col">
          <span className="text-sm font-bold text-surface-100 tracking-tight leading-none">
            GoodVibes
          </span>
          <span className="text-[10px] font-medium text-surface-500 tracking-wider uppercase leading-none mt-0.5">
            Studio
          </span>
        </div>
      </div>

      {/* Separator */}
      <div className="w-px h-6 bg-gradient-to-b from-transparent via-surface-700/60 to-transparent mx-2" />

      {/* Navigation dropdowns */}
      <nav className="flex items-center gap-1.5 px-3 no-drag flex-1" role="navigation" aria-label="Main navigation">
        {NAV_GROUPS.map((group) => (
          <NavDropdown
            key={group.id}
            group={group}
            currentView={currentView}
            onSelectView={setCurrentView}
          />
        ))}
      </nav>

      {/* Right side actions */}
      <div className="flex items-center gap-2 px-4 no-drag">
        <NotificationBell />
      </div>
    </header>
  );
}

// ============================================================================
// NOTIFICATION BELL COMPONENT
// ============================================================================

interface Notification {
  id: string;
  type: 'info' | 'warning' | 'error' | 'success';
  title: string;
  message: string;
  timestamp: string;
  read: boolean;
}

function NotificationBell() {
  const [unreadCount, setUnreadCount] = useState(0);
  const [isOpen, setIsOpen] = useState(false);
  const [notifications, setNotifications] = useState<Notification[]>([]);
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const loadCount = async () => {
      try {
        const count = await window.goodvibes.getUnreadNotificationCount();
        setUnreadCount(count);
      } catch (err) {
        // Only show error toast once per session to avoid spam
        logger.error('Failed to load notification count:', err);
      }
    };

    loadCount();
    const interval = setInterval(loadCount, 30000);
    return () => clearInterval(interval);
  }, []);

  useEffect(() => {
    const loadNotifications = async () => {
      if (isOpen) {
        try {
          const notifs = await window.goodvibes.getNotifications();
          setNotifications(notifs || []);
        } catch (err) {
          logger.error('Failed to load notifications:', err);
          toast.error('Failed to load notifications');
          setNotifications([]);
        }
      }
    };
    loadNotifications();
  }, [isOpen]);

  // Close on outside click
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (panelRef.current && !panelRef.current.contains(e.target as Node)) {
        setIsOpen(false);
      }
    };

    if (isOpen) {
      document.addEventListener('mousedown', handleClickOutside);
    }
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [isOpen]);

  const handleMarkAllRead = async () => {
    try {
      await window.goodvibes.markAllNotificationsRead();
      setUnreadCount(0);
      setNotifications(notifications.map(n => ({ ...n, read: true })));
    } catch (err) {
      logger.error('Failed to mark notifications as read:', err);
      toast.error('Failed to mark notifications as read');
    }
  };

  const handleClearAll = async () => {
    try {
      await window.goodvibes.dismissAllNotifications();
      setNotifications([]);
      setUnreadCount(0);
    } catch (err) {
      logger.error('Failed to clear notifications:', err);
      toast.error('Failed to clear notifications');
    }
  };

  return (
    <div className="relative" ref={panelRef}>
      <button
        onClick={() => setIsOpen(!isOpen)}
        className={clsx(
          'group relative p-2.5 rounded-xl',
          'transition-all duration-200 ease-out',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500/50 focus-visible:ring-offset-1 focus-visible:ring-offset-surface-900',
          isOpen
            ? 'text-primary-400 bg-gradient-to-b from-primary-500/15 to-primary-600/10 shadow-md shadow-primary-500/10'
            : 'text-surface-400 hover:text-surface-200 hover:bg-gradient-to-b hover:from-surface-700/60 hover:to-surface-800/60 hover:shadow-sm active:bg-surface-800'
        )}
        title="Notifications"
        aria-label={`Notifications${unreadCount > 0 ? ` (${unreadCount} unread)` : ''}`}
        aria-expanded={isOpen}
      >
        <Bell
          className={clsx(
            'w-5 h-5 transition-transform duration-200',
            isOpen ? 'scale-110' : 'group-hover:scale-105',
            unreadCount > 0 && 'group-hover:animate-[wiggle_0.5s_ease-in-out]'
          )}
          size={20}
        />
        {unreadCount > 0 && (
          <span className={clsx(
            'absolute -top-0.5 -right-0.5 flex items-center justify-center',
            'min-w-[18px] h-[18px] px-1',
            'text-[10px] font-bold',
            'bg-gradient-to-b from-error-400 to-error-500 text-white',
            'rounded-full',
            'shadow-lg shadow-error-500/40',
            'ring-2 ring-surface-900',
            'animate-pulse'
          )}>
            {unreadCount > 9 ? '9+' : unreadCount}
          </span>
        )}
      </button>

      {isOpen && (
        <div className={clsx(
          'absolute right-0 top-full mt-2 w-80',
          'bg-surface-900/95 backdrop-blur-xl',
          'border border-surface-700/60 rounded-2xl',
          'shadow-elevation-5 shadow-black/40',
          'overflow-hidden z-[9999]',
          'animate-slide-down',
          'ring-1 ring-white/5'
        )}>
          {/* Header with gradient */}
          <div className={clsx(
            'flex items-center justify-between px-4 py-3.5',
            'border-b border-surface-700/60',
            'bg-gradient-to-r from-surface-800/50 via-surface-800/30 to-surface-800/50'
          )}>
            <h3 className="text-sm font-semibold text-surface-100">Notifications</h3>
            {notifications.length > 0 && (
              <div className="flex items-center gap-3">
                <button
                  onClick={handleMarkAllRead}
                  className="text-xs font-medium text-primary-400 hover:text-primary-300 transition-colors hover:underline underline-offset-2"
                >
                  Mark all read
                </button>
                <button
                  onClick={handleClearAll}
                  className="text-xs font-medium text-surface-500 hover:text-surface-300 transition-colors hover:underline underline-offset-2"
                >
                  Clear all
                </button>
              </div>
            )}
          </div>

          <div className="max-h-80 overflow-y-auto">
            {notifications.length === 0 ? (
              <div className="py-12 text-center">
                <div className={clsx(
                  'w-14 h-14 mx-auto mb-4 rounded-2xl',
                  'bg-gradient-to-b from-surface-800 to-surface-800/80',
                  'flex items-center justify-center',
                  'shadow-inner shadow-black/20',
                  'ring-1 ring-white/5'
                )}>
                  <Bell className="w-6 h-6 text-surface-500" size={24} />
                </div>
                <p className="text-sm font-medium text-surface-300">No notifications</p>
                <p className="text-xs text-surface-500 mt-1">You're all caught up</p>
              </div>
            ) : (
              <div className="p-2">
                {notifications.map((notif) => (
                  <div
                    key={notif.id}
                    className={clsx(
                      'group/notif flex items-start gap-3 px-3 py-3 rounded-xl mb-1 last:mb-0',
                      'transition-all duration-150',
                      'hover:bg-surface-800/60',
                      !notif.read && 'bg-gradient-to-r from-primary-500/5 to-transparent'
                    )}
                  >
                    <div className={clsx(
                      'w-2.5 h-2.5 rounded-full mt-1.5 flex-shrink-0',
                      'shadow-sm',
                      notif.type === 'error' && 'bg-error-500 shadow-error-500/50',
                      notif.type === 'warning' && 'bg-warning-500 shadow-warning-500/50',
                      notif.type === 'success' && 'bg-success-500 shadow-success-500/50',
                      notif.type === 'info' && 'bg-primary-500 shadow-primary-500/50'
                    )} />
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium text-surface-100 group-hover/notif:text-white transition-colors">
                        {notif.title}
                      </p>
                      <p className="text-xs text-surface-400 truncate mt-0.5">{notif.message}</p>
                      <p className="text-[10px] text-surface-500 mt-1.5 font-medium uppercase tracking-wide">
                        {notif.timestamp}
                      </p>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
