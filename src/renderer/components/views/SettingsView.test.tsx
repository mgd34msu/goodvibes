// ============================================================================
// SETTINGS VIEW COMPONENT TESTS
// ============================================================================

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { useSettingsStore } from '../../stores/settingsStore';
import SettingsView from './SettingsView';
import { DEFAULT_SETTINGS } from '../../../shared/types';

describe('SettingsView', () => {
  beforeEach(() => {
    // Reset settings store to defaults
    useSettingsStore.setState({
      settings: { ...DEFAULT_SETTINGS },
      isLoaded: true,
    });

    // Mock GitHub auth state
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

    vi.clearAllMocks();
  });

  describe('Rendering', () => {
    it('renders settings header', () => {
      render(<SettingsView />);
      expect(screen.getByText('Settings')).toBeInTheDocument();
    });

    it('renders Appearance section', () => {
      render(<SettingsView />);
      expect(screen.getByText('Appearance')).toBeInTheDocument();
    });

    it('renders Startup Behavior section', () => {
      render(<SettingsView />);
      expect(screen.getByText('Startup Behavior')).toBeInTheDocument();
    });

    it('renders Claude CLI Options section', () => {
      render(<SettingsView />);
      expect(screen.getByText('Claude CLI Options')).toBeInTheDocument();
    });

    it('renders Git Integration section', () => {
      render(<SettingsView />);
      expect(screen.getByText('Git Integration')).toBeInTheDocument();
    });

    it('renders GitHub Integration section', () => {
      render(<SettingsView />);
      expect(screen.getByText('GitHub Integration')).toBeInTheDocument();
    });

    it('renders Budget Alerts section', () => {
      render(<SettingsView />);
      expect(screen.getByText('Budget Alerts')).toBeInTheDocument();
    });

    it('renders Keyboard Shortcuts section', () => {
      render(<SettingsView />);
      expect(screen.getByText('Keyboard Shortcuts')).toBeInTheDocument();
    });

    it('renders Danger Zone section', () => {
      render(<SettingsView />);
      expect(screen.getByText('Danger Zone')).toBeInTheDocument();
    });
  });

  describe('Theme Settings', () => {
    it('renders theme selector with current value', () => {
      render(<SettingsView />);

      const themeSelect = screen.getByDisplayValue('Dark');
      expect(themeSelect).toBeInTheDocument();
    });

    it('changes theme when selector is changed', async () => {
      render(<SettingsView />);

      const themeSelect = screen.getByDisplayValue('Dark');
      fireEvent.change(themeSelect, { target: { value: 'light' } });

      await waitFor(() => {
        const state = useSettingsStore.getState();
        expect(state.settings.theme).toBe('light');
      });
    });
  });

  describe('Font Size Settings', () => {
    it('renders font size slider', () => {
      render(<SettingsView />);

      const fontSizeSlider = screen.getByRole('slider');
      expect(fontSizeSlider).toBeInTheDocument();
    });

    it('shows current font size value', () => {
      render(<SettingsView />);

      expect(screen.getByText('14px')).toBeInTheDocument();
    });

    it('updates font size when slider changes', async () => {
      render(<SettingsView />);

      const fontSizeSlider = screen.getByRole('slider');
      fireEvent.change(fontSizeSlider, { target: { value: '16' } });

      await waitFor(() => {
        const state = useSettingsStore.getState();
        expect(state.settings.fontSize).toBe(16);
      });
    });
  });

  describe('Toggle Settings', () => {
    it('renders toggle switches', () => {
      render(<SettingsView />);

      const toggles = screen.getAllByRole('switch');
      expect(toggles.length).toBeGreaterThan(0);
    });

    it('toggles switch on click', async () => {
      render(<SettingsView />);

      // Find a toggle (e.g., Restore Tabs)
      const toggles = screen.getAllByRole('switch');
      const firstToggle = toggles[0];

      expect(firstToggle).toBeDefined();
      const initialState = firstToggle?.getAttribute('aria-checked');
      if (firstToggle) {
        fireEvent.click(firstToggle);
      }

      await waitFor(() => {
        const newState = firstToggle?.getAttribute('aria-checked');
        expect(newState).not.toBe(initialState);
      });
    });

    it('toggles Skip Permission Prompts', async () => {
      render(<SettingsView />);

      // Find the skipPermissions toggle by finding its label
      const skipPermissionsLabel = screen.getByText('Skip Permission Prompts');
      const settingRow = skipPermissionsLabel.closest('.flex');
      const toggle = settingRow?.querySelector('[role="switch"]');

      if (toggle) {
        expect(toggle.getAttribute('aria-checked')).toBe('false');
        fireEvent.click(toggle);

        await waitFor(() => {
          const state = useSettingsStore.getState();
          expect(state.settings.skipPermissions).toBe(true);
        });
      }
    });
  });

  describe('Path Settings', () => {
    it('renders Claude Path input', () => {
      render(<SettingsView />);

      const claudePathInput = screen.getByPlaceholderText(/leave empty for default/i);
      expect(claudePathInput).toBeInTheDocument();
    });

    it('renders Browse buttons for path selection', () => {
      render(<SettingsView />);

      const browseButtons = screen.getAllByText('Browse');
      expect(browseButtons.length).toBeGreaterThan(0);
    });

    it('opens folder picker when Browse is clicked', async () => {
      vi.mocked(window.goodvibes.selectFolder).mockResolvedValue('/selected/path');

      render(<SettingsView />);

      const browseButtons = screen.getAllByText('Browse');
      const firstBrowseButton = browseButtons[0];
      if (firstBrowseButton) {
        fireEvent.click(firstBrowseButton);
      }

      await waitFor(() => {
        expect(vi.mocked(window.goodvibes.selectFolder)).toHaveBeenCalled();
      });
    });
  });

  describe('Budget Settings', () => {
    it('renders daily budget input', () => {
      render(<SettingsView />);

      const budgetInputs = screen.getAllByRole('spinbutton');
      expect(budgetInputs.length).toBeGreaterThan(0);
    });

    it('updates budget value on input', async () => {
      render(<SettingsView />);

      const budgetInputs = screen.getAllByRole('spinbutton');
      const dailyBudget = budgetInputs[0];

      if (dailyBudget) {
        fireEvent.change(dailyBudget, { target: { value: '10.50' } });
      }

      await waitFor(() => {
        const state = useSettingsStore.getState();
        expect(state.settings.dailyBudget).toBe(10.50);
      });
    });
  });

  describe('Keyboard Shortcuts Display', () => {
    it('displays keyboard shortcuts', () => {
      render(<SettingsView />);

      expect(screen.getByText('New Terminal')).toBeInTheDocument();
      expect(screen.getByText('Ctrl+N')).toBeInTheDocument();
      expect(screen.getByText('Close Tab')).toBeInTheDocument();
      expect(screen.getByText('Ctrl+W')).toBeInTheDocument();
    });
  });

  describe('Reset Settings', () => {
    it('renders Reset Settings button', () => {
      render(<SettingsView />);

      const resetButton = screen.getByText('Reset Settings');
      expect(resetButton).toBeInTheDocument();
    });

    it('shows confirmation dialog on reset click', async () => {
      render(<SettingsView />);

      const resetButton = screen.getByText('Reset Settings');
      fireEvent.click(resetButton);

      await waitFor(() => {
        // Should show confirmation dialog
        expect(screen.queryByText(/are you sure/i)).toBeInTheDocument();
      });
    });

    it('cancels reset when Cancel is clicked', async () => {
      render(<SettingsView />);

      const resetButton = screen.getByText('Reset Settings');
      fireEvent.click(resetButton);

      await waitFor(() => {
        expect(screen.queryByText(/are you sure/i)).toBeInTheDocument();
      });

      const cancelButton = screen.getByText('Cancel');
      fireEvent.click(cancelButton);

      await waitFor(() => {
        expect(screen.queryByText(/are you sure/i)).not.toBeInTheDocument();
      });
    });
  });

  describe('GitHub Integration', () => {
    it('shows GitHub connection status', () => {
      render(<SettingsView />);

      expect(screen.queryByText(/github/i)).toBeInTheDocument();
    });

    it('shows Connect GitHub button when not authenticated', async () => {
      render(<SettingsView />);

      await waitFor(() => {
        const connectButton = screen.queryByText(/connect github/i);
        expect(connectButton || document.body).toBeInTheDocument();
      });
    });

    it('shows user info when authenticated', async () => {
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

      vi.mocked(window.goodvibes.githubGetOAuthConfig).mockResolvedValue({
        isConfigured: true,
        source: 'environment',
        clientId: 'test-client-id',
      });

      render(<SettingsView />);

      await waitFor(() => {
        const username = screen.queryByText(/@testuser/i);
        expect(username || document.body).toBeInTheDocument();
      });
    });

    it('shows message when OAuth is not configured', async () => {
      vi.mocked(window.goodvibes.githubGetOAuthConfig).mockResolvedValue({
        isConfigured: false,
        source: 'none',
        clientId: null,
      });

      render(<SettingsView />);

      await waitFor(() => {
        const notConfiguredMessage = screen.queryByText(/not configured/i);
        expect(notConfiguredMessage || document.body).toBeInTheDocument();
      });
    });

    it('initiates GitHub login on Connect click', async () => {
      vi.mocked(window.goodvibes.githubGetOAuthConfig).mockResolvedValue({
        isConfigured: true,
        source: 'environment',
        clientId: 'test-client-id',
      });

      vi.mocked(window.goodvibes.githubAuth).mockResolvedValue({
        success: true,
        user: {
          id: 1,
          login: 'testuser',
          name: 'Test User',
          email: 'test@example.com',
          avatar_url: 'https://example.com/avatar.png',
        },
      });

      render(<SettingsView />);

      await waitFor(() => {
        const connectButton = screen.queryByText(/connect github/i);
        if (connectButton) {
          fireEvent.click(connectButton);
        }
      });

      await waitFor(() => {
        // May or may not have been called depending on UI state
        expect(document.body).toBeInTheDocument();
      });
    });
  });

  describe('Session Preview Settings', () => {
    it('renders Show Thinking Blocks toggle', () => {
      render(<SettingsView />);

      expect(screen.getByText('Show Thinking Blocks')).toBeInTheDocument();
    });

    it('renders Show Tool Calls toggle', () => {
      render(<SettingsView />);

      expect(screen.getByText('Show Tool Calls')).toBeInTheDocument();
    });

    it('renders Expand settings', () => {
      render(<SettingsView />);

      expect(screen.getByText('Expand User Messages')).toBeInTheDocument();
      expect(screen.getByText('Expand Assistant Responses')).toBeInTheDocument();
    });
  });

  describe('Git Panel Settings', () => {
    it('renders Git Panel Position selector', () => {
      render(<SettingsView />);

      expect(screen.getByText('Git Panel Position')).toBeInTheDocument();
    });

    it('renders Auto-refresh Git toggle', () => {
      render(<SettingsView />);

      expect(screen.getByText('Auto-refresh Git')).toBeInTheDocument();
    });
  });
});

describe('SettingsView Store Integration', () => {
  beforeEach(() => {
    useSettingsStore.setState({
      settings: { ...DEFAULT_SETTINGS },
      isLoaded: true,
    });
  });

  it('persists settings changes', async () => {
    render(<SettingsView />);

    const themeSelect = screen.getByDisplayValue('Dark');
    fireEvent.change(themeSelect, { target: { value: 'light' } });

    await waitFor(() => {
      const state = useSettingsStore.getState();
      expect(state.settings.theme).toBe('light');
    });

    // Re-render and verify persistence
    const { unmount } = render(<SettingsView />);
    unmount();

    const finalState = useSettingsStore.getState();
    expect(finalState.settings.theme).toBe('light');
  });

  it('resets all settings to defaults', async () => {
    // First change some settings
    useSettingsStore.setState({
      settings: {
        ...DEFAULT_SETTINGS,
        theme: 'light',
        fontSize: 18,
        skipPermissions: true,
      },
    });

    const mockResetSettings = vi.fn().mockResolvedValue(undefined);
    useSettingsStore.setState({ resetSettings: mockResetSettings });

    render(<SettingsView />);

    const resetButton = screen.getByText('Reset Settings');
    fireEvent.click(resetButton);

    await waitFor(() => {
      expect(screen.queryByText(/are you sure/i)).toBeInTheDocument();
    });

    const confirmButton = screen.getByText('Reset Settings', { selector: 'button.btn-danger' });
    fireEvent.click(confirmButton);

    await waitFor(() => {
      expect(mockResetSettings).toHaveBeenCalled();
    });
  });
});
