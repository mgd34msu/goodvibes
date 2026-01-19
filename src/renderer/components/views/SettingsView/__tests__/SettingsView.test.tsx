// ============================================================================
// SETTINGS VIEW COMPONENT TESTS
// ============================================================================
//
// Comprehensive tests for all SettingsView components including:
// - Main SettingsView component
// - Sub-components (AppearanceSettings, ThemeSettings, etc.)
// - Custom hooks (useSettings)
// - Error states and edge cases
// - Form validation
//
// ============================================================================

import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useSettingsStore } from '../../../../stores/settingsStore';
import SettingsView from '../index';
import { BackupSettings } from '../GeneralSettings';
import { TerminalSettings } from '../TerminalSettings';
import { GitHubSettings } from '../GitHubSettings';
import { GitHubConnectionStatus } from '../GitHubConnectionStatus';
import { SessionPreviewVisibilitySettings, SessionPreviewExpandSettings } from '../SessionPreviewSettings';
import { KeyboardSettings } from '../KeyboardSettings';
import { MaintenanceSettings, DangerZoneSettings } from '../MaintenanceSettings';
import { SettingsSection, SettingRow, ToggleSwitch, ShortcutRow } from '../components';
import { DEFAULT_SETTINGS } from '../../../../../shared/types';
import type { AppSettings } from '../../../../../shared/types';

// ============================================================================
// TEST UTILITIES
// ============================================================================

/**
 * Create test wrapper with QueryClientProvider
 */
function createTestWrapper() {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
      },
    },
  });

  return function TestWrapper({ children }: { children: React.ReactNode }) {
    return (
      <QueryClientProvider client={queryClient}>
        {children}
      </QueryClientProvider>
    );
  };
}

/**
 * Helper function that wraps render with QueryClientProvider and waits for async effects
 */
async function renderSettingsView() {
  let result: ReturnType<typeof render>;

  await act(async () => {
    result = render(<SettingsView />, { wrapper: createTestWrapper() });
    await new Promise(resolve => setTimeout(resolve, 0));
  });

  return result!;
}

/**
 * Helper to render a component with QueryClientProvider
 */
function renderWithProviders(ui: React.ReactElement) {
  return render(ui, { wrapper: createTestWrapper() });
}

/**
 * Mock settings with custom overrides
 */
function createMockSettings(overrides: Partial<AppSettings> = {}): AppSettings {
  return { ...DEFAULT_SETTINGS, ...overrides };
}

// ============================================================================
// MAIN SETTINGS VIEW TESTS
// ============================================================================

describe('SettingsView', () => {
  beforeEach(async () => {
    await act(async () => {
      useSettingsStore.setState({
        settings: { ...DEFAULT_SETTINGS },
        isLoaded: true,
      });
    });

    vi.mocked(window.goodvibes.githubGetAuthState).mockResolvedValue({
      isAuthenticated: false,
      user: null,
      accessToken: null,
      tokenExpiresAt: null,
    });

    vi.mocked(window.goodvibes.githubGetOAuthConfig).mockResolvedValue({
      isConfigured: false,
      source: 'none',
      clientId: null,
    });

    vi.mocked(window.goodvibes.getPlatform).mockReturnValue('win32');
    vi.mocked(window.goodvibes.getAvailableEditors).mockResolvedValue([]);

    vi.clearAllMocks();
  });

  describe('Rendering', () => {
    it('renders settings header with title and description', async () => {
      await renderSettingsView();
      expect(screen.getByText('Settings')).toBeInTheDocument();
      expect(screen.getByText('Customize your experience')).toBeInTheDocument();
    });

    it('renders all settings sections', async () => {
      await renderSettingsView();

      expect(screen.getByText('Display')).toBeInTheDocument();
      expect(screen.getByText('Startup Behavior')).toBeInTheDocument();
      expect(screen.getByText('Claude CLI Options')).toBeInTheDocument();
      expect(screen.getByText('Git Integration')).toBeInTheDocument();
      expect(screen.getByText('GitHub Integration')).toBeInTheDocument();
      expect(screen.getByText('Budget Alerts')).toBeInTheDocument();
      expect(screen.getByText('Keyboard Shortcuts')).toBeInTheDocument();
      expect(screen.getByText('Danger Zone')).toBeInTheDocument();
    });

    it('renders scrollable container', async () => {
      await renderSettingsView();
      const container = screen.getByText('Settings').closest('.h-full');
      expect(container).toHaveClass('overflow-auto');
    });
  });

  describe('Theme Settings', () => {
    it('renders Color Theme section', async () => {
      await renderSettingsView();
      expect(screen.getByText('Color Theme')).toBeInTheDocument();
    });

    it('renders theme preview with current theme name', async () => {
      await renderSettingsView();
      // The default theme is goodvibes-classic which shows its name
      expect(screen.getByText('Goodvibes Classic')).toBeInTheDocument();
    });

    it('displays dark themes section when expanded', async () => {
      await renderSettingsView();

      // Click to expand the Color Theme section
      const colorThemeButton = screen.getByText('Color Theme').closest('button');
      if (colorThemeButton) {
        await act(async () => {
          fireEvent.click(colorThemeButton);
        });
      }

      await waitFor(() => {
        expect(screen.getByText('Dark Themes')).toBeInTheDocument();
      });
    });
  });

  describe('Font Size Settings', () => {
    it('renders font size controls with current value', async () => {
      await renderSettingsView();

      const decreaseButton = screen.getByLabelText('Decrease font size');
      const increaseButton = screen.getByLabelText('Increase font size');
      expect(decreaseButton).toBeInTheDocument();
      expect(increaseButton).toBeInTheDocument();
      expect(screen.getByText('14px')).toBeInTheDocument();
    });

    it('increases font size when + clicked', async () => {
      await renderSettingsView();

      const increaseButton = screen.getByLabelText('Increase font size');
      await act(async () => {
        fireEvent.click(increaseButton);
      });

      await waitFor(() => {
        const state = useSettingsStore.getState();
        expect(state.settings.fontSize).toBe(15);
      });
    });

    it('decreases font size when - clicked', async () => {
      await act(async () => {
        useSettingsStore.setState({
          settings: { ...DEFAULT_SETTINGS, fontSize: 16 },
          isLoaded: true,
        });
      });

      await renderSettingsView();

      const decreaseButton = screen.getByLabelText('Decrease font size');
      await act(async () => {
        fireEvent.click(decreaseButton);
      });

      await waitFor(() => {
        const state = useSettingsStore.getState();
        expect(state.settings.fontSize).toBe(15);
      });
    });

    it('disables decrease button at minimum font size (10)', async () => {
      await act(async () => {
        useSettingsStore.setState({
          settings: { ...DEFAULT_SETTINGS, fontSize: 10 },
          isLoaded: true,
        });
      });

      await renderSettingsView();

      const decreaseButton = screen.getByLabelText('Decrease font size');
      expect(decreaseButton).toBeDisabled();
    });

    it('disables increase button at maximum font size (24)', async () => {
      await act(async () => {
        useSettingsStore.setState({
          settings: { ...DEFAULT_SETTINGS, fontSize: 24 },
          isLoaded: true,
        });
      });

      await renderSettingsView();

      const increaseButton = screen.getByLabelText('Increase font size');
      expect(increaseButton).toBeDisabled();
    });
  });

  describe('Toggle Settings', () => {
    it('renders all toggle switches', async () => {
      await renderSettingsView();

      const toggles = screen.getAllByRole('switch');
      expect(toggles.length).toBeGreaterThan(0);
    });

    it('toggles Restore Tabs setting', async () => {
      await renderSettingsView();

      const restoreTabsLabel = screen.getByText('Restore Tabs');
      const settingRow = restoreTabsLabel.closest('.flex');
      const toggle = settingRow?.querySelector('[role="switch"]');

      expect(toggle).toBeInTheDocument();
      if (toggle) {
        expect(toggle.getAttribute('aria-checked')).toBe('false');
        await act(async () => {
          fireEvent.click(toggle);
        });

        await waitFor(() => {
          const state = useSettingsStore.getState();
          expect(state.settings.restoreTabs).toBe(true);
        });
      }
    });

    it('toggles Skip Permission Prompts setting', async () => {
      await renderSettingsView();

      const skipPermissionsLabel = screen.getByText('Skip Permission Prompts');
      const settingRow = skipPermissionsLabel.closest('.flex');
      const toggle = settingRow?.querySelector('[role="switch"]');

      if (toggle) {
        expect(toggle.getAttribute('aria-checked')).toBe('false');
        await act(async () => {
          fireEvent.click(toggle);
        });

        await waitFor(() => {
          const state = useSettingsStore.getState();
          expect(state.settings.skipPermissions).toBe(true);
        });
      }
    });

    it('toggles Auto Session Watch setting', async () => {
      await renderSettingsView();

      const autoWatchLabel = screen.getByText('Auto Session Watch');
      const settingRow = autoWatchLabel.closest('.flex');
      const toggle = settingRow?.querySelector('[role="switch"]');

      if (toggle) {
        // Default is true, so it should be checked
        expect(toggle.getAttribute('aria-checked')).toBe('true');
        await act(async () => {
          fireEvent.click(toggle);
        });

        await waitFor(() => {
          const state = useSettingsStore.getState();
          expect(state.settings.autoSessionWatch).toBe(false);
        });
      }
    });
  });

  describe('Path Settings', () => {
    it('renders Claude Path input with placeholder', async () => {
      await renderSettingsView();

      const claudePathInput = screen.getByPlaceholderText(/leave empty for default/i);
      expect(claudePathInput).toBeInTheDocument();
    });

    it('updates Claude Path on input', async () => {
      await renderSettingsView();

      const claudePathInput = screen.getByPlaceholderText(/leave empty for default/i);
      await act(async () => {
        fireEvent.change(claudePathInput, { target: { value: '/custom/claude/path' } });
      });

      await waitFor(() => {
        const state = useSettingsStore.getState();
        expect(state.settings.claudePath).toBe('/custom/claude/path');
      });
    });

    it('clears Claude Path when input is emptied', async () => {
      await act(async () => {
        useSettingsStore.setState({
          settings: { ...DEFAULT_SETTINGS, claudePath: '/existing/path' },
          isLoaded: true,
        });
      });

      await renderSettingsView();

      const claudePathInput = screen.getByDisplayValue('/existing/path');
      await act(async () => {
        fireEvent.change(claudePathInput, { target: { value: '' } });
      });

      await waitFor(() => {
        const state = useSettingsStore.getState();
        expect(state.settings.claudePath).toBeNull();
      });
    });

    it('renders Browse buttons for folder selection', async () => {
      await renderSettingsView();

      const browseButtons = screen.getAllByText('Browse');
      expect(browseButtons.length).toBeGreaterThanOrEqual(2);
    });

    it('opens folder picker when Browse is clicked', async () => {
      vi.mocked(window.goodvibes.selectFolder).mockResolvedValue('/selected/path');

      await renderSettingsView();

      const browseButtons = screen.getAllByText('Browse');
      const firstBrowseButton = browseButtons[0];
      if (firstBrowseButton) {
        await act(async () => {
          fireEvent.click(firstBrowseButton);
        });
      }

      await waitFor(() => {
        expect(vi.mocked(window.goodvibes.selectFolder)).toHaveBeenCalled();
      });
    });

    it('sets folder path when folder is selected', async () => {
      vi.mocked(window.goodvibes.selectFolder).mockResolvedValue('/selected/folder');

      await renderSettingsView();

      // Find the default CWD browse button (the first one after Claude Path)
      const browseButtons = screen.getAllByText('Browse');
      const cwdBrowseButton = browseButtons[0];

      if (cwdBrowseButton) {
        await act(async () => {
          fireEvent.click(cwdBrowseButton);
        });

        await waitFor(() => {
          expect(vi.mocked(window.goodvibes.selectFolder)).toHaveBeenCalled();
        });
      }
    });

    it('does not update path when folder selection is cancelled', async () => {
      vi.mocked(window.goodvibes.selectFolder).mockResolvedValue(null);

      await renderSettingsView();

      const browseButtons = screen.getAllByText('Browse');
      const firstBrowseButton = browseButtons[0];
      if (firstBrowseButton) {
        await act(async () => {
          fireEvent.click(firstBrowseButton);
        });
      }

      await waitFor(() => {
        expect(vi.mocked(window.goodvibes.selectFolder)).toHaveBeenCalled();
      });

      // Setting should remain unchanged
      const state = useSettingsStore.getState();
      expect(state.settings.defaultCwd).toBeNull();
    });
  });

  describe('Budget Settings', () => {
    it('renders daily budget input', async () => {
      await renderSettingsView();

      expect(screen.getByText('Daily Budget Limit')).toBeInTheDocument();
    });

    it('renders monthly budget input', async () => {
      await renderSettingsView();

      expect(screen.getByText('Monthly Budget Limit')).toBeInTheDocument();
    });

    it('updates daily budget value on input', async () => {
      await renderSettingsView();

      const budgetInputs = screen.getAllByRole('spinbutton');
      const dailyBudget = budgetInputs[0];

      if (dailyBudget) {
        await act(async () => {
          fireEvent.change(dailyBudget, { target: { value: '10.50' } });
        });
      }

      await waitFor(() => {
        const state = useSettingsStore.getState();
        expect(state.settings.dailyBudget).toBe(10.50);
      });
    });

    it('clears budget when input is emptied', async () => {
      await act(async () => {
        useSettingsStore.setState({
          settings: { ...DEFAULT_SETTINGS, dailyBudget: 25.00 },
          isLoaded: true,
        });
      });

      await renderSettingsView();

      const budgetInputs = screen.getAllByRole('spinbutton');
      const dailyBudget = budgetInputs[0];

      if (dailyBudget) {
        await act(async () => {
          fireEvent.change(dailyBudget, { target: { value: '' } });
        });
      }

      await waitFor(() => {
        const state = useSettingsStore.getState();
        expect(state.settings.dailyBudget).toBeNull();
      });
    });

    it('renders Budget Notifications toggle', async () => {
      await renderSettingsView();

      expect(screen.getByText('Budget Notifications')).toBeInTheDocument();
    });
  });

  describe('Keyboard Shortcuts Display', () => {
    it('displays all keyboard shortcuts', async () => {
      await renderSettingsView();

      expect(screen.getByText('New Terminal')).toBeInTheDocument();
      expect(screen.getByText('Ctrl+N')).toBeInTheDocument();
      expect(screen.getByText('Close Tab')).toBeInTheDocument();
      expect(screen.getByText('Ctrl+W')).toBeInTheDocument();
      expect(screen.getByText('Quick Switcher')).toBeInTheDocument();
      expect(screen.getByText('Ctrl+K')).toBeInTheDocument();
      expect(screen.getByText('Command Palette')).toBeInTheDocument();
      expect(screen.getByText('Ctrl+Shift+P')).toBeInTheDocument();
    });
  });

  describe('Reset Settings', () => {
    it('renders Reset Settings button in Danger Zone', async () => {
      await renderSettingsView();

      const resetButton = screen.getByText('Reset Settings');
      expect(resetButton).toBeInTheDocument();
    });

    it('disables button during reset operation', async () => {
      await act(async () => {
        useSettingsStore.setState({
          settings: { ...DEFAULT_SETTINGS },
          isLoaded: true,
          isUpdating: true,
        });
      });

      const handleReset = vi.fn();
      renderWithProviders(
        <DangerZoneSettings isResetting={true} onReset={handleReset} />
      );

      const resetButton = screen.getByText('Resetting...');
      expect(resetButton).toBeDisabled();
    });

    it('shows "Resetting..." text when isResetting is true', async () => {
      const handleReset = vi.fn();
      renderWithProviders(
        <DangerZoneSettings isResetting={true} onReset={handleReset} />
      );

      expect(screen.getByText('Resetting...')).toBeInTheDocument();
    });
  });

  describe('Session Preview Settings', () => {
    it('renders Show Thinking Blocks toggle', async () => {
      await renderSettingsView();
      expect(screen.getByText('Show Thinking Blocks')).toBeInTheDocument();
    });

    it('renders Show Tool Calls toggle', async () => {
      await renderSettingsView();
      expect(screen.getByText('Show Tool Calls')).toBeInTheDocument();
    });

    it('renders Show Tool Results toggle', async () => {
      await renderSettingsView();
      expect(screen.getByText('Show Tool Results')).toBeInTheDocument();
    });

    it('renders Show System Messages toggle', async () => {
      await renderSettingsView();
      expect(screen.getByText('Show System Messages')).toBeInTheDocument();
    });

    it('renders Show Summaries toggle', async () => {
      await renderSettingsView();
      expect(screen.getByText('Show Summaries')).toBeInTheDocument();
    });

    it('renders Expand settings', async () => {
      await renderSettingsView();

      expect(screen.getByText('Expand User Messages')).toBeInTheDocument();
      expect(screen.getByText('Expand Assistant Responses')).toBeInTheDocument();
      expect(screen.getByText('Expand Thinking Blocks')).toBeInTheDocument();
      expect(screen.getByText('Expand Tool Calls')).toBeInTheDocument();
      expect(screen.getByText('Expand Tool Results')).toBeInTheDocument();
    });
  });

  describe('Git Panel Settings', () => {
    it('renders Git Panel Position selector', async () => {
      await renderSettingsView();
      expect(screen.getByText('Git Panel Position')).toBeInTheDocument();
    });

    it('renders Auto-refresh Git toggle', async () => {
      await renderSettingsView();
      expect(screen.getByText('Auto-refresh Git')).toBeInTheDocument();
    });

    it('renders Show Git Panel on Start toggle', async () => {
      await renderSettingsView();
      expect(screen.getByText('Show Git Panel on Start')).toBeInTheDocument();
    });

    it('changes git panel position', async () => {
      await renderSettingsView();

      const positionSelect = screen.getByDisplayValue('Right');
      await act(async () => {
        fireEvent.change(positionSelect, { target: { value: 'left' } });
      });

      await waitFor(() => {
        const state = useSettingsStore.getState();
        expect(state.settings.gitPanelPosition).toBe('left');
      });
    });
  });

  describe('Startup Behavior', () => {
    it('renders startup behavior selector', async () => {
      await renderSettingsView();
      expect(screen.getByText('On Startup')).toBeInTheDocument();
    });

    it('changes startup behavior to last-project', async () => {
      await renderSettingsView();

      const startupSelect = screen.getByDisplayValue('Show empty state');
      await act(async () => {
        fireEvent.change(startupSelect, { target: { value: 'last-project' } });
      });

      await waitFor(() => {
        const state = useSettingsStore.getState();
        expect(state.settings.startupBehavior).toBe('last-project');
      });
    });

    it('changes startup behavior to folder-picker', async () => {
      await renderSettingsView();

      const startupSelect = screen.getByDisplayValue('Show empty state');
      await act(async () => {
        fireEvent.change(startupSelect, { target: { value: 'folder-picker' } });
      });

      await waitFor(() => {
        const state = useSettingsStore.getState();
        expect(state.settings.startupBehavior).toBe('folder-picker');
      });
    });
  });
});

// ============================================================================
// GITHUB CONNECTION STATUS TESTS
// ============================================================================

describe('GitHubConnectionStatus', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('shows not configured message when OAuth is not set up', async () => {
    vi.mocked(window.goodvibes.githubGetOAuthConfig).mockResolvedValue({
      isConfigured: false,
      source: 'none',
      clientId: null,
    });

    await act(async () => {
      renderWithProviders(<GitHubConnectionStatus />);
      await new Promise(resolve => setTimeout(resolve, 0));
    });

    await waitFor(() => {
      expect(screen.getByText('GitHub Connection')).toBeInTheDocument();
      expect(screen.getByText(/not configured/i)).toBeInTheDocument();
    });
  });

  it('shows Connect GitHub button when OAuth is configured but not authenticated', async () => {
    vi.mocked(window.goodvibes.githubGetOAuthConfig).mockResolvedValue({
      isConfigured: true,
      source: 'environment',
      clientId: 'test-client-id',
    });

    vi.mocked(window.goodvibes.githubGetAuthState).mockResolvedValue({
      isAuthenticated: false,
      user: null,
      accessToken: null,
      tokenExpiresAt: null,
    });

    await act(async () => {
      renderWithProviders(<GitHubConnectionStatus />);
      await new Promise(resolve => setTimeout(resolve, 0));
    });

    await waitFor(() => {
      expect(screen.getByText('Connect GitHub')).toBeInTheDocument();
    });
  });

  it('shows user info when authenticated', async () => {
    vi.mocked(window.goodvibes.githubGetOAuthConfig).mockResolvedValue({
      isConfigured: true,
      source: 'environment',
      clientId: 'test-client-id',
    });

    vi.mocked(window.goodvibes.githubGetAuthState).mockResolvedValue({
      isAuthenticated: true,
      user: {
        id: 1,
        login: 'testuser',
        name: 'Test User',
        email: 'test@example.com',
        avatar_url: 'https://example.com/avatar.png',
      },
      accessToken: 'token',
      tokenExpiresAt: null,
    });

    await act(async () => {
      renderWithProviders(<GitHubConnectionStatus />);
      await new Promise(resolve => setTimeout(resolve, 0));
    });

    await waitFor(() => {
      expect(screen.getByText('@testuser')).toBeInTheDocument();
      expect(screen.getByText('Connected')).toBeInTheDocument();
      expect(screen.getByText('Test User')).toBeInTheDocument();
    });
  });

  it('shows Disconnect button when authenticated', async () => {
    vi.mocked(window.goodvibes.githubGetOAuthConfig).mockResolvedValue({
      isConfigured: true,
      source: 'environment',
      clientId: 'test-client-id',
    });

    vi.mocked(window.goodvibes.githubGetAuthState).mockResolvedValue({
      isAuthenticated: true,
      user: {
        id: 1,
        login: 'testuser',
        name: 'Test User',
        email: 'test@example.com',
        avatar_url: 'https://example.com/avatar.png',
      },
      accessToken: 'token',
      tokenExpiresAt: null,
    });

    await act(async () => {
      renderWithProviders(<GitHubConnectionStatus />);
      await new Promise(resolve => setTimeout(resolve, 0));
    });

    await waitFor(() => {
      expect(screen.getByText('Disconnect')).toBeInTheDocument();
    });
  });

  it('initiates login when Connect GitHub is clicked', async () => {
    vi.mocked(window.goodvibes.githubGetOAuthConfig).mockResolvedValue({
      isConfigured: true,
      source: 'environment',
      clientId: 'test-client-id',
    });

    vi.mocked(window.goodvibes.githubGetAuthState).mockResolvedValue({
      isAuthenticated: false,
      user: null,
      accessToken: null,
      tokenExpiresAt: null,
    });

    vi.mocked(window.goodvibes.githubAuth).mockResolvedValue({
      success: true,
      user: {
        id: 1,
        login: 'newuser',
        name: 'New User',
        email: 'new@example.com',
        avatar_url: 'https://example.com/new-avatar.png',
      },
    });

    await act(async () => {
      renderWithProviders(<GitHubConnectionStatus />);
      await new Promise(resolve => setTimeout(resolve, 0));
    });

    const connectButton = await screen.findByText('Connect GitHub');
    await act(async () => {
      fireEvent.click(connectButton);
    });

    await waitFor(() => {
      expect(vi.mocked(window.goodvibes.githubAuth)).toHaveBeenCalled();
    });
  });

  it('shows error message when login fails', async () => {
    vi.mocked(window.goodvibes.githubGetOAuthConfig).mockResolvedValue({
      isConfigured: true,
      source: 'environment',
      clientId: 'test-client-id',
    });

    vi.mocked(window.goodvibes.githubGetAuthState).mockResolvedValue({
      isAuthenticated: false,
      user: null,
      accessToken: null,
      tokenExpiresAt: null,
    });

    vi.mocked(window.goodvibes.githubAuth).mockResolvedValue({
      success: false,
      error: 'Authentication failed',
    });

    await act(async () => {
      renderWithProviders(<GitHubConnectionStatus />);
      await new Promise(resolve => setTimeout(resolve, 0));
    });

    const connectButton = await screen.findByText('Connect GitHub');
    await act(async () => {
      fireEvent.click(connectButton);
    });

    await waitFor(() => {
      expect(screen.getByText('Authentication failed')).toBeInTheDocument();
    });
  });

  it('logs out when Disconnect is clicked', async () => {
    vi.mocked(window.goodvibes.githubGetOAuthConfig).mockResolvedValue({
      isConfigured: true,
      source: 'environment',
      clientId: 'test-client-id',
    });

    vi.mocked(window.goodvibes.githubGetAuthState).mockResolvedValue({
      isAuthenticated: true,
      user: {
        id: 1,
        login: 'testuser',
        name: 'Test User',
        email: 'test@example.com',
        avatar_url: 'https://example.com/avatar.png',
      },
      accessToken: 'token',
      tokenExpiresAt: null,
    });

    vi.mocked(window.goodvibes.githubLogout).mockResolvedValue({
      success: true,
    });

    await act(async () => {
      renderWithProviders(<GitHubConnectionStatus />);
      await new Promise(resolve => setTimeout(resolve, 0));
    });

    const disconnectButton = await screen.findByText('Disconnect');
    await act(async () => {
      fireEvent.click(disconnectButton);
    });

    await waitFor(() => {
      expect(vi.mocked(window.goodvibes.githubLogout)).toHaveBeenCalled();
    });
  });

  it('shows Connecting... while loading', async () => {
    vi.mocked(window.goodvibes.githubGetOAuthConfig).mockResolvedValue({
      isConfigured: true,
      source: 'environment',
      clientId: 'test-client-id',
    });

    vi.mocked(window.goodvibes.githubGetAuthState).mockResolvedValue({
      isAuthenticated: false,
      user: null,
      accessToken: null,
      tokenExpiresAt: null,
    });

    // Make auth take a while
    vi.mocked(window.goodvibes.githubAuth).mockImplementation(
      () => new Promise(resolve => setTimeout(() => resolve({ success: true, user: null }), 1000))
    );

    await act(async () => {
      renderWithProviders(<GitHubConnectionStatus />);
      await new Promise(resolve => setTimeout(resolve, 0));
    });

    const connectButton = await screen.findByText('Connect GitHub');
    await act(async () => {
      fireEvent.click(connectButton);
    });

    expect(screen.getByText('Connecting...')).toBeInTheDocument();
  });
});

// ============================================================================
// MAINTENANCE SETTINGS TESTS
// ============================================================================

describe('MaintenanceSettings', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders Recalculate Session Costs button', async () => {
    await act(async () => {
      renderWithProviders(<MaintenanceSettings />);
    });

    expect(screen.getByText('Recalculate Session Costs')).toBeInTheDocument();
    expect(screen.getByText('Recalculate')).toBeInTheDocument();
  });

  it('shows description for recalculate costs', async () => {
    await act(async () => {
      renderWithProviders(<MaintenanceSettings />);
    });

    expect(screen.getByText(/Re-parse all sessions with updated pricing/)).toBeInTheDocument();
  });

  it('calls recalculateSessionCosts when clicked', async () => {
    vi.mocked(window.goodvibes.recalculateSessionCosts).mockResolvedValue({
      success: true,
      count: 10,
    });

    await act(async () => {
      renderWithProviders(<MaintenanceSettings />);
    });

    const recalculateButton = screen.getByText('Recalculate');
    await act(async () => {
      fireEvent.click(recalculateButton);
    });

    await waitFor(() => {
      expect(vi.mocked(window.goodvibes.recalculateSessionCosts)).toHaveBeenCalled();
    });
  });

  it('shows Recalculating... while processing', async () => {
    vi.mocked(window.goodvibes.recalculateSessionCosts).mockImplementation(
      () => new Promise(resolve => setTimeout(() => resolve({ success: true, count: 5 }), 1000))
    );

    await act(async () => {
      renderWithProviders(<MaintenanceSettings />);
    });

    const recalculateButton = screen.getByText('Recalculate');
    await act(async () => {
      fireEvent.click(recalculateButton);
    });

    expect(screen.getByText('Recalculating...')).toBeInTheDocument();
  });

  it('disables button while recalculating', async () => {
    vi.mocked(window.goodvibes.recalculateSessionCosts).mockImplementation(
      () => new Promise(resolve => setTimeout(() => resolve({ success: true, count: 5 }), 1000))
    );

    await act(async () => {
      renderWithProviders(<MaintenanceSettings />);
    });

    const recalculateButton = screen.getByText('Recalculate');
    await act(async () => {
      fireEvent.click(recalculateButton);
    });

    const recalculatingButton = screen.getByText('Recalculating...');
    expect(recalculatingButton).toBeDisabled();
  });
});

// ============================================================================
// TERMINAL SETTINGS TESTS
// ============================================================================

describe('TerminalSettings', () => {
  const mockSettings = createMockSettings();
  const mockOnChange = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(window.goodvibes.getPlatform).mockReturnValue('win32');
    vi.mocked(window.goodvibes.getAvailableEditors).mockResolvedValue([
      { name: 'VS Code', command: 'code', available: true },
      { name: 'Notepad++', command: 'notepad++', available: true },
    ]);
  });

  it('renders Default Shell selector', async () => {
    await act(async () => {
      renderWithProviders(<TerminalSettings settings={mockSettings} onChange={mockOnChange} />);
      await new Promise(resolve => setTimeout(resolve, 0));
    });

    expect(screen.getByText('Default Shell')).toBeInTheDocument();
  });

  it('shows Windows shells on Windows platform', async () => {
    vi.mocked(window.goodvibes.getPlatform).mockReturnValue('win32');

    await act(async () => {
      renderWithProviders(<TerminalSettings settings={mockSettings} onChange={mockOnChange} />);
      await new Promise(resolve => setTimeout(resolve, 0));
    });

    const shellSelect = screen.getByDisplayValue('System Default');
    expect(shellSelect).toContainHTML('cmd.exe');
    expect(shellSelect).toContainHTML('powershell.exe');
  });

  it('shows Unix shells on Unix platform', async () => {
    vi.mocked(window.goodvibes.getPlatform).mockReturnValue('darwin');

    await act(async () => {
      renderWithProviders(<TerminalSettings settings={mockSettings} onChange={mockOnChange} />);
      await new Promise(resolve => setTimeout(resolve, 0));
    });

    const shellSelect = screen.getByDisplayValue('System Default');
    expect(shellSelect).toContainHTML('/bin/bash');
    expect(shellSelect).toContainHTML('/bin/zsh');
  });

  it('calls onChange when shell is selected', async () => {
    await act(async () => {
      renderWithProviders(<TerminalSettings settings={mockSettings} onChange={mockOnChange} />);
      await new Promise(resolve => setTimeout(resolve, 0));
    });

    const shellSelect = screen.getByDisplayValue('System Default');
    await act(async () => {
      fireEvent.change(shellSelect, { target: { value: 'cmd.exe' } });
    });

    expect(mockOnChange).toHaveBeenCalledWith('preferredShell', 'cmd.exe');
  });

  it('sets preferredShell to null when System Default is selected', async () => {
    const settingsWithShell = createMockSettings({ preferredShell: 'cmd.exe' });

    await act(async () => {
      renderWithProviders(<TerminalSettings settings={settingsWithShell} onChange={mockOnChange} />);
      await new Promise(resolve => setTimeout(resolve, 0));
    });

    const shellSelect = screen.getByDisplayValue('Command Prompt (cmd.exe)');
    await act(async () => {
      fireEvent.change(shellSelect, { target: { value: '' } });
    });

    expect(mockOnChange).toHaveBeenCalledWith('preferredShell', null);
  });

  it('renders Default Text Editor selector', async () => {
    await act(async () => {
      renderWithProviders(<TerminalSettings settings={mockSettings} onChange={mockOnChange} />);
      await new Promise(resolve => setTimeout(resolve, 0));
    });

    expect(screen.getByText('Default Text Editor')).toBeInTheDocument();
  });

  it('shows available text editors', async () => {
    await act(async () => {
      renderWithProviders(<TerminalSettings settings={mockSettings} onChange={mockOnChange} />);
      await new Promise(resolve => setTimeout(resolve, 0));
    });

    await waitFor(() => {
      const editorSelect = screen.getAllByDisplayValue('Auto-detect (first available)')[0];
      expect(editorSelect).toContainHTML('VS Code');
      expect(editorSelect).toContainHTML('Notepad++');
    });
  });

  it('renders Add custom shell option', async () => {
    await act(async () => {
      renderWithProviders(<TerminalSettings settings={mockSettings} onChange={mockOnChange} />);
      await new Promise(resolve => setTimeout(resolve, 0));
    });

    const shellSelect = screen.getByDisplayValue('System Default');
    expect(shellSelect).toContainHTML('+ Add custom...');
  });

  it('shows custom shells in dropdown', async () => {
    const settingsWithCustomShells = createMockSettings({
      customShells: ['C:\\MyShell\\shell.exe'],
    });

    await act(async () => {
      renderWithProviders(<TerminalSettings settings={settingsWithCustomShells} onChange={mockOnChange} />);
      await new Promise(resolve => setTimeout(resolve, 0));
    });

    const shellSelect = screen.getByDisplayValue('System Default');
    expect(shellSelect).toContainHTML('C:\\MyShell\\shell.exe (custom)');
  });
});

// ============================================================================
// GITHUB SETTINGS TESTS
// ============================================================================

describe('GitHubSettings', () => {
  const mockSettings = createMockSettings();
  const mockOnChange = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(window.goodvibes.githubGetAuthState).mockResolvedValue({
      isAuthenticated: false,
      user: null,
      accessToken: null,
      tokenExpiresAt: null,
    });
    vi.mocked(window.goodvibes.githubGetOAuthConfig).mockResolvedValue({
      isConfigured: false,
      source: 'none',
      clientId: null,
    });
  });

  it('renders GitHub Integration section', async () => {
    await act(async () => {
      renderWithProviders(<GitHubSettings settings={mockSettings} onChange={mockOnChange} />);
      await new Promise(resolve => setTimeout(resolve, 0));
    });

    expect(screen.getByText('GitHub Integration')).toBeInTheDocument();
  });

  it('renders Enable GitHub Integration toggle', async () => {
    await act(async () => {
      renderWithProviders(<GitHubSettings settings={mockSettings} onChange={mockOnChange} />);
      await new Promise(resolve => setTimeout(resolve, 0));
    });

    expect(screen.getByText('Enable GitHub Integration')).toBeInTheDocument();
  });

  it('renders Show in Git Panel toggle', async () => {
    await act(async () => {
      renderWithProviders(<GitHubSettings settings={mockSettings} onChange={mockOnChange} />);
      await new Promise(resolve => setTimeout(resolve, 0));
    });

    expect(screen.getByText('Show in Git Panel')).toBeInTheDocument();
  });

  it('renders Auto-load Pull Requests toggle', async () => {
    await act(async () => {
      renderWithProviders(<GitHubSettings settings={mockSettings} onChange={mockOnChange} />);
      await new Promise(resolve => setTimeout(resolve, 0));
    });

    expect(screen.getByText('Auto-load Pull Requests')).toBeInTheDocument();
  });

  it('renders Auto-load CI Status toggle', async () => {
    await act(async () => {
      renderWithProviders(<GitHubSettings settings={mockSettings} onChange={mockOnChange} />);
      await new Promise(resolve => setTimeout(resolve, 0));
    });

    expect(screen.getByText('Auto-load CI Status')).toBeInTheDocument();
  });

  it('toggles GitHub enabled setting', async () => {
    await act(async () => {
      renderWithProviders(<GitHubSettings settings={mockSettings} onChange={mockOnChange} />);
      await new Promise(resolve => setTimeout(resolve, 0));
    });

    const enableLabel = screen.getByText('Enable GitHub Integration');
    const settingRow = enableLabel.closest('.flex');
    const toggle = settingRow?.querySelector('[role="switch"]');

    if (toggle) {
      await act(async () => {
        fireEvent.click(toggle);
      });

      expect(mockOnChange).toHaveBeenCalledWith('githubEnabled', false);
    }
  });
});

// ============================================================================
// SHARED COMPONENT TESTS
// ============================================================================

describe('SettingsSection', () => {
  it('renders title and children', () => {
    render(
      <SettingsSection title="Test Section">
        <div data-testid="child-content">Content</div>
      </SettingsSection>
    );

    expect(screen.getByText('Test Section')).toBeInTheDocument();
    expect(screen.getByTestId('child-content')).toBeInTheDocument();
  });

  it('renders collapsed preview when collapsible and not expanded', () => {
    render(
      <SettingsSection
        title="Collapsible Section"
        collapsible
        defaultExpanded={false}
        collapsedPreview={<div data-testid="preview">Preview Content</div>}
      >
        <div data-testid="full-content">Full Content</div>
      </SettingsSection>
    );

    expect(screen.getByTestId('preview')).toBeInTheDocument();
    expect(screen.queryByTestId('full-content')).not.toBeInTheDocument();
  });

  it('expands when collapsible section is clicked', async () => {
    render(
      <SettingsSection
        title="Collapsible Section"
        collapsible
        defaultExpanded={false}
        collapsedPreview={<div data-testid="preview">Preview Content</div>}
      >
        <div data-testid="full-content">Full Content</div>
      </SettingsSection>
    );

    const titleButton = screen.getByText('Collapsible Section').closest('button');
    if (titleButton) {
      await act(async () => {
        fireEvent.click(titleButton);
      });
    }

    await waitFor(() => {
      expect(screen.getByTestId('full-content')).toBeInTheDocument();
    });
  });

  it('shows expanded content when defaultExpanded is true', () => {
    render(
      <SettingsSection
        title="Expanded Section"
        collapsible
        defaultExpanded={true}
        collapsedPreview={<div data-testid="preview">Preview Content</div>}
      >
        <div data-testid="full-content">Full Content</div>
      </SettingsSection>
    );

    expect(screen.getByTestId('full-content')).toBeInTheDocument();
  });
});

describe('SettingRow', () => {
  it('renders label and children', () => {
    render(
      <SettingRow label="Test Label">
        <input data-testid="test-input" />
      </SettingRow>
    );

    expect(screen.getByText('Test Label')).toBeInTheDocument();
    expect(screen.getByTestId('test-input')).toBeInTheDocument();
  });

  it('renders description when provided', () => {
    render(
      <SettingRow label="Test Label" description="This is a description">
        <input />
      </SettingRow>
    );

    expect(screen.getByText('This is a description')).toBeInTheDocument();
  });

  it('does not render description when not provided', () => {
    render(
      <SettingRow label="Test Label">
        <input />
      </SettingRow>
    );

    const descriptionElements = document.querySelectorAll('.text-xs.text-surface-500');
    expect(descriptionElements.length).toBe(0);
  });
});

describe('ToggleSwitch', () => {
  it('renders with correct initial state', () => {
    render(<ToggleSwitch checked={false} onChange={() => {}} />);

    const toggle = screen.getByRole('switch');
    expect(toggle).toHaveAttribute('aria-checked', 'false');
  });

  it('shows checked state correctly', () => {
    render(<ToggleSwitch checked={true} onChange={() => {}} />);

    const toggle = screen.getByRole('switch');
    expect(toggle).toHaveAttribute('aria-checked', 'true');
  });

  it('calls onChange with opposite value when clicked', async () => {
    const handleChange = vi.fn();
    render(<ToggleSwitch checked={false} onChange={handleChange} />);

    const toggle = screen.getByRole('switch');
    await act(async () => {
      fireEvent.click(toggle);
    });

    expect(handleChange).toHaveBeenCalledWith(true);
  });

  it('calls onChange with false when unchecking', async () => {
    const handleChange = vi.fn();
    render(<ToggleSwitch checked={true} onChange={handleChange} />);

    const toggle = screen.getByRole('switch');
    await act(async () => {
      fireEvent.click(toggle);
    });

    expect(handleChange).toHaveBeenCalledWith(false);
  });

  it('prevents event propagation', async () => {
    const handleChange = vi.fn();
    const parentHandler = vi.fn();

    render(
      <div onClick={parentHandler}>
        <ToggleSwitch checked={false} onChange={handleChange} />
      </div>
    );

    const toggle = screen.getByRole('switch');
    await act(async () => {
      fireEvent.click(toggle);
    });

    expect(handleChange).toHaveBeenCalled();
    expect(parentHandler).not.toHaveBeenCalled();
  });
});

describe('ShortcutRow', () => {
  it('renders action and shortcut', () => {
    render(<ShortcutRow action="Test Action" shortcut="Ctrl+T" />);

    expect(screen.getByText('Test Action')).toBeInTheDocument();
    expect(screen.getByText('Ctrl+T')).toBeInTheDocument();
  });

  it('renders shortcut in kbd element', () => {
    render(<ShortcutRow action="Test Action" shortcut="Ctrl+T" />);

    const kbd = screen.getByText('Ctrl+T');
    expect(kbd.tagName).toBe('KBD');
  });
});

// ============================================================================
// KEYBOARD SETTINGS TESTS
// ============================================================================

describe('KeyboardSettings', () => {
  it('renders all keyboard shortcuts', () => {
    renderWithProviders(<KeyboardSettings />);

    // Verify all shortcuts are displayed
    expect(screen.getByText('New Terminal')).toBeInTheDocument();
    expect(screen.getByText('Close Tab')).toBeInTheDocument();
    expect(screen.getByText('Next Tab')).toBeInTheDocument();
    expect(screen.getByText('Previous Tab')).toBeInTheDocument();
    expect(screen.getByText('Quick Switcher')).toBeInTheDocument();
    expect(screen.getByText('Command Palette')).toBeInTheDocument();
    expect(screen.getByText('Search Terminal')).toBeInTheDocument();
    expect(screen.getByText('Zoom In')).toBeInTheDocument();
    expect(screen.getByText('Zoom Out')).toBeInTheDocument();
    expect(screen.getByText('Reset Zoom')).toBeInTheDocument();
  });

  it('renders correct shortcut keys', () => {
    renderWithProviders(<KeyboardSettings />);

    expect(screen.getByText('Ctrl+N')).toBeInTheDocument();
    expect(screen.getByText('Ctrl+W')).toBeInTheDocument();
    expect(screen.getByText('Ctrl+Tab')).toBeInTheDocument();
    expect(screen.getByText('Ctrl+Shift+Tab')).toBeInTheDocument();
    expect(screen.getByText('Ctrl+K')).toBeInTheDocument();
    expect(screen.getByText('Ctrl+Shift+P')).toBeInTheDocument();
    expect(screen.getByText('Ctrl+F')).toBeInTheDocument();
    expect(screen.getByText('Ctrl++')).toBeInTheDocument();
    expect(screen.getByText('Ctrl+-')).toBeInTheDocument();
    expect(screen.getByText('Ctrl+0')).toBeInTheDocument();
  });
});

// ============================================================================
// SESSION PREVIEW SETTINGS TESTS
// ============================================================================

describe('SessionPreviewVisibilitySettings', () => {
  const mockSettings = createMockSettings();
  const mockOnChange = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders all visibility toggles', () => {
    renderWithProviders(
      <SessionPreviewVisibilitySettings settings={mockSettings} onChange={mockOnChange} />
    );

    expect(screen.getByText('Show Thinking Blocks')).toBeInTheDocument();
    expect(screen.getByText('Show Tool Calls')).toBeInTheDocument();
    expect(screen.getByText('Show Tool Results')).toBeInTheDocument();
    expect(screen.getByText('Show System Messages')).toBeInTheDocument();
    expect(screen.getByText('Show Summaries')).toBeInTheDocument();
  });

  it('toggles Show Thinking Blocks setting', async () => {
    renderWithProviders(
      <SessionPreviewVisibilitySettings settings={mockSettings} onChange={mockOnChange} />
    );

    const label = screen.getByText('Show Thinking Blocks');
    const settingRow = label.closest('.flex');
    const toggle = settingRow?.querySelector('[role="switch"]');

    if (toggle) {
      await act(async () => {
        fireEvent.click(toggle);
      });

      expect(mockOnChange).toHaveBeenCalledWith('showThinkingBlocks', false);
    }
  });
});

describe('SessionPreviewExpandSettings', () => {
  const mockSettings = createMockSettings();
  const mockOnChange = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders all expand toggles', () => {
    renderWithProviders(
      <SessionPreviewExpandSettings settings={mockSettings} onChange={mockOnChange} />
    );

    expect(screen.getByText('Expand User Messages')).toBeInTheDocument();
    expect(screen.getByText('Expand Assistant Responses')).toBeInTheDocument();
    expect(screen.getByText('Expand Thinking Blocks')).toBeInTheDocument();
    expect(screen.getByText('Expand Tool Calls')).toBeInTheDocument();
    expect(screen.getByText('Expand Tool Results')).toBeInTheDocument();
    expect(screen.getByText('Expand System Messages')).toBeInTheDocument();
    expect(screen.getByText('Expand Summaries')).toBeInTheDocument();
  });

  it('toggles Expand User Messages setting', async () => {
    renderWithProviders(
      <SessionPreviewExpandSettings settings={mockSettings} onChange={mockOnChange} />
    );

    const label = screen.getByText('Expand User Messages');
    const settingRow = label.closest('.flex');
    const toggle = settingRow?.querySelector('[role="switch"]');

    if (toggle) {
      await act(async () => {
        fireEvent.click(toggle);
      });

      expect(mockOnChange).toHaveBeenCalledWith('expandUserByDefault', false);
    }
  });
});

// ============================================================================
// BACKUP SETTINGS TESTS
// ============================================================================

describe('BackupSettings', () => {
  const mockSettings = createMockSettings();
  const mockOnChange = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders Auto-Backup Sessions toggle', () => {
    renderWithProviders(
      <BackupSettings settings={mockSettings} onChange={mockOnChange} />
    );

    expect(screen.getByText('Auto-Backup Sessions')).toBeInTheDocument();
    expect(screen.getByText(/Automatically backup Claude sessions/)).toBeInTheDocument();
  });

  it('toggles session backup setting', async () => {
    renderWithProviders(
      <BackupSettings settings={mockSettings} onChange={mockOnChange} />
    );

    const label = screen.getByText('Auto-Backup Sessions');
    const settingRow = label.closest('.flex');
    const toggle = settingRow?.querySelector('[role="switch"]');

    if (toggle) {
      await act(async () => {
        fireEvent.click(toggle);
      });

      expect(mockOnChange).toHaveBeenCalledWith('sessionBackupEnabled', false);
    }
  });
});

// ============================================================================
// DANGER ZONE SETTINGS TESTS
// ============================================================================

describe('DangerZoneSettings', () => {
  it('renders Reset All Settings button', () => {
    const handleReset = vi.fn();
    renderWithProviders(
      <DangerZoneSettings isResetting={false} onReset={handleReset} />
    );

    expect(screen.getByText('Reset All Settings')).toBeInTheDocument();
    expect(screen.getByText('Reset Settings')).toBeInTheDocument();
  });

  it('renders description', () => {
    const handleReset = vi.fn();
    renderWithProviders(
      <DangerZoneSettings isResetting={false} onReset={handleReset} />
    );

    expect(screen.getByText('Restore all settings to their default values')).toBeInTheDocument();
  });

  it('calls onReset when button is clicked', async () => {
    const handleReset = vi.fn();
    renderWithProviders(
      <DangerZoneSettings isResetting={false} onReset={handleReset} />
    );

    const resetButton = screen.getByText('Reset Settings');
    await act(async () => {
      fireEvent.click(resetButton);
    });

    expect(handleReset).toHaveBeenCalled();
  });

  it('shows Resetting... when isResetting is true', () => {
    const handleReset = vi.fn();
    renderWithProviders(
      <DangerZoneSettings isResetting={true} onReset={handleReset} />
    );

    expect(screen.getByText('Resetting...')).toBeInTheDocument();
  });

  it('disables button when isResetting is true', () => {
    const handleReset = vi.fn();
    renderWithProviders(
      <DangerZoneSettings isResetting={true} onReset={handleReset} />
    );

    const resetButton = screen.getByText('Resetting...');
    expect(resetButton).toBeDisabled();
  });
});

// ============================================================================
// SETTINGS STORE INTEGRATION TESTS
// ============================================================================

describe('SettingsView Store Integration', () => {
  beforeEach(async () => {
    vi.mocked(window.goodvibes.githubGetAuthState).mockResolvedValue({
      isAuthenticated: false,
      user: null,
      accessToken: null,
      tokenExpiresAt: null,
    });

    vi.mocked(window.goodvibes.githubGetOAuthConfig).mockResolvedValue({
      isConfigured: false,
      source: 'none',
      clientId: null,
    });

    vi.mocked(window.goodvibes.getPlatform).mockReturnValue('win32');
    vi.mocked(window.goodvibes.getAvailableEditors).mockResolvedValue([]);

    await act(async () => {
      useSettingsStore.setState({
        settings: { ...DEFAULT_SETTINGS },
        isLoaded: true,
      });
    });
  });

  it('persists settings changes to store', async () => {
    await renderSettingsView();

    // Change font size instead of theme (theme is now a color theme grid)
    const increaseButton = screen.getByLabelText('Increase font size');
    await act(async () => {
      fireEvent.click(increaseButton);
    });

    await waitFor(() => {
      const state = useSettingsStore.getState();
      expect(state.settings.fontSize).toBe(15);
    });
  });

  it('persists multiple settings changes', async () => {
    await renderSettingsView();

    // Change font size
    const increaseButton = screen.getByLabelText('Increase font size');
    await act(async () => {
      fireEvent.click(increaseButton);
    });

    // Change startup behavior
    const startupSelect = screen.getByDisplayValue('Show empty state');
    await act(async () => {
      fireEvent.change(startupSelect, { target: { value: 'last-project' } });
    });

    await waitFor(() => {
      const state = useSettingsStore.getState();
      expect(state.settings.fontSize).toBe(15);
      expect(state.settings.startupBehavior).toBe('last-project');
    });
  });

  it('maintains settings after re-render', async () => {
    await act(async () => {
      useSettingsStore.setState({
        settings: { ...DEFAULT_SETTINGS, fontSize: 18, gitPanelPosition: 'left' },
        isLoaded: true,
      });
    });

    const { unmount } = await renderSettingsView();

    // Verify initial state
    expect(screen.getByText('18px')).toBeInTheDocument();
    expect(screen.getByDisplayValue('Left')).toBeInTheDocument();

    // Unmount and re-render
    await act(async () => {
      unmount();
    });

    await renderSettingsView();

    // Verify state persisted
    expect(screen.getByText('18px')).toBeInTheDocument();
    expect(screen.getByDisplayValue('Left')).toBeInTheDocument();
  });

  it('handles setting update errors gracefully', async () => {
    vi.mocked(window.goodvibes.setSetting).mockRejectedValueOnce(new Error('Failed to save'));

    await renderSettingsView();

    // Try to change font size - this will trigger the failing setSetting
    const increaseButton = screen.getByLabelText('Increase font size');
    await act(async () => {
      fireEvent.click(increaseButton);
    });

    // The store should handle the error gracefully
    await waitFor(() => {
      expect(vi.mocked(window.goodvibes.setSetting)).toHaveBeenCalled();
    });
  });
});
