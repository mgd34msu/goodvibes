// ============================================================================
// TITLE BAR COMPONENT
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
const ICON_CLASS = "w-4 h-4 flex-shrink-0";

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
          'flex items-center gap-1.5 px-3 py-2 text-sm font-medium rounded-lg transition-all duration-150',
          isActive
            ? 'bg-primary-600 text-white shadow-md shadow-primary-600/25'
            : 'text-surface-400 hover:text-surface-200 hover:bg-surface-800/70'
        )}
      >
        <span>{group.label}</span>
        <ChevronDown
          className={clsx(
            'w-3.5 h-3.5 transition-transform duration-150',
            isOpen && 'rotate-180'
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
          className="absolute left-0 top-full mt-1 min-w-[180px] bg-surface-900 border border-surface-700/80 rounded-lg shadow-elevation-4 overflow-hidden z-[9999] animate-slide-down"
        >
          {group.views.map((view, index) => (
            <button
              key={view}
              role="menuitem"
              tabIndex={focusedIndex === index ? 0 : -1}
              onClick={() => handleItemClick(view)}
              className={clsx(
                'w-full flex items-center gap-2.5 px-3 py-2 text-sm text-left transition-colors duration-100',
                currentView === view
                  ? 'bg-primary-500/20 text-primary-300'
                  : focusedIndex === index
                    ? 'bg-surface-800 text-surface-100'
                    : 'text-surface-300 hover:bg-surface-800 hover:text-surface-100'
              )}
            >
              {VIEW_ICONS[view]}
              <span>{VIEW_LABELS[view]}</span>
            </button>
          ))}
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
    <header className="flex items-center h-[var(--titlebar-height)] bg-surface-900/95 backdrop-blur-sm border-b border-surface-800/80 relative z-[9999]">
      {/* Logo */}
      <div className="flex items-center gap-2.5 px-5 drag-region">
        <img src={appIcon} alt="GoodVibes" className="w-7 h-7 rounded-lg" />
        <span className="text-sm font-semibold text-surface-100 tracking-tight">GoodVibes</span>
      </div>

      {/* Navigation dropdowns */}
      <nav className="flex items-center gap-1 px-4 no-drag flex-1" role="navigation" aria-label="Main navigation">
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
      <div className="flex items-center gap-1 px-4 no-drag">
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
          'relative p-2 rounded-lg transition-all duration-150',
          isOpen
            ? 'text-primary-400 bg-primary-500/10'
            : 'text-surface-400 hover:text-surface-200 hover:bg-surface-800/70'
        )}
        title="Notifications"
        aria-label={`Notifications${unreadCount > 0 ? ` (${unreadCount} unread)` : ''}`}
        aria-expanded={isOpen}
      >
        <Bell className="w-5 h-5" size={20} />
        {unreadCount > 0 && (
          <span className="absolute -top-0.5 -right-0.5 flex items-center justify-center min-w-[18px] h-[18px] px-1 text-2xs font-semibold bg-error-500 text-white rounded-full shadow-sm animate-pulse">
            {unreadCount > 9 ? '9+' : unreadCount}
          </span>
        )}
      </button>

      {isOpen && (
        <div className="absolute right-0 top-full mt-2 w-80 bg-surface-900 border border-surface-700/80 rounded-xl shadow-elevation-4 overflow-hidden z-[9999] animate-slide-down">
          <div className="flex items-center justify-between px-4 py-3 border-b border-surface-700/80 bg-surface-800/30">
            <h3 className="text-sm font-semibold text-surface-100">Notifications</h3>
            {notifications.length > 0 && (
              <div className="flex items-center gap-3">
                <button
                  onClick={handleMarkAllRead}
                  className="text-xs font-medium text-primary-400 hover:text-primary-300 transition-colors"
                >
                  Mark all read
                </button>
                <button
                  onClick={handleClearAll}
                  className="text-xs font-medium text-surface-500 hover:text-surface-300 transition-colors"
                >
                  Clear all
                </button>
              </div>
            )}
          </div>

          <div className="max-h-80 overflow-y-auto">
            {notifications.length === 0 ? (
              <div className="py-10 text-center">
                <div className="w-12 h-12 mx-auto mb-3 rounded-full bg-surface-800 flex items-center justify-center">
                  <Bell className="w-5 h-5 text-surface-500" size={20} />
                </div>
                <p className="text-sm text-surface-400">No notifications</p>
                <p className="text-xs text-surface-500 mt-1">You're all caught up</p>
              </div>
            ) : (
              notifications.map((notif) => (
                <div
                  key={notif.id}
                  className={clsx(
                    'flex items-start gap-3 px-4 py-3 border-b border-surface-800/50 last:border-0 transition-colors hover:bg-surface-800/30',
                    !notif.read && 'bg-primary-500/5'
                  )}
                >
                  <div className={clsx(
                    'w-2.5 h-2.5 rounded-full mt-1 flex-shrink-0 ring-2 ring-offset-1 ring-offset-surface-900',
                    notif.type === 'error' && 'bg-error-500 ring-error-500/30',
                    notif.type === 'warning' && 'bg-warning-500 ring-warning-500/30',
                    notif.type === 'success' && 'bg-success-500 ring-success-500/30',
                    notif.type === 'info' && 'bg-primary-500 ring-primary-500/30'
                  )} />
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium text-surface-100">{notif.title}</p>
                    <p className="text-xs text-surface-400 truncate mt-0.5">{notif.message}</p>
                    <p className="text-2xs text-surface-500 mt-1.5">{notif.timestamp}</p>
                  </div>
                </div>
              ))
            )}
          </div>
        </div>
      )}
    </div>
  );
}
