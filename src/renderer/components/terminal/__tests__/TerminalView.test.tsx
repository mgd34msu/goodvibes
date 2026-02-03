// ============================================================================
// TERMINAL VIEW COMPONENT TESTS
// ============================================================================
//
// Comprehensive unit tests for TerminalView and its child components.
// Tests cover rendering, user interactions, state management, and error states.
//
// ============================================================================

import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useTerminalStore } from '../../../stores/terminalStore';
import { useAppStore } from '../../../stores/appStore';
import { useSettingsStore } from '../../../stores/settingsStore';
import { DEFAULT_SETTINGS } from '../../../../shared/types';
import TerminalView from '../../views/TerminalView';
import { TerminalHeader } from '../TerminalHeader';
import { TerminalFooter } from '../TerminalFooter';
import { EmptyState } from '../EmptyState';
import { FolderPickerModal } from '../FolderPickerModal';
import { TextEditorPickerModal } from '../TextEditorPickerModal';

// ============================================================================
// MOCK XTERM.JS
// ============================================================================

// Mock XTerm.js and its addons to prevent DOM issues in tests
// Note: vi.mock is hoisted, so we must define classes inside the factory
vi.mock('@xterm/xterm', () => {
  const MockTerminal = class {
    open = vi.fn();
    write = vi.fn();
    clear = vi.fn();
    focus = vi.fn();
    blur = vi.fn();
    dispose = vi.fn();
    refresh = vi.fn();
    scrollToBottom = vi.fn();
    loadAddon = vi.fn();
    onData = vi.fn().mockReturnValue(vi.fn());
    onResize = vi.fn().mockReturnValue(vi.fn());
    cols = 80;
    rows = 24;
    options = {
      fontSize: 14,
      theme: {},
    };
    getSelection = vi.fn().mockReturnValue('');
    hasSelection = vi.fn().mockReturnValue(false);
  };
  return { Terminal: MockTerminal };
});

vi.mock('@xterm/addon-fit', () => {
  const MockFitAddon = class {
    fit = vi.fn();
    proposeDimensions = vi.fn().mockReturnValue({ cols: 80, rows: 24 });
  };
  return { FitAddon: MockFitAddon };
});

vi.mock('@xterm/addon-web-links', () => {
  const MockWebLinksAddon = class {};
  return { WebLinksAddon: MockWebLinksAddon };
});

vi.mock('@xterm/addon-search', () => {
  const MockSearchAddon = class {
    findNext = vi.fn();
    findPrevious = vi.fn();
  };
  return { SearchAddon: MockSearchAddon };
});

// Mock the ThemeContext
vi.mock('../../../contexts/ThemeContext', () => ({
  useTheme: vi.fn().mockReturnValue({
    theme: {
      id: 'goodvibes-classic',
      name: 'GoodVibes Classic',
      type: 'dark',
      colors: {
        terminal: {
          background: '#1a1a2e',
          foreground: '#e4e4e7',
          cursor: '#f472b6',
          selectionBackground: 'rgba(244, 114, 182, 0.3)',
          black: '#1a1a2e',
          red: '#ef4444',
          green: '#10b981',
          yellow: '#f59e0b',
          blue: '#3b82f6',
          magenta: '#f472b6',
          cyan: '#06b6d4',
          white: '#e4e4e7',
          brightBlack: '#52525b',
          brightRed: '#f87171',
          brightGreen: '#34d399',
          brightYellow: '#fbbf24',
          brightBlue: '#60a5fa',
          brightMagenta: '#f9a8d4',
          brightCyan: '#22d3ee',
          brightWhite: '#fafafa',
        },
      },
    },
    themeId: 'goodvibes-classic',
    setTheme: vi.fn(),
    availableThemes: [],
  }),
}));

// Mock GitPanel to avoid git-related API calls
vi.mock('../../git', () => ({
  GitPanel: vi.fn(() => <div data-testid="git-panel">Git Panel Mock</div>),
}));

// Mock SessionPreviewView
vi.mock('../../preview/SessionPreviewView', () => ({
  SessionPreviewView: vi.fn(({ sessionId, sessionName }) => (
    <div data-testid="session-preview">
      Preview: {sessionName} ({sessionId})
    </div>
  )),
}));

// ============================================================================
// TEST HELPERS
// ============================================================================

function createTestQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
      },
    },
  });
}

function createTestWrapper(): React.FC<{ children: React.ReactNode }> {
  const queryClient = createTestQueryClient();

  return function TestWrapper({ children }: { children: React.ReactNode }) {
    return (
      <QueryClientProvider client={queryClient}>
        {children}
      </QueryClientProvider>
    );
  };
}

async function renderWithProviders(ui: React.ReactElement): Promise<ReturnType<typeof render>> {
  let result: ReturnType<typeof render>;

  await act(async () => {
    result = render(ui, { wrapper: createTestWrapper() });
    // Wait for async effects to settle
    await new Promise(resolve => setTimeout(resolve, 10));
  });

  return result!;
}

function resetStores(): void {
  useTerminalStore.setState({
    terminals: new Map(),
    activeTerminalId: null,
    zoomLevel: 100,
    nextPreviewId: -1,
  });

  useAppStore.setState({
    currentView: 'terminal',
    isFolderPickerOpen: false,
    isTextEditorPickerOpen: false,
  });

  useSettingsStore.setState({
    settings: { ...DEFAULT_SETTINGS },
    isLoaded: true,
  });
}

// ============================================================================
// TERMINAL VIEW TESTS
// ============================================================================

describe('TerminalView', () => {
  beforeEach(() => {
    resetStores();
    vi.clearAllMocks();

    // Setup default mocks
    vi.mocked(window.goodvibes.getMostRecentSession).mockResolvedValue(null);
    vi.mocked(window.goodvibes.getRecentProjects).mockResolvedValue([]);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('Empty State', () => {
    it('renders empty state when no terminals exist', async () => {
      await renderWithProviders(<TerminalView />);

      // Verify empty state is shown
      expect(screen.getByText('Welcome to GoodVibes')).toBeInTheDocument();
    });

    it('renders action buttons in empty state', async () => {
      await renderWithProviders(<TerminalView />);

      // All four action buttons should be present
      expect(screen.getByLabelText(/start new claude code session/i)).toBeInTheDocument();
      expect(screen.getByLabelText(/open new terminal/i)).toBeInTheDocument();
      expect(screen.getByLabelText(/open text editor/i)).toBeInTheDocument();
      expect(screen.getByLabelText(/resume most recent session/i)).toBeInTheDocument();
    });

    it('disables quick restart when no recent session exists', async () => {
      vi.mocked(window.goodvibes.getMostRecentSession).mockResolvedValue(null);

      await renderWithProviders(<TerminalView />);

      const quickRestartButton = screen.getByLabelText(/resume most recent session/i);
      expect(quickRestartButton).toBeDisabled();
    });

    it('enables quick restart when recent session exists', async () => {
      vi.mocked(window.goodvibes.getMostRecentSession).mockResolvedValue({
        sessionId: 'test-session-123',
        cwd: '/test/project',
        firstPrompt: 'Test prompt',
        messageCount: 5,
        costUsd: 0.15,
        startedAt: '2024-01-15T10:00:00Z',
        lastActive: '2024-01-15T11:00:00Z',
      });

      await renderWithProviders(<TerminalView />);

      await waitFor(() => {
        const quickRestartButton = screen.getByLabelText(/resume most recent session/i);
        expect(quickRestartButton).not.toBeDisabled();
      });
    });

    it('opens folder picker when new session button is clicked', async () => {
      const user = userEvent.setup();
      await renderWithProviders(<TerminalView />);

      const newSessionButton = screen.getByLabelText(/start new claude code session/i);
      await user.click(newSessionButton);

      expect(useAppStore.getState().isFolderPickerOpen).toBe(true);
    });

    it('opens text editor picker when text editor button is clicked', async () => {
      const user = userEvent.setup();
      await renderWithProviders(<TerminalView />);

      const textEditorButton = screen.getByLabelText(/open text editor/i);
      await user.click(textEditorButton);

      expect(useAppStore.getState().isTextEditorPickerOpen).toBe(true);
    });
  });

  describe('With Active Terminals', () => {
    beforeEach(() => {
      const terminal = {
        id: 1,
        name: 'Test Terminal',
        cwd: '/test/path',
        startTime: new Date(),
        isLoading: false,
      };

      useTerminalStore.setState({
        terminals: new Map([[1, terminal]]),
        activeTerminalId: 1,
      });
    });

    it('renders terminal header with tabs', async () => {
      await renderWithProviders(<TerminalView />);

      // Terminal tab should be visible
      expect(screen.getByText('Test Terminal')).toBeInTheDocument();
    });

    it('renders terminal footer with zoom controls', async () => {
      await renderWithProviders(<TerminalView />);

      // Zoom controls should be present
      expect(screen.getByLabelText('Zoom in')).toBeInTheDocument();
      expect(screen.getByLabelText('Zoom out')).toBeInTheDocument();
      expect(screen.getByLabelText('Reset zoom to 100%')).toBeInTheDocument();
    });

    it('shows current working directory in footer', async () => {
      await renderWithProviders(<TerminalView />);

      expect(screen.getByText('/test/path')).toBeInTheDocument();
    });

    it('does not show empty state when terminals exist', async () => {
      await renderWithProviders(<TerminalView />);

      expect(screen.queryByText('Welcome to GoodVibes')).not.toBeInTheDocument();
    });
  });

  describe('Multiple Terminals', () => {
    beforeEach(() => {
      const terminals = new Map([
        [1, { id: 1, name: 'Terminal 1', cwd: '/path1', startTime: new Date(), isLoading: false }],
        [2, { id: 2, name: 'Terminal 2', cwd: '/path2', startTime: new Date(), isLoading: false }],
        [3, { id: 3, name: 'Terminal 3', cwd: '/path3', startTime: new Date(), isLoading: false }],
      ]);

      useTerminalStore.setState({
        terminals,
        activeTerminalId: 1,
      });
    });

    it('renders all terminal tabs', async () => {
      await renderWithProviders(<TerminalView />);

      expect(screen.getByText('Terminal 1')).toBeInTheDocument();
      expect(screen.getByText('Terminal 2')).toBeInTheDocument();
      expect(screen.getByText('Terminal 3')).toBeInTheDocument();
    });

    it('switches active terminal on tab click', async () => {
      const user = userEvent.setup();
      await renderWithProviders(<TerminalView />);

      // Click on Terminal 2 tab
      await user.click(screen.getByText('Terminal 2'));

      expect(useTerminalStore.getState().activeTerminalId).toBe(2);
    });

    it('supports keyboard navigation between tabs', async () => {
      await renderWithProviders(<TerminalView />);

      const tab2 = screen.getByText('Terminal 2');
      tab2.focus();

      // Simulate Enter key press
      fireEvent.keyDown(tab2, { key: 'Enter' });

      expect(useTerminalStore.getState().activeTerminalId).toBe(2);
    });

    it('closes terminal when close button is clicked', async () => {
      const user = userEvent.setup();
      await renderWithProviders(<TerminalView />);

      // Find and click the close button for Terminal 1
      const closeButton = screen.getByLabelText('Close terminal Terminal 1');
      await user.click(closeButton);

      await waitFor(() => {
        expect(useTerminalStore.getState().terminals.has(1)).toBe(false);
      });
    });
  });

  describe('Preview Terminals', () => {
    beforeEach(() => {
      const terminal = {
        id: -1,
        name: 'Preview: Test Session',
        cwd: '/test/path',
        startTime: new Date(),
        isLoading: false,
        isPreview: true,
        previewSessionId: 'test-session-123',
      };

      useTerminalStore.setState({
        terminals: new Map([[-1, terminal]]),
        activeTerminalId: -1,
      });
    });

    it('renders preview terminal tab', async () => {
      await renderWithProviders(<TerminalView />);

      expect(screen.getByText('Preview: Test Session')).toBeInTheDocument();
    });

    it('renders SessionPreviewView for preview terminals', async () => {
      await renderWithProviders(<TerminalView />);

      expect(screen.getByTestId('session-preview')).toBeInTheDocument();
    });

    it('shows preview indicator styling', async () => {
      const { container } = await renderWithProviders(<TerminalView />);

      // Preview terminals should have purple indicator
      const indicator = container.querySelector('[class*="bg-accent"]');
      expect(indicator).toBeInTheDocument();
    });
  });

  describe('Plain Terminals', () => {
    beforeEach(() => {
      const terminal = {
        id: 1,
        name: 'Shell',
        cwd: '/test/path',
        startTime: new Date(),
        isLoading: false,
        isPlainTerminal: true,
      };

      useTerminalStore.setState({
        terminals: new Map([[1, terminal]]),
        activeTerminalId: 1,
      });
    });

    it('renders plain terminal with warning indicator', async () => {
      const { container } = await renderWithProviders(<TerminalView />);

      // Plain terminals should have warning/yellow indicator
      const indicator = container.querySelector('[class*="bg-warning"]');
      expect(indicator).toBeInTheDocument();
    });
  });

  describe('Git Panel', () => {
    beforeEach(() => {
      const terminal = {
        id: 1,
        name: 'Test Terminal',
        cwd: '/test/path',
        startTime: new Date(),
        isLoading: false,
      };

      useTerminalStore.setState({
        terminals: new Map([[1, terminal]]),
        activeTerminalId: 1,
      });

      useSettingsStore.setState({
        settings: {
          ...DEFAULT_SETTINGS,
          gitPanelPosition: 'right',
        },
      });
    });

    it('renders git panel toggle button', async () => {
      await renderWithProviders(<TerminalView />);

      const gitToggle = screen.getByLabelText(/(show|hide) git panel/i);
      expect(gitToggle).toBeInTheDocument();
    });

    it('toggles git panel visibility', async () => {
      const user = userEvent.setup();
      await renderWithProviders(<TerminalView />);

      // Git panel should be visible by default
      expect(screen.getByTestId('git-panel')).toBeInTheDocument();

      // Click toggle to hide
      const gitToggle = screen.getByLabelText(/hide git panel/i);
      await user.click(gitToggle);

      // Git panel should be hidden
      expect(screen.queryByTestId('git-panel')).not.toBeInTheDocument();
    });

    it('does not show git panel for preview terminals', async () => {
      const terminal = {
        id: -1,
        name: 'Preview: Test',
        cwd: '/test/path',
        startTime: new Date(),
        isLoading: false,
        isPreview: true,
        previewSessionId: 'test-123',
      };

      useTerminalStore.setState({
        terminals: new Map([[-1, terminal]]),
        activeTerminalId: -1,
      });

      await renderWithProviders(<TerminalView />);

      // Git toggle should not be present for preview terminals
      expect(screen.queryByLabelText(/(show|hide) git panel/i)).not.toBeInTheDocument();
    });
  });

  describe('Modals', () => {
    it('renders FolderPickerModal when open', async () => {
      useAppStore.setState({ isFolderPickerOpen: true });

      await renderWithProviders(<TerminalView />);

      expect(screen.getByText('Select Project Folder')).toBeInTheDocument();
    });

    it('renders TextEditorPickerModal when open', async () => {
      useAppStore.setState({ isTextEditorPickerOpen: true });

      await renderWithProviders(<TerminalView />);

      expect(screen.getByText('Open in Text Editor')).toBeInTheDocument();
    });
  });
});

// ============================================================================
// TERMINAL HEADER TESTS
// ============================================================================

describe('TerminalHeader', () => {
  beforeEach(() => {
    resetStores();
    vi.clearAllMocks();
    vi.mocked(window.goodvibes.getMostRecentSession).mockResolvedValue(null);
    vi.mocked(window.goodvibes.getRecentProjects).mockResolvedValue([]);
  });

  it('renders terminal tabs from store', async () => {
    const terminals = new Map([
      [1, { id: 1, name: 'Tab 1', cwd: '/path1', startTime: new Date(), isLoading: false }],
      [2, { id: 2, name: 'Tab 2', cwd: '/path2', startTime: new Date(), isLoading: false }],
    ]);

    useTerminalStore.setState({ terminals, activeTerminalId: 1 });

    await renderWithProviders(
      <TerminalHeader
        showGitPanel={false}
        onToggleGitPanel={vi.fn()}
        hasActiveSession={true}
      />
    );

    expect(screen.getByText('Tab 1')).toBeInTheDocument();
    expect(screen.getByText('Tab 2')).toBeInTheDocument();
  });

  it('renders New dropdown button', async () => {
    await renderWithProviders(
      <TerminalHeader
        showGitPanel={false}
        onToggleGitPanel={vi.fn()}
        hasActiveSession={false}
      />
    );

    expect(screen.getByLabelText('New')).toBeInTheDocument();
  });

  it('opens dropdown menu on click', async () => {
    const user = userEvent.setup();

    await renderWithProviders(
      <TerminalHeader
        showGitPanel={false}
        onToggleGitPanel={vi.fn()}
        hasActiveSession={false}
      />
    );

    await user.click(screen.getByLabelText('New'));

    // Dropdown menu items should be visible
    expect(screen.getByText('Claude Code Session')).toBeInTheDocument();
    expect(screen.getByText('Quick Restart')).toBeInTheDocument();
    expect(screen.getByText('Text Editor')).toBeInTheDocument();
    expect(screen.getByText('Terminal Window')).toBeInTheDocument();
  });

  it('closes dropdown when clicking outside', async () => {
    const user = userEvent.setup();

    const { container } = await renderWithProviders(
      <TerminalHeader
        showGitPanel={false}
        onToggleGitPanel={vi.fn()}
        hasActiveSession={false}
      />
    );

    // Open dropdown
    await user.click(screen.getByLabelText('New'));
    expect(screen.getByText('Claude Code Session')).toBeInTheDocument();

    // Click outside
    fireEvent.mouseDown(container);

    // Dropdown should close
    await waitFor(() => {
      expect(screen.queryByText('Claude Code Session')).not.toBeInTheDocument();
    });
  });

  it('shows git panel toggle when hasActiveSession is true', async () => {
    await renderWithProviders(
      <TerminalHeader
        showGitPanel={false}
        onToggleGitPanel={vi.fn()}
        hasActiveSession={true}
      />
    );

    expect(screen.getByLabelText(/show git panel/i)).toBeInTheDocument();
  });

  it('hides git panel toggle when hasActiveSession is false', async () => {
    await renderWithProviders(
      <TerminalHeader
        showGitPanel={false}
        onToggleGitPanel={vi.fn()}
        hasActiveSession={false}
      />
    );

    expect(screen.queryByLabelText(/(show|hide) git panel/i)).not.toBeInTheDocument();
  });

  it('calls onToggleGitPanel when git button is clicked', async () => {
    const onToggleGitPanel = vi.fn();
    const user = userEvent.setup();

    await renderWithProviders(
      <TerminalHeader
        showGitPanel={false}
        onToggleGitPanel={onToggleGitPanel}
        hasActiveSession={true}
      />
    );

    await user.click(screen.getByLabelText(/show git panel/i));

    expect(onToggleGitPanel).toHaveBeenCalledTimes(1);
  });
});

// ============================================================================
// TERMINAL FOOTER TESTS
// ============================================================================

describe('TerminalFooter', () => {
  beforeEach(() => {
    resetStores();
    vi.clearAllMocks();
  });

  it('displays current zoom level', async () => {
    useTerminalStore.setState({ zoomLevel: 100 });

    await renderWithProviders(<TerminalFooter />);

    expect(screen.getByText('100%')).toBeInTheDocument();
  });

  it('displays custom zoom level', async () => {
    useTerminalStore.setState({ zoomLevel: 125 });

    await renderWithProviders(<TerminalFooter />);

    expect(screen.getByText('125%')).toBeInTheDocument();
  });

  it('increases zoom on zoom in click', async () => {
    const user = userEvent.setup();
    useTerminalStore.setState({ zoomLevel: 100 });

    await renderWithProviders(<TerminalFooter />);

    await user.click(screen.getByLabelText('Zoom in'));

    expect(useTerminalStore.getState().zoomLevel).toBe(110);
  });

  it('decreases zoom on zoom out click', async () => {
    const user = userEvent.setup();
    useTerminalStore.setState({ zoomLevel: 100 });

    await renderWithProviders(<TerminalFooter />);

    await user.click(screen.getByLabelText('Zoom out'));

    expect(useTerminalStore.getState().zoomLevel).toBe(90);
  });

  it('resets zoom to 100% on reset click', async () => {
    const user = userEvent.setup();
    useTerminalStore.setState({ zoomLevel: 150 });

    await renderWithProviders(<TerminalFooter />);

    await user.click(screen.getByLabelText('Reset zoom to 100%'));

    expect(useTerminalStore.getState().zoomLevel).toBe(100);
  });

  it('disables reset button when zoom is already 100%', async () => {
    useTerminalStore.setState({ zoomLevel: 100 });

    await renderWithProviders(<TerminalFooter />);

    const resetButton = screen.getByLabelText('Reset zoom to 100%');
    expect(resetButton).toBeDisabled();
  });

  it('shows "No folder selected" when no active terminal', async () => {
    useTerminalStore.setState({ terminals: new Map(), activeTerminalId: null });

    await renderWithProviders(<TerminalFooter />);

    expect(screen.getByText('No folder selected')).toBeInTheDocument();
  });

  it('shows active terminal cwd', async () => {
    const terminal = {
      id: 1,
      name: 'Test',
      cwd: '/test/project/path',
      startTime: new Date(),
      isLoading: false,
    };

    useTerminalStore.setState({
      terminals: new Map([[1, terminal]]),
      activeTerminalId: 1,
    });

    await renderWithProviders(<TerminalFooter />);

    expect(screen.getByText('/test/project/path')).toBeInTheDocument();
  });
});

// ============================================================================
// EMPTY STATE TESTS
// ============================================================================

describe('EmptyState', () => {
  beforeEach(() => {
    resetStores();
    vi.clearAllMocks();
    vi.mocked(window.goodvibes.getMostRecentSession).mockResolvedValue(null);
  });

  it('renders welcome message', async () => {
    await renderWithProviders(
      <EmptyState
        onNewSession={vi.fn()}
        onNewTerminal={vi.fn()}
        onOpenTextEditor={vi.fn()}
        onQuickRestart={vi.fn()}
      />
    );

    expect(screen.getByText('Welcome to GoodVibes')).toBeInTheDocument();
  });

  it('renders description text', async () => {
    await renderWithProviders(
      <EmptyState
        onNewSession={vi.fn()}
        onNewTerminal={vi.fn()}
        onOpenTextEditor={vi.fn()}
        onQuickRestart={vi.fn()}
      />
    );

    expect(screen.getByText(/start a new claude code session/i)).toBeInTheDocument();
  });

  it('calls onNewSession when Claude Session button is clicked', async () => {
    const onNewSession = vi.fn();
    const user = userEvent.setup();

    await renderWithProviders(
      <EmptyState
        onNewSession={onNewSession}
        onNewTerminal={vi.fn()}
        onOpenTextEditor={vi.fn()}
        onQuickRestart={vi.fn()}
      />
    );

    await user.click(screen.getByLabelText(/start new claude code session/i));

    expect(onNewSession).toHaveBeenCalledTimes(1);
  });

  it('calls onNewTerminal when Terminal button is clicked', async () => {
    const onNewTerminal = vi.fn();
    const user = userEvent.setup();

    await renderWithProviders(
      <EmptyState
        onNewSession={vi.fn()}
        onNewTerminal={onNewTerminal}
        onOpenTextEditor={vi.fn()}
        onQuickRestart={vi.fn()}
      />
    );

    await user.click(screen.getByLabelText(/open new terminal/i));

    expect(onNewTerminal).toHaveBeenCalledTimes(1);
  });

  it('calls onOpenTextEditor when Text Editor button is clicked', async () => {
    const onOpenTextEditor = vi.fn();
    const user = userEvent.setup();

    await renderWithProviders(
      <EmptyState
        onNewSession={vi.fn()}
        onNewTerminal={vi.fn()}
        onOpenTextEditor={onOpenTextEditor}
        onQuickRestart={vi.fn()}
      />
    );

    await user.click(screen.getByLabelText(/open text editor/i));

    expect(onOpenTextEditor).toHaveBeenCalledTimes(1);
  });

  it('displays keyboard shortcut hint', async () => {
    await renderWithProviders(
      <EmptyState
        onNewSession={vi.fn()}
        onNewTerminal={vi.fn()}
        onOpenTextEditor={vi.fn()}
        onQuickRestart={vi.fn()}
      />
    );

    expect(screen.getByText('Ctrl')).toBeInTheDocument();
    expect(screen.getByText('N')).toBeInTheDocument();
    expect(screen.getByText('New session')).toBeInTheDocument();
  });

  it('shows recent session prompt when available', async () => {
    vi.mocked(window.goodvibes.getMostRecentSession).mockResolvedValue({
      sessionId: 'test-123',
      cwd: '/test/path',
      firstPrompt: 'Write a test for the login component',
      messageCount: 10,
      costUsd: 0.25,
      startedAt: '2024-01-15T10:00:00Z',
      lastActive: '2024-01-15T11:00:00Z',
    });

    await renderWithProviders(
      <EmptyState
        onNewSession={vi.fn()}
        onNewTerminal={vi.fn()}
        onOpenTextEditor={vi.fn()}
        onQuickRestart={vi.fn()}
      />
    );

    await waitFor(() => {
      expect(screen.getByText(/write a test for the login/i)).toBeInTheDocument();
    });
  });
});

// ============================================================================
// FOLDER PICKER MODAL TESTS
// ============================================================================

describe('FolderPickerModal', () => {
  beforeEach(() => {
    resetStores();
    vi.clearAllMocks();
    vi.mocked(window.goodvibes.getRecentProjects).mockResolvedValue([]);
  });

  it('does not render when closed', async () => {
    useAppStore.setState({ isFolderPickerOpen: false });

    await renderWithProviders(<FolderPickerModal />);

    expect(screen.queryByText('Select Project Folder')).not.toBeInTheDocument();
  });

  it('renders when open', async () => {
    useAppStore.setState({ isFolderPickerOpen: true });

    await renderWithProviders(<FolderPickerModal />);

    expect(screen.getByText('Select Project Folder')).toBeInTheDocument();
  });

  it('renders Open Project button', async () => {
    useAppStore.setState({ isFolderPickerOpen: true });

    await renderWithProviders(<FolderPickerModal />);

    expect(screen.getByText('Open Project')).toBeInTheDocument();
  });

  it('renders Cancel and Start Session buttons', async () => {
    useAppStore.setState({ isFolderPickerOpen: true });

    await renderWithProviders(<FolderPickerModal />);

    expect(screen.getByText('Cancel')).toBeInTheDocument();
    expect(screen.getByText('Start Session')).toBeInTheDocument();
  });

  it('disables Start Session when no folder selected', async () => {
    useAppStore.setState({ isFolderPickerOpen: true });

    await renderWithProviders(<FolderPickerModal />);

    const startButton = screen.getByText('Start Session');
    expect(startButton).toBeDisabled();
  });

  it('closes modal when Cancel is clicked', async () => {
    const user = userEvent.setup();
    useAppStore.setState({ isFolderPickerOpen: true });

    await renderWithProviders(<FolderPickerModal />);

    await user.click(screen.getByText('Cancel'));

    expect(useAppStore.getState().isFolderPickerOpen).toBe(false);
  });

  it('closes modal when close button is clicked', async () => {
    const user = userEvent.setup();
    useAppStore.setState({ isFolderPickerOpen: true });

    await renderWithProviders(<FolderPickerModal />);

    await user.click(screen.getByLabelText('Close modal'));

    expect(useAppStore.getState().isFolderPickerOpen).toBe(false);
  });

  it('closes modal when clicking outside', async () => {
    useAppStore.setState({ isFolderPickerOpen: true });

    const { container } = await renderWithProviders(<FolderPickerModal />);

    // Click on the modal backdrop
    const backdrop = container.querySelector('.modal');
    if (backdrop) {
      fireEvent.click(backdrop);
    }

    expect(useAppStore.getState().isFolderPickerOpen).toBe(false);
  });

  it('closes modal on Escape key press', async () => {
    useAppStore.setState({ isFolderPickerOpen: true });

    const { container } = await renderWithProviders(<FolderPickerModal />);

    const modal = container.querySelector('.modal');
    if (modal) {
      fireEvent.keyDown(modal, { key: 'Escape' });
    }

    expect(useAppStore.getState().isFolderPickerOpen).toBe(false);
  });

  it('displays recent projects', async () => {
    vi.mocked(window.goodvibes.getRecentProjects).mockResolvedValue([
      { path: '/test/project1', name: 'Project 1' },
      { path: '/test/project2', name: 'Project 2' },
    ]);

    useAppStore.setState({ isFolderPickerOpen: true });

    await renderWithProviders(<FolderPickerModal />);

    await waitFor(() => {
      expect(screen.getByText('Project 1')).toBeInTheDocument();
      expect(screen.getByText('Project 2')).toBeInTheDocument();
    });
  });

  it('calls selectFolder when Open Project is clicked', async () => {
    const user = userEvent.setup();
    vi.mocked(window.goodvibes.selectFolder).mockResolvedValue('/selected/folder');
    useAppStore.setState({ isFolderPickerOpen: true });

    await renderWithProviders(<FolderPickerModal />);

    await user.click(screen.getByText('Open Project'));

    expect(window.goodvibes.selectFolder).toHaveBeenCalled();
  });

  it('displays selected folder path', async () => {
    const user = userEvent.setup();
    vi.mocked(window.goodvibes.selectFolder).mockResolvedValue('/test/selected/path');
    useAppStore.setState({ isFolderPickerOpen: true });

    await renderWithProviders(<FolderPickerModal />);

    await user.click(screen.getByText('Open Project'));

    await waitFor(() => {
      expect(screen.getByText('/test/selected/path')).toBeInTheDocument();
    });
  });

  it('enables Start Session when folder is selected', async () => {
    const user = userEvent.setup();
    vi.mocked(window.goodvibes.selectFolder).mockResolvedValue('/test/path');
    useAppStore.setState({ isFolderPickerOpen: true });

    await renderWithProviders(<FolderPickerModal />);

    await user.click(screen.getByText('Open Project'));

    await waitFor(() => {
      const startButton = screen.getByText('Start Session');
      expect(startButton).not.toBeDisabled();
    });
  });

  it('creates terminal and closes modal on Start Session', async () => {
    const user = userEvent.setup();
    vi.mocked(window.goodvibes.selectFolder).mockResolvedValue('/test/path');
    vi.mocked(window.goodvibes.startClaude).mockResolvedValue({
      id: 1,
      name: 'path',
      cwd: '/test/path',
    });
    useAppStore.setState({ isFolderPickerOpen: true });

    await renderWithProviders(<FolderPickerModal />);

    // Select folder
    await user.click(screen.getByText('Open Project'));
    await waitFor(() => {
      expect(screen.getByText('/test/path')).toBeInTheDocument();
    });

    // Start session
    await user.click(screen.getByText('Start Session'));

    await waitFor(() => {
      expect(useAppStore.getState().isFolderPickerOpen).toBe(false);
    });
  });
});

// ============================================================================
// TEXT EDITOR PICKER MODAL TESTS
// ============================================================================

describe('TextEditorPickerModal', () => {
  beforeEach(() => {
    resetStores();
    vi.clearAllMocks();
    vi.mocked(window.goodvibes.getRecentProjects).mockResolvedValue([]);
  });

  it('does not render when closed', async () => {
    useAppStore.setState({ isTextEditorPickerOpen: false });

    await renderWithProviders(<TextEditorPickerModal />);

    expect(screen.queryByText('Open in Text Editor')).not.toBeInTheDocument();
  });

  it('renders when open', async () => {
    useAppStore.setState({ isTextEditorPickerOpen: true });

    await renderWithProviders(<TextEditorPickerModal />);

    expect(screen.getByText('Open in Text Editor')).toBeInTheDocument();
  });

  it('renders Open Folder and Open File buttons', async () => {
    useAppStore.setState({ isTextEditorPickerOpen: true });

    await renderWithProviders(<TextEditorPickerModal />);

    expect(screen.getByText('Open Folder')).toBeInTheDocument();
    expect(screen.getByText('Open File')).toBeInTheDocument();
  });

  it('disables Open Editor when nothing selected', async () => {
    useAppStore.setState({ isTextEditorPickerOpen: true });

    await renderWithProviders(<TextEditorPickerModal />);

    const openButton = screen.getByText('Open Editor');
    expect(openButton).toBeDisabled();
  });

  it('closes modal when Cancel is clicked', async () => {
    const user = userEvent.setup();
    useAppStore.setState({ isTextEditorPickerOpen: true });

    await renderWithProviders(<TextEditorPickerModal />);

    await user.click(screen.getByText('Cancel'));

    expect(useAppStore.getState().isTextEditorPickerOpen).toBe(false);
  });

  it('enables Open Editor when folder is selected', async () => {
    const user = userEvent.setup();
    vi.mocked(window.goodvibes.selectFolder).mockResolvedValue('/test/folder');
    useAppStore.setState({ isTextEditorPickerOpen: true });

    await renderWithProviders(<TextEditorPickerModal />);

    await user.click(screen.getByText('Open Folder'));

    await waitFor(() => {
      const openButton = screen.getByText('Open Editor');
      expect(openButton).not.toBeDisabled();
    });
  });

  it('enables Open Editor when file is selected', async () => {
    const user = userEvent.setup();
    vi.mocked(window.goodvibes.selectFile).mockResolvedValue('/test/file.txt');
    useAppStore.setState({ isTextEditorPickerOpen: true });

    await renderWithProviders(<TextEditorPickerModal />);

    await user.click(screen.getByText('Open File'));

    await waitFor(() => {
      const openButton = screen.getByText('Open Editor');
      expect(openButton).not.toBeDisabled();
    });
  });

  it('closes modal on Escape key press', async () => {
    useAppStore.setState({ isTextEditorPickerOpen: true });

    const { container } = await renderWithProviders(<TextEditorPickerModal />);

    const modal = container.querySelector('.modal');
    if (modal) {
      fireEvent.keyDown(modal, { key: 'Escape' });
    }

    expect(useAppStore.getState().isTextEditorPickerOpen).toBe(false);
  });

  it('displays recent projects', async () => {
    vi.mocked(window.goodvibes.getRecentProjects).mockResolvedValue([
      { path: '/recent/project', name: 'Recent Project' },
    ]);

    useAppStore.setState({ isTextEditorPickerOpen: true });

    await renderWithProviders(<TextEditorPickerModal />);

    await waitFor(() => {
      expect(screen.getByText('Recent Project')).toBeInTheDocument();
    });
  });
});

// ============================================================================
// TERMINAL STORE INTEGRATION TESTS
// ============================================================================

describe('Terminal Store Integration', () => {
  beforeEach(() => {
    resetStores();
    vi.clearAllMocks();
  });

  it('creates preview terminal correctly', () => {
    const store = useTerminalStore.getState();
    const id = store.createPreviewTerminal('session-123', 'Test Session', '/path');

    const state = useTerminalStore.getState();
    expect(state.terminals.has(id)).toBe(true);
    expect(state.activeTerminalId).toBe(id);

    const terminal = state.terminals.get(id);
    expect(terminal?.isPreview).toBe(true);
    expect(terminal?.previewSessionId).toBe('session-123');
    expect(terminal?.name).toBe('Preview: Test Session');
  });

  it('switches between tabs correctly', () => {
    const store = useTerminalStore.getState();

    const id1 = store.createPreviewTerminal('session-1', 'Session 1', '/path1');
    const id2 = store.createPreviewTerminal('session-2', 'Session 2', '/path2');

    let state = useTerminalStore.getState();
    expect(state.activeTerminalId).toBe(id2); // Last created is active

    state.setActiveTerminal(id1);
    state = useTerminalStore.getState();
    expect(state.activeTerminalId).toBe(id1);
  });

  it('closes preview terminal correctly', () => {
    const store = useTerminalStore.getState();
    const id = store.createPreviewTerminal('session-123', 'Test Session', '/path');

    expect(useTerminalStore.getState().terminals.has(id)).toBe(true);

    useTerminalStore.getState().closePreviewTerminal(id);

    expect(useTerminalStore.getState().terminals.has(id)).toBe(false);
  });

  it('updates zoom level correctly', () => {
    useTerminalStore.getState().setZoomLevel(150);
    expect(useTerminalStore.getState().zoomLevel).toBe(150);

    useTerminalStore.getState().setZoomLevel(75);
    expect(useTerminalStore.getState().zoomLevel).toBe(75);
  });

  it('clamps zoom level to valid range', () => {
    useTerminalStore.getState().setZoomLevel(10); // Below minimum
    expect(useTerminalStore.getState().zoomLevel).toBe(50); // Clamped to 50

    useTerminalStore.getState().setZoomLevel(300); // Above maximum
    expect(useTerminalStore.getState().zoomLevel).toBe(200); // Clamped to 200
  });

  it('switches to next and previous tabs', () => {
    const store = useTerminalStore.getState();

    const id1 = store.createPreviewTerminal('session-1', 'Session 1');
    const id2 = store.createPreviewTerminal('session-2', 'Session 2');
    const id3 = store.createPreviewTerminal('session-3', 'Session 3');

    // Set active to first
    useTerminalStore.getState().setActiveTerminal(id1);
    expect(useTerminalStore.getState().activeTerminalId).toBe(id1);

    // Switch to next
    useTerminalStore.getState().switchToNextTab();
    expect(useTerminalStore.getState().activeTerminalId).toBe(id2);

    // Switch to next again
    useTerminalStore.getState().switchToNextTab();
    expect(useTerminalStore.getState().activeTerminalId).toBe(id3);

    // Switch to next (wraps around)
    useTerminalStore.getState().switchToNextTab();
    expect(useTerminalStore.getState().activeTerminalId).toBe(id1);

    // Switch to previous
    useTerminalStore.getState().switchToPrevTab();
    expect(useTerminalStore.getState().activeTerminalId).toBe(id3);
  });

  it('updates terminal properties correctly', () => {
    const store = useTerminalStore.getState();
    const id = store.createPreviewTerminal('session-123', 'Test Session', '/path');

    useTerminalStore.getState().updateTerminal(id, { name: 'Updated Name' });

    const terminal = useTerminalStore.getState().terminals.get(id);
    expect(terminal?.name).toBe('Updated Name');
  });

  it('selects next terminal when active is closed', () => {
    const store = useTerminalStore.getState();

    store.createPreviewTerminal('session-1', 'Session 1');
    const id2 = store.createPreviewTerminal('session-2', 'Session 2');
    const id3 = store.createPreviewTerminal('session-3', 'Session 3');

    // id3 is active (last created)
    expect(useTerminalStore.getState().activeTerminalId).toBe(id3);

    // Close id3
    useTerminalStore.getState().closePreviewTerminal(id3);

    // id2 should now be active
    expect(useTerminalStore.getState().activeTerminalId).toBe(id2);
  });
});
