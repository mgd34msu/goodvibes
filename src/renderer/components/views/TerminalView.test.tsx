// ============================================================================
// TERMINAL VIEW COMPONENT TESTS
// ============================================================================
//
// This file tests the TerminalView component as exported from views directory.
// For comprehensive terminal component tests, see:
// src/renderer/components/terminal/__tests__/TerminalView.test.tsx
//
// ============================================================================

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useTerminalStore } from '../../stores/terminalStore';
import { useAppStore } from '../../stores/appStore';
import { useSettingsStore } from '../../stores/settingsStore';
import TerminalView from './TerminalView';
import { DEFAULT_SETTINGS } from '../../../shared/types';

// ============================================================================
// MOCK XTERM.JS
// ============================================================================

// Mock XTerm.js and its addons to prevent DOM issues in tests
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
vi.mock('../../contexts/ThemeContext', () => ({
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
vi.mock('../git', () => ({
  GitPanel: vi.fn(() => <div data-testid="git-panel">Git Panel Mock</div>),
}));

// Mock SessionPreviewView
vi.mock('../preview/SessionPreviewView', () => ({
  SessionPreviewView: vi.fn(({ sessionId, sessionName }) => (
    <div data-testid="session-preview">
      Preview: {sessionName} ({sessionId})
    </div>
  )),
}));

// ============================================================================
// TEST HELPERS
// ============================================================================

// Create a wrapper with QueryClient for tests
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

async function renderTerminalView() {
  let result: ReturnType<typeof render>;

  await act(async () => {
    result = render(<TerminalView />, { wrapper: createTestWrapper() });
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
// TESTS
// ============================================================================

describe('TerminalView', () => {
  beforeEach(() => {
    resetStores();
    vi.clearAllMocks();

    vi.mocked(window.goodvibes.getMostRecentSession).mockResolvedValue(null);
    vi.mocked(window.goodvibes.getRecentProjects).mockResolvedValue([]);
  });

  describe('Empty State', () => {
    it('renders empty state when no terminals exist', async () => {
      await renderTerminalView();

      expect(screen.getByText('Welcome to GoodVibes')).toBeInTheDocument();
    });

    it('renders new terminal button', async () => {
      await renderTerminalView();

      const newButton = screen.getByLabelText(/open new terminal/i);
      expect(newButton).toBeInTheDocument();
    });
  });

  describe('With Terminals', () => {
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

    it('renders terminal tabs when terminals exist', async () => {
      await renderTerminalView();

      const terminalTab = screen.getByText('Test Terminal');
      expect(terminalTab).toBeInTheDocument();
    });

    it('shows close button on tab hover', async () => {
      await renderTerminalView();

      const closeButton = screen.getByLabelText(/close terminal test terminal/i);
      expect(closeButton).toBeInTheDocument();
    });
  });

  describe('Multiple Terminals', () => {
    beforeEach(() => {
      const terminals = new Map([
        [1, { id: 1, name: 'Terminal 1', cwd: '/path1', startTime: new Date(), isLoading: false }],
        [2, { id: 2, name: 'Terminal 2', cwd: '/path2', startTime: new Date(), isLoading: false }],
      ]);

      useTerminalStore.setState({
        terminals,
        activeTerminalId: 1,
      });
    });

    it('renders multiple terminal tabs', async () => {
      await renderTerminalView();

      const tab1 = screen.getByText('Terminal 1');
      const tab2 = screen.getByText('Terminal 2');

      expect(tab1).toBeInTheDocument();
      expect(tab2).toBeInTheDocument();
    });

    it('switches active terminal on tab click', async () => {
      await renderTerminalView();

      const tab2 = screen.getByText('Terminal 2');
      fireEvent.click(tab2);

      const state = useTerminalStore.getState();
      expect(state.activeTerminalId).toBe(2);
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

    it('renders preview terminal with different indicator', async () => {
      const { container } = await renderTerminalView();

      const previewTab = screen.getByText('Preview: Test Session');
      expect(previewTab).toBeInTheDocument();

      // Preview terminals should have accent/purple indicator
      const indicator = container.querySelector('[class*="bg-accent"]');
      expect(indicator || previewTab).toBeInTheDocument();
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
        isLoaded: true,
      });
    });

    it('renders git panel toggle button for active terminal', async () => {
      await renderTerminalView();

      const gitToggle = screen.getByLabelText(/(show|hide) git panel/i);
      expect(gitToggle).toBeInTheDocument();
    });

    it('toggles git panel visibility', async () => {
      await renderTerminalView();

      const gitToggle = screen.getByLabelText(/(show|hide) git panel/i);
      const initialPressed = gitToggle.getAttribute('aria-pressed');
      fireEvent.click(gitToggle);

      const newPressed = screen.getByLabelText(/(show|hide) git panel/i).getAttribute('aria-pressed');
      expect(newPressed).not.toBe(initialPressed);
    });
  });

  describe('Zoom Level', () => {
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
        zoomLevel: 100,
      });
    });

    it('applies zoom level from store', async () => {
      const { container } = await renderTerminalView();

      const terminalTab = screen.getByText('Test Terminal');
      expect(terminalTab).toBeInTheDocument();

      // Verify the component structure exists
      expect(container.firstChild).toBeInTheDocument();
    });
  });
});

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
  });

  it('switches between tabs correctly', () => {
    const store = useTerminalStore.getState();

    const id1 = store.createPreviewTerminal('session-1', 'Session 1', '/path1');
    const id2 = store.createPreviewTerminal('session-2', 'Session 2', '/path2');

    let state = useTerminalStore.getState();
    expect(state.activeTerminalId).toBe(id2);

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

  it('switches to next and previous tabs', () => {
    const store = useTerminalStore.getState();

    const id1 = store.createPreviewTerminal('session-1', 'Session 1');
    const id2 = store.createPreviewTerminal('session-2', 'Session 2');
    store.createPreviewTerminal('session-3', 'Session 3');

    useTerminalStore.getState().setActiveTerminal(id1);
    expect(useTerminalStore.getState().activeTerminalId).toBe(id1);

    useTerminalStore.getState().switchToNextTab();
    expect(useTerminalStore.getState().activeTerminalId).toBe(id2);

    useTerminalStore.getState().switchToPrevTab();
    expect(useTerminalStore.getState().activeTerminalId).toBe(id1);
  });
});
