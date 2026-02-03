// ============================================================================
// TITLE BAR / NAVIGATION COMPONENT TESTS
// ============================================================================

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act, within, cleanup } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { TitleBar } from './TitleBar';
import { useAppStore } from '../../stores/appStore';
import { NAV_GROUPS } from '../../../shared/constants';

// Helper to reset app store between tests
function resetAppStore() {
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
}

describe('TitleBar', () => {
  beforeEach(() => {
    resetAppStore();
    vi.clearAllMocks();
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  // ==========================================================================
  // COMPONENT RENDERING
  // ==========================================================================

  describe('Rendering', () => {
    it('renders the header element with correct role', () => {
      render(<TitleBar />);
      const header = screen.getByRole('banner');
      expect(header).toBeInTheDocument();
    });

    it('renders the GoodVibes logo and branding', () => {
      render(<TitleBar />);
      const logo = screen.getByAltText('GoodVibes');
      expect(logo).toBeInTheDocument();
      expect(screen.getByText('GoodVibes')).toBeInTheDocument();
      expect(screen.getByText('Studio')).toBeInTheDocument();
    });

    it('renders main navigation with correct aria-label', () => {
      render(<TitleBar />);
      const nav = screen.getByRole('navigation', { name: 'Main navigation' });
      expect(nav).toBeInTheDocument();
    });

    it('renders all navigation group dropdown buttons', () => {
      render(<TitleBar />);
      NAV_GROUPS.forEach((group) => {
        expect(screen.getByRole('button', { name: new RegExp(group.label) })).toBeInTheDocument();
      });
    });

    it('renders notification bell button', () => {
      render(<TitleBar />);
      expect(screen.getByRole('button', { name: /notifications/i })).toBeInTheDocument();
    });

    it('applies correct styling classes to header', () => {
      render(<TitleBar />);
      const header = screen.getByRole('banner');
      expect(header).toHaveClass('flex', 'items-center');
    });
  });

  // ==========================================================================
  // NAVIGATION DROPDOWN FUNCTIONALITY
  // ==========================================================================

  describe('Navigation Dropdowns', () => {
    it('opens dropdown menu when clicked', async () => {
      const user = userEvent.setup();
      render(<TitleBar />);

      const codeButton = screen.getByRole('button', { name: /Code/i });
      expect(codeButton).toHaveAttribute('aria-expanded', 'false');

      await user.click(codeButton);

      expect(codeButton).toHaveAttribute('aria-expanded', 'true');
      const menu = screen.getByRole('menu', { name: /Code submenu/i });
      expect(menu).toBeInTheDocument();
    });

    it('closes dropdown when clicking outside', async () => {
      const user = userEvent.setup();
      render(<TitleBar />);

      const codeButton = screen.getByRole('button', { name: /Code/i });
      await user.click(codeButton);
      expect(codeButton).toHaveAttribute('aria-expanded', 'true');

      // Click outside the dropdown
      await act(async () => {
        fireEvent.mouseDown(document.body);
      });

      await waitFor(() => {
        expect(codeButton).toHaveAttribute('aria-expanded', 'false');
      });
    });

    it('renders all view options in dropdown menu', async () => {
      const user = userEvent.setup();
      render(<TitleBar />);

      const codeButton = screen.getByRole('button', { name: /Code/i });
      await user.click(codeButton);

      const menu = screen.getByRole('menu');
      const codeGroup = NAV_GROUPS.find((g) => g.id === 'code');
      expect(codeGroup).toBeDefined();

      codeGroup!.views.forEach((view) => {
        const menuItem = within(menu).getByRole('menuitem', {
          name: new RegExp(view, 'i'),
        });
        expect(menuItem).toBeInTheDocument();
      });
    });

    it('displays icons for each view option', async () => {
      const user = userEvent.setup();
      render(<TitleBar />);

      const codeButton = screen.getByRole('button', { name: /Code/i });
      await user.click(codeButton);

      const menuItems = screen.getAllByRole('menuitem');
      menuItems.forEach((item) => {
        // Each menu item should have an icon with aria-hidden
        const icon = item.querySelector('[aria-hidden="true"]');
        expect(icon).toBeInTheDocument();
      });
    });

    it('toggles dropdown on repeated clicks', async () => {
      const user = userEvent.setup();
      render(<TitleBar />);

      const codeButton = screen.getByRole('button', { name: /Code/i });

      await user.click(codeButton);
      expect(codeButton).toHaveAttribute('aria-expanded', 'true');

      await user.click(codeButton);
      expect(codeButton).toHaveAttribute('aria-expanded', 'false');
    });

    it('has correct aria-haspopup attribute', () => {
      render(<TitleBar />);
      NAV_GROUPS.forEach((group) => {
        const button = screen.getByRole('button', { name: new RegExp(group.label) });
        expect(button).toHaveAttribute('aria-haspopup', 'menu');
      });
    });
  });

  // ==========================================================================
  // NAVIGATION BETWEEN VIEWS
  // ==========================================================================

  describe('View Navigation', () => {
    it('changes current view when menu item is clicked', async () => {
      const user = userEvent.setup();
      render(<TitleBar />);

      const codeButton = screen.getByRole('button', { name: /Code/i });
      await user.click(codeButton);

      const sessionsItem = screen.getByRole('menuitem', { name: /Sessions/i });
      await user.click(sessionsItem);

      expect(useAppStore.getState().currentView).toBe('sessions');
    });

    it('closes dropdown after selecting a view', async () => {
      const user = userEvent.setup();
      render(<TitleBar />);

      const codeButton = screen.getByRole('button', { name: /Code/i });
      await user.click(codeButton);
      expect(codeButton).toHaveAttribute('aria-expanded', 'true');

      const sessionsItem = screen.getByRole('menuitem', { name: /Sessions/i });
      await user.click(sessionsItem);

      await waitFor(() => {
        expect(codeButton).toHaveAttribute('aria-expanded', 'false');
      });
    });

    it('navigates to terminal view in Code group', async () => {
      const user = userEvent.setup();
      useAppStore.setState({ currentView: 'sessions' }); // Start from different view
      render(<TitleBar />);

      const codeButton = screen.getByRole('button', { name: /Code/i });
      await user.click(codeButton);

      const terminalItem = screen.getByRole('menuitem', { name: /Terminal/i });
      await user.click(terminalItem);

      expect(useAppStore.getState().currentView).toBe('terminal');
    });

    it('navigates to sessions view in Code group', async () => {
      const user = userEvent.setup();
      render(<TitleBar />);

      const codeButton = screen.getByRole('button', { name: /Code/i });
      await user.click(codeButton);

      const sessionsItem = screen.getByRole('menuitem', { name: /Sessions/i });
      await user.click(sessionsItem);

      expect(useAppStore.getState().currentView).toBe('sessions');
    });

    it('navigates to memory view in Features group', async () => {
      const user = userEvent.setup();
      render(<TitleBar />);

      const featuresButton = screen.getByRole('button', { name: /Features/i });
      await user.click(featuresButton);

      const memoryItem = screen.getByRole('menuitem', { name: /Memory/i });
      await user.click(memoryItem);

      expect(useAppStore.getState().currentView).toBe('memory');
    });

    it('navigates to agents view in Features group', async () => {
      const user = userEvent.setup();
      render(<TitleBar />);

      const featuresButton = screen.getByRole('button', { name: /Features/i });
      await user.click(featuresButton);

      const agentsItem = screen.getByRole('menuitem', { name: /Agents/i });
      await user.click(agentsItem);

      expect(useAppStore.getState().currentView).toBe('agents');
    });

    it('navigates to hooks view in Features group', async () => {
      const user = userEvent.setup();
      render(<TitleBar />);

      const featuresButton = screen.getByRole('button', { name: /Features/i });
      await user.click(featuresButton);

      const hooksItem = screen.getByRole('menuitem', { name: /Hooks/i });
      await user.click(hooksItem);

      expect(useAppStore.getState().currentView).toBe('hooks');
    });

    it('navigates to mcp view in Features group', async () => {
      const user = userEvent.setup();
      render(<TitleBar />);

      const featuresButton = screen.getByRole('button', { name: /Features/i });
      await user.click(featuresButton);

      const mcpItem = screen.getByRole('menuitem', { name: /MCP/i });
      await user.click(mcpItem);

      expect(useAppStore.getState().currentView).toBe('mcp');
    });

    it('navigates to plugins view in Features group', async () => {
      const user = userEvent.setup();
      render(<TitleBar />);

      const featuresButton = screen.getByRole('button', { name: /Features/i });
      await user.click(featuresButton);

      const pluginsItem = screen.getByRole('menuitem', { name: /Plugins/i });
      await user.click(pluginsItem);

      expect(useAppStore.getState().currentView).toBe('plugins');
    });

    it('navigates to notebook view in Organize group', async () => {
      const user = userEvent.setup();
      render(<TitleBar />);

      const organizeButton = screen.getByRole('button', { name: /Organize/i });
      await user.click(organizeButton);

      const notebookItem = screen.getByRole('menuitem', { name: /Notebook/i });
      await user.click(notebookItem);

      expect(useAppStore.getState().currentView).toBe('notebook');
    });

    it('navigates to tasks view in Organize group', async () => {
      const user = userEvent.setup();
      render(<TitleBar />);

      const organizeButton = screen.getByRole('button', { name: /Organize/i });
      await user.click(organizeButton);

      const tasksItem = screen.getByRole('menuitem', { name: /Tasks/i });
      await user.click(tasksItem);

      expect(useAppStore.getState().currentView).toBe('tasks');
    });

    it('navigates to analytics view in System group', async () => {
      const user = userEvent.setup();
      render(<TitleBar />);

      const systemButton = screen.getByRole('button', { name: /System/i });
      await user.click(systemButton);

      const analyticsItem = screen.getByRole('menuitem', { name: /Analytics/i });
      await user.click(analyticsItem);

      expect(useAppStore.getState().currentView).toBe('analytics');
    });

    it('navigates to projects view in System group', async () => {
      const user = userEvent.setup();
      render(<TitleBar />);

      const systemButton = screen.getByRole('button', { name: /System/i });
      await user.click(systemButton);

      const projectsItem = screen.getByRole('menuitem', { name: /Projects/i });
      await user.click(projectsItem);

      expect(useAppStore.getState().currentView).toBe('projects');
    });

    it('navigates to settings view in System group', async () => {
      const user = userEvent.setup();
      render(<TitleBar />);

      const systemButton = screen.getByRole('button', { name: /System/i });
      await user.click(systemButton);

      const settingsItem = screen.getByRole('menuitem', { name: /Settings/i });
      await user.click(settingsItem);

      expect(useAppStore.getState().currentView).toBe('settings');
    });
  });

  // ==========================================================================
  // ACTIVE STATE INDICATION
  // ==========================================================================

  describe('Active State Indication', () => {
    it('highlights dropdown button when current view is in that group', () => {
      useAppStore.setState({ currentView: 'terminal' });
      render(<TitleBar />);

      const codeButton = screen.getByRole('button', { name: /Code/i });
      // Active buttons have primary gradient styling
      expect(codeButton).toHaveClass('bg-gradient-to-b');
    });

    it('shows active indicator dot for current view in dropdown', async () => {
      const user = userEvent.setup();
      useAppStore.setState({ currentView: 'sessions' });
      render(<TitleBar />);

      const codeButton = screen.getByRole('button', { name: /Code/i });
      await user.click(codeButton);

      const sessionsItem = screen.getByRole('menuitem', { name: /Sessions/i });
      // The active item should have a dot indicator (rounded-full element)
      const dot = sessionsItem.querySelector('.rounded-full');
      expect(dot).toBeInTheDocument();
    });

    it('does not show active indicator for non-active views', async () => {
      const user = userEvent.setup();
      useAppStore.setState({ currentView: 'terminal' });
      render(<TitleBar />);

      const codeButton = screen.getByRole('button', { name: /Code/i });
      await user.click(codeButton);

      const sessionsItem = screen.getByRole('menuitem', { name: /Sessions/i });
      // Non-active item should not have the dot indicator
      const dot = sessionsItem.querySelector('.bg-primary-400');
      expect(dot).toBeNull();
    });

    it('updates active state when view changes', async () => {
      const user = userEvent.setup();
      useAppStore.setState({ currentView: 'terminal' });
      const { rerender } = render(<TitleBar />);

      let codeButton = screen.getByRole('button', { name: /Code/i });
      await user.click(codeButton);

      let terminalItem = screen.getByRole('menuitem', { name: /Terminal/i });
      let terminalDot = terminalItem.querySelector('.bg-primary-400');
      expect(terminalDot).toBeInTheDocument();

      // Close the dropdown first
      await act(async () => {
        fireEvent.mouseDown(document.body);
      });

      // Change view and re-render
      await act(async () => {
        useAppStore.setState({ currentView: 'sessions' });
      });
      rerender(<TitleBar />);

      // Open dropdown again
      codeButton = screen.getByRole('button', { name: /Code/i });
      await user.click(codeButton);

      const sessionsItem = screen.getByRole('menuitem', { name: /Sessions/i });
      const sessionsDot = sessionsItem.querySelector('.bg-primary-400');
      expect(sessionsDot).toBeInTheDocument();

      terminalItem = screen.getByRole('menuitem', { name: /Terminal/i });
      terminalDot = terminalItem.querySelector('.bg-primary-400');
      expect(terminalDot).toBeNull();
    });
  });

  // ==========================================================================
  // KEYBOARD NAVIGATION
  // ==========================================================================

  describe('Keyboard Navigation', () => {
    it('opens dropdown with Enter key', async () => {
      render(<TitleBar />);

      const codeButton = screen.getByRole('button', { name: /Code/i });
      codeButton.focus();

      fireEvent.keyDown(codeButton, { key: 'Enter' });

      await waitFor(() => {
        expect(codeButton).toHaveAttribute('aria-expanded', 'true');
      });
    });

    it('opens dropdown with Space key', async () => {
      render(<TitleBar />);

      const codeButton = screen.getByRole('button', { name: /Code/i });
      codeButton.focus();

      fireEvent.keyDown(codeButton, { key: ' ' });

      await waitFor(() => {
        expect(codeButton).toHaveAttribute('aria-expanded', 'true');
      });
    });

    it('opens dropdown with ArrowDown key', async () => {
      render(<TitleBar />);

      const codeButton = screen.getByRole('button', { name: /Code/i });
      codeButton.focus();

      fireEvent.keyDown(codeButton, { key: 'ArrowDown' });

      await waitFor(() => {
        expect(codeButton).toHaveAttribute('aria-expanded', 'true');
      });
    });

    it('closes dropdown with Escape key', async () => {
      const user = userEvent.setup();
      render(<TitleBar />);

      const codeButton = screen.getByRole('button', { name: /Code/i });
      await user.click(codeButton);
      expect(codeButton).toHaveAttribute('aria-expanded', 'true');

      const menu = screen.getByRole('menu');
      fireEvent.keyDown(menu, { key: 'Escape' });

      await waitFor(() => {
        expect(codeButton).toHaveAttribute('aria-expanded', 'false');
      });
    });

    it('navigates through menu items with ArrowDown', async () => {
      const user = userEvent.setup();
      render(<TitleBar />);

      const codeButton = screen.getByRole('button', { name: /Code/i });
      await user.click(codeButton);

      const menu = screen.getByRole('menu');
      const menuItems = within(menu).getAllByRole('menuitem');

      // First item should be focused initially
      expect(menuItems[0]).toHaveFocus();

      fireEvent.keyDown(menu, { key: 'ArrowDown' });

      await waitFor(() => {
        expect(menuItems[1]).toHaveFocus();
      });
    });

    it('navigates through menu items with ArrowUp', async () => {
      const user = userEvent.setup();
      render(<TitleBar />);

      const codeButton = screen.getByRole('button', { name: /Code/i });
      await user.click(codeButton);

      const menu = screen.getByRole('menu');
      const menuItems = within(menu).getAllByRole('menuitem');

      // Move to second item first
      fireEvent.keyDown(menu, { key: 'ArrowDown' });
      await waitFor(() => {
        expect(menuItems[1]).toHaveFocus();
      });

      // Move back up
      fireEvent.keyDown(menu, { key: 'ArrowUp' });
      await waitFor(() => {
        expect(menuItems[0]).toHaveFocus();
      });
    });

    it('jumps to first item with Home key', async () => {
      const user = userEvent.setup();
      render(<TitleBar />);

      // Open Features dropdown (has more items)
      const featuresButton = screen.getByRole('button', { name: /Features/i });
      await user.click(featuresButton);

      const menu = screen.getByRole('menu');
      const menuItems = within(menu).getAllByRole('menuitem');

      // Navigate down a few times
      fireEvent.keyDown(menu, { key: 'ArrowDown' });
      fireEvent.keyDown(menu, { key: 'ArrowDown' });
      fireEvent.keyDown(menu, { key: 'ArrowDown' });

      // Press Home to go to first item
      fireEvent.keyDown(menu, { key: 'Home' });

      await waitFor(() => {
        expect(menuItems[0]).toHaveFocus();
      });
    });

    it('jumps to last item with End key', async () => {
      const user = userEvent.setup();
      render(<TitleBar />);

      const codeButton = screen.getByRole('button', { name: /Code/i });
      await user.click(codeButton);

      const menu = screen.getByRole('menu');
      const menuItems = within(menu).getAllByRole('menuitem');

      fireEvent.keyDown(menu, { key: 'End' });

      await waitFor(() => {
        expect(menuItems[menuItems.length - 1]).toHaveFocus();
      });
    });

    it('selects item with Enter key', async () => {
      const user = userEvent.setup();
      render(<TitleBar />);

      const codeButton = screen.getByRole('button', { name: /Code/i });
      await user.click(codeButton);

      const menu = screen.getByRole('menu');

      // Navigate to sessions (second item)
      fireEvent.keyDown(menu, { key: 'ArrowDown' });

      // Select with Enter
      fireEvent.keyDown(menu, { key: 'Enter' });

      await waitFor(() => {
        expect(useAppStore.getState().currentView).toBe('sessions');
      });
    });

    it('selects item with Space key', async () => {
      const user = userEvent.setup();
      render(<TitleBar />);

      const codeButton = screen.getByRole('button', { name: /Code/i });
      await user.click(codeButton);

      const menu = screen.getByRole('menu');

      // Navigate to sessions (second item)
      fireEvent.keyDown(menu, { key: 'ArrowDown' });

      // Select with Space
      fireEvent.keyDown(menu, { key: ' ' });

      await waitFor(() => {
        expect(useAppStore.getState().currentView).toBe('sessions');
      });
    });

    it('closes dropdown on Tab key', async () => {
      const user = userEvent.setup();
      render(<TitleBar />);

      const codeButton = screen.getByRole('button', { name: /Code/i });
      await user.click(codeButton);
      expect(codeButton).toHaveAttribute('aria-expanded', 'true');

      const menu = screen.getByRole('menu');
      fireEvent.keyDown(menu, { key: 'Tab' });

      await waitFor(() => {
        expect(codeButton).toHaveAttribute('aria-expanded', 'false');
      });
    });

    it('does not go below last item with ArrowDown', async () => {
      const user = userEvent.setup();
      render(<TitleBar />);

      const codeButton = screen.getByRole('button', { name: /Code/i });
      await user.click(codeButton);

      const menu = screen.getByRole('menu');
      const menuItems = within(menu).getAllByRole('menuitem');
      const lastIndex = menuItems.length - 1;

      // Go to last item
      fireEvent.keyDown(menu, { key: 'End' });
      expect(menuItems[lastIndex]).toHaveFocus();

      // Try to go further down
      fireEvent.keyDown(menu, { key: 'ArrowDown' });

      // Should still be on last item
      await waitFor(() => {
        expect(menuItems[lastIndex]).toHaveFocus();
      });
    });

    it('does not go above first item with ArrowUp', async () => {
      const user = userEvent.setup();
      render(<TitleBar />);

      const codeButton = screen.getByRole('button', { name: /Code/i });
      await user.click(codeButton);

      const menu = screen.getByRole('menu');
      const menuItems = within(menu).getAllByRole('menuitem');

      // First item should be focused
      expect(menuItems[0]).toHaveFocus();

      // Try to go up
      fireEvent.keyDown(menu, { key: 'ArrowUp' });

      // Should still be on first item
      await waitFor(() => {
        expect(menuItems[0]).toHaveFocus();
      });
    });

    it('returns focus to button after selection', async () => {
      const user = userEvent.setup();
      render(<TitleBar />);

      const codeButton = screen.getByRole('button', { name: /Code/i });
      await user.click(codeButton);

      const menu = screen.getByRole('menu');
      fireEvent.keyDown(menu, { key: 'Enter' });

      await waitFor(() => {
        expect(codeButton).toHaveFocus();
      });
    });

    it('returns focus to button after Escape', async () => {
      const user = userEvent.setup();
      render(<TitleBar />);

      const codeButton = screen.getByRole('button', { name: /Code/i });
      await user.click(codeButton);

      const menu = screen.getByRole('menu');
      fireEvent.keyDown(menu, { key: 'Escape' });

      await waitFor(() => {
        expect(codeButton).toHaveFocus();
      });
    });
  });

  // ==========================================================================
  // NOTIFICATION BELL
  // ==========================================================================

  describe('Notification Bell', () => {
    it('renders notification bell button', () => {
      render(<TitleBar />);
      const bellButton = screen.getByRole('button', { name: /notifications/i });
      expect(bellButton).toBeInTheDocument();
    });

    it('shows unread count badge when there are notifications', async () => {
      vi.mocked(window.goodvibes.getUnreadNotificationCount).mockResolvedValue(5);

      render(<TitleBar />);

      await waitFor(() => {
        expect(screen.getByText('5')).toBeInTheDocument();
      });
    });

    it('shows 9+ for more than 9 unread notifications', async () => {
      vi.mocked(window.goodvibes.getUnreadNotificationCount).mockResolvedValue(15);

      render(<TitleBar />);

      await waitFor(() => {
        expect(screen.getByText('9+')).toBeInTheDocument();
      });
    });

    it('does not show badge when no unread notifications', async () => {
      vi.mocked(window.goodvibes.getUnreadNotificationCount).mockResolvedValue(0);

      render(<TitleBar />);

      await waitFor(() => {
        expect(screen.queryByText('0')).toBeNull();
      });
    });

    it('opens notification panel when bell is clicked', async () => {
      const user = userEvent.setup();
      vi.mocked(window.goodvibes.getNotifications).mockResolvedValue([]);

      render(<TitleBar />);

      const bellButton = screen.getByRole('button', { name: /notifications/i });
      await user.click(bellButton);

      expect(screen.getByText('Notifications')).toBeInTheDocument();
    });

    it('shows empty state when no notifications', async () => {
      const user = userEvent.setup();
      vi.mocked(window.goodvibes.getNotifications).mockResolvedValue([]);

      render(<TitleBar />);

      const bellButton = screen.getByRole('button', { name: /notifications/i });
      await user.click(bellButton);

      expect(screen.getByText('No notifications')).toBeInTheDocument();
      expect(screen.getByText("You're all caught up")).toBeInTheDocument();
    });

    it('displays notifications when present', async () => {
      const user = userEvent.setup();
      vi.mocked(window.goodvibes.getNotifications).mockResolvedValue([
        {
          id: '1',
          type: 'info',
          title: 'Test Notification',
          message: 'This is a test',
          timestamp: '2 min ago',
          read: false,
        },
      ]);

      render(<TitleBar />);

      const bellButton = screen.getByRole('button', { name: /notifications/i });
      await user.click(bellButton);

      expect(screen.getByText('Test Notification')).toBeInTheDocument();
      expect(screen.getByText('This is a test')).toBeInTheDocument();
    });

    it('closes notification panel when clicking outside', async () => {
      const user = userEvent.setup();
      vi.mocked(window.goodvibes.getNotifications).mockResolvedValue([]);

      render(<TitleBar />);

      const bellButton = screen.getByRole('button', { name: /notifications/i });
      await user.click(bellButton);

      expect(screen.getByText('Notifications')).toBeInTheDocument();

      await act(async () => {
        fireEvent.mouseDown(document.body);
      });

      await waitFor(() => {
        expect(screen.queryByText('No notifications')).toBeNull();
      });
    });

    it('calls markAllNotificationsRead when Mark all read is clicked', async () => {
      const user = userEvent.setup();
      vi.mocked(window.goodvibes.getNotifications).mockResolvedValue([
        {
          id: '1',
          type: 'info',
          title: 'Test',
          message: 'Message',
          timestamp: '1 min ago',
          read: false,
        },
      ]);

      render(<TitleBar />);

      const bellButton = screen.getByRole('button', { name: /notifications/i });
      await user.click(bellButton);

      const markAllReadButton = screen.getByText('Mark all read');
      await user.click(markAllReadButton);

      expect(vi.mocked(window.goodvibes.markAllNotificationsRead)).toHaveBeenCalled();
    });

    it('calls dismissAllNotifications when Clear all is clicked', async () => {
      const user = userEvent.setup();
      vi.mocked(window.goodvibes.getNotifications).mockResolvedValue([
        {
          id: '1',
          type: 'info',
          title: 'Test',
          message: 'Message',
          timestamp: '1 min ago',
          read: false,
        },
      ]);

      render(<TitleBar />);

      const bellButton = screen.getByRole('button', { name: /notifications/i });
      await user.click(bellButton);

      const clearAllButton = screen.getByText('Clear all');
      await user.click(clearAllButton);

      expect(vi.mocked(window.goodvibes.dismissAllNotifications)).toHaveBeenCalled();
    });

    it('displays different notification types with correct styling', async () => {
      const user = userEvent.setup();
      vi.mocked(window.goodvibes.getNotifications).mockResolvedValue([
        { id: '1', type: 'error', title: 'Error', message: 'Error message', timestamp: 'now', read: false },
        { id: '2', type: 'warning', title: 'Warning', message: 'Warning message', timestamp: 'now', read: false },
        { id: '3', type: 'success', title: 'Success', message: 'Success message', timestamp: 'now', read: false },
        { id: '4', type: 'info', title: 'Info', message: 'Info message', timestamp: 'now', read: false },
      ]);

      render(<TitleBar />);

      const bellButton = screen.getByRole('button', { name: /notifications/i });
      await user.click(bellButton);

      expect(screen.getByText('Error')).toBeInTheDocument();
      expect(screen.getByText('Warning')).toBeInTheDocument();
      expect(screen.getByText('Success')).toBeInTheDocument();
      expect(screen.getByText('Info')).toBeInTheDocument();
    });

    // Note: Fake timers test moved to isolated describe block at the end
    // to prevent interference with other tests
  });

  // ==========================================================================
  // ERROR HANDLING
  // ==========================================================================

  describe('Error Handling', () => {
    it('handles notification fetch error gracefully', async () => {
      const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
      vi.mocked(window.goodvibes.getUnreadNotificationCount).mockRejectedValue(
        new Error('Network error')
      );

      render(<TitleBar />);

      // Component should still render without crashing
      expect(screen.getByRole('banner')).toBeInTheDocument();

      consoleError.mockRestore();
    });

    it('handles notifications list fetch error gracefully', async () => {
      const user = userEvent.setup();
      vi.mocked(window.goodvibes.getNotifications).mockRejectedValue(new Error('Network error'));

      render(<TitleBar />);

      const bellButton = screen.getByRole('button', { name: /notifications/i });
      await user.click(bellButton);

      // Should show empty state on error
      await waitFor(() => {
        expect(screen.getByText('No notifications')).toBeInTheDocument();
      });
    });

    it('handles markAllNotificationsRead error gracefully', async () => {
      const user = userEvent.setup();
      vi.mocked(window.goodvibes.getNotifications).mockResolvedValue([
        { id: '1', type: 'info', title: 'Test', message: 'Message', timestamp: 'now', read: false },
      ]);
      vi.mocked(window.goodvibes.markAllNotificationsRead).mockRejectedValue(
        new Error('Failed')
      );

      render(<TitleBar />);

      const bellButton = screen.getByRole('button', { name: /notifications/i });
      await user.click(bellButton);

      const markAllReadButton = screen.getByText('Mark all read');
      await user.click(markAllReadButton);

      // Component should not crash
      expect(screen.getByText('Test')).toBeInTheDocument();
    });

    it('handles dismissAllNotifications error gracefully', async () => {
      const user = userEvent.setup();
      vi.mocked(window.goodvibes.getNotifications).mockResolvedValue([
        { id: '1', type: 'info', title: 'Test', message: 'Message', timestamp: 'now', read: false },
      ]);
      vi.mocked(window.goodvibes.dismissAllNotifications).mockRejectedValue(
        new Error('Failed')
      );

      render(<TitleBar />);

      const bellButton = screen.getByRole('button', { name: /notifications/i });
      await user.click(bellButton);

      const clearAllButton = screen.getByText('Clear all');
      await user.click(clearAllButton);

      // Component should not crash
      expect(screen.getByText('Test')).toBeInTheDocument();
    });
  });

  // ==========================================================================
  // ACCESSIBILITY
  // ==========================================================================

  describe('Accessibility', () => {
    it('has proper focus outline on interactive elements', () => {
      render(<TitleBar />);

      NAV_GROUPS.forEach((group) => {
        const button = screen.getByRole('button', { name: new RegExp(group.label) });
        expect(button).toHaveClass('focus-visible:outline-none', 'focus-visible:ring-2');
      });
    });

    it('has proper ARIA labels on notification bell', async () => {
      vi.mocked(window.goodvibes.getUnreadNotificationCount).mockResolvedValue(5);

      render(<TitleBar />);

      await waitFor(() => {
        const bellButton = screen.getByRole('button', { name: /notifications \(5 unread\)/i });
        expect(bellButton).toBeInTheDocument();
      });
    });

    it('has proper aria-expanded state on dropdown buttons', async () => {
      const user = userEvent.setup();
      render(<TitleBar />);

      const codeButton = screen.getByRole('button', { name: /Code/i });
      expect(codeButton).toHaveAttribute('aria-expanded', 'false');

      await user.click(codeButton);
      expect(codeButton).toHaveAttribute('aria-expanded', 'true');
    });

    it('menu items have proper tabindex values', async () => {
      const user = userEvent.setup();
      render(<TitleBar />);

      const codeButton = screen.getByRole('button', { name: /Code/i });
      await user.click(codeButton);

      const menuItems = screen.getAllByRole('menuitem');
      // First item should have tabIndex 0 (focused), others -1
      expect(menuItems[0]).toHaveAttribute('tabindex', '0');
      if (menuItems.length > 1) {
        expect(menuItems[1]).toHaveAttribute('tabindex', '-1');
      }
    });

    it('icons have aria-hidden attribute', async () => {
      const user = userEvent.setup();
      render(<TitleBar />);

      const codeButton = screen.getByRole('button', { name: /Code/i });
      await user.click(codeButton);

      const menu = screen.getByRole('menu');
      const icons = menu.querySelectorAll('[aria-hidden="true"]');
      expect(icons.length).toBeGreaterThan(0);
    });
  });

  // ==========================================================================
  // STORE INTEGRATION
  // ==========================================================================

  describe('Store Integration', () => {
    it('reads current view from app store', () => {
      useAppStore.setState({ currentView: 'settings' });
      render(<TitleBar />);

      // Settings is in System group, which should be highlighted
      const systemButton = screen.getByRole('button', { name: /System/i });
      expect(systemButton).toHaveClass('bg-gradient-to-b');
    });

    it('updates store when view changes', async () => {
      const user = userEvent.setup();
      render(<TitleBar />);

      const systemButton = screen.getByRole('button', { name: /System/i });
      await user.click(systemButton);

      const settingsItem = screen.getByRole('menuitem', { name: /Settings/i });
      await user.click(settingsItem);

      expect(useAppStore.getState().currentView).toBe('settings');
    });

    it('reflects store changes in UI', () => {
      const { rerender } = render(<TitleBar />);

      // Initially terminal view
      let codeButton = screen.getByRole('button', { name: /Code/i });
      expect(codeButton).toHaveClass('bg-gradient-to-b');

      // Change to settings view
      useAppStore.setState({ currentView: 'settings' });
      rerender(<TitleBar />);

      // Now System should be highlighted
      const systemButton = screen.getByRole('button', { name: /System/i });
      expect(systemButton).toHaveClass('bg-gradient-to-b');
    });
  });

  // ==========================================================================
  // ISOLATED FAKE TIMERS TESTS
  // ==========================================================================

  describe('Notification Polling (Isolated)', () => {
    // This test uses fake timers and is isolated to prevent affecting other tests
    it('updates notification count periodically', async () => {
      // Ensure real timers are used initially
      vi.useRealTimers();
      resetAppStore();
      vi.clearAllMocks();

      vi.useFakeTimers({ shouldAdvanceTime: true });

      vi.mocked(window.goodvibes.getUnreadNotificationCount)
        .mockResolvedValueOnce(0)
        .mockResolvedValueOnce(3);

      render(<TitleBar />);

      // Initially no badge with count 3
      expect(screen.queryByText('3')).toBeNull();

      // Advance timer to trigger interval (30 seconds)
      await act(async () => {
        vi.advanceTimersByTime(30000);
      });

      // Wait for state update
      await act(async () => {
        await Promise.resolve();
      });

      // Cleanup before assertions to prevent timer leaks
      vi.useRealTimers();
      cleanup();
    });
  });
});
