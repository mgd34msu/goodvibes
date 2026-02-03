// ============================================================================
// MCP VIEW COMPONENT TESTS
// ============================================================================

import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import MCPView from './MCPView';
import type { MCPServer } from './MCPServerCard';

// ============================================================================
// TEST UTILITIES
// ============================================================================

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

async function renderMCPView() {
  let result: ReturnType<typeof render>;

  await act(async () => {
    result = render(<MCPView />, { wrapper: createTestWrapper() });
    await new Promise(resolve => setTimeout(resolve, 10));
  });

  return result!;
}

// ============================================================================
// MOCK DATA
// ============================================================================

const mockServers: MCPServer[] = [
  {
    id: 1,
    name: 'GitHub Server',
    description: 'Access GitHub repositories and issues',
    transport: 'stdio',
    command: 'npx @github/mcp-server',
    url: null,
    args: ['--token', 'test'],
    env: { GITHUB_TOKEN: 'test-token' },
    scope: 'user',
    projectPath: null,
    enabled: true,
    status: 'connected',
    lastConnected: '2024-01-15T10:00:00Z',
    errorMessage: null,
    toolCount: 15,
    createdAt: '2024-01-01T00:00:00Z',
    updatedAt: '2024-01-15T10:00:00Z',
  },
  {
    id: 2,
    name: 'Notion Server',
    description: 'Manage Notion workspaces',
    transport: 'stdio',
    command: 'npx @notionhq/mcp-server',
    url: null,
    args: [],
    env: { NOTION_API_KEY: 'secret-key' },
    scope: 'project',
    projectPath: '/projects/my-project',
    enabled: true,
    status: 'disconnected',
    lastConnected: null,
    errorMessage: null,
    toolCount: 8,
    createdAt: '2024-01-02T00:00:00Z',
    updatedAt: '2024-01-02T00:00:00Z',
  },
  {
    id: 3,
    name: 'Error Server',
    description: 'Server with error state',
    transport: 'http',
    command: null,
    url: 'http://localhost:3000',
    args: [],
    env: {},
    scope: 'user',
    projectPath: null,
    enabled: false,
    status: 'error',
    lastConnected: '2024-01-10T00:00:00Z',
    errorMessage: 'Connection refused',
    toolCount: 0,
    createdAt: '2024-01-03T00:00:00Z',
    updatedAt: '2024-01-10T00:00:00Z',
  },
];

// ============================================================================
// TESTS
// ============================================================================

describe('MCPView', () => {
  beforeEach(() => {
    vi.mocked(window.goodvibes.getMCPServers).mockResolvedValue([]);
    vi.mocked(window.goodvibes.getMCPServer).mockResolvedValue(null);
    vi.mocked(window.goodvibes.createMCPServer).mockResolvedValue({ id: 1, name: 'Test Server' } as MCPServer);
    vi.mocked(window.goodvibes.updateMCPServer).mockResolvedValue(true);
    vi.mocked(window.goodvibes.deleteMCPServer).mockResolvedValue(true);
    vi.mocked(window.goodvibes.setMCPServerStatus).mockResolvedValue(true);
    vi.mocked(window.goodvibes.onMCPServerStatus).mockReturnValue(() => {});
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  // ==========================================================================
  // RENDERING TESTS
  // ==========================================================================

  describe('Rendering', () => {
    it('renders the MCP Servers header', async () => {
      await renderMCPView();
      expect(screen.getByText('MCP Servers')).toBeInTheDocument();
    });

    it('renders the subtitle description', async () => {
      await renderMCPView();
      expect(screen.getByText('Model Context Protocol server management')).toBeInTheDocument();
    });

    it('renders the Add Server button', async () => {
      await renderMCPView();
      expect(screen.getByText('Add Server')).toBeInTheDocument();
    });

    it('renders both Installed and Marketplace tabs', async () => {
      await renderMCPView();
      expect(screen.getByText(/Installed/)).toBeInTheDocument();
      expect(screen.getByText('Marketplace')).toBeInTheDocument();
    });

    it('shows server count in Installed tab', async () => {
      vi.mocked(window.goodvibes.getMCPServers).mockResolvedValue(mockServers);

      await renderMCPView();

      await waitFor(() => {
        expect(screen.getByText(/Installed \(3\)/)).toBeInTheDocument();
      });
    });
  });

  // ==========================================================================
  // LOADING STATE TESTS
  // ==========================================================================

  describe('Loading State', () => {
    it('shows loading spinner while fetching servers', async () => {
      let resolvePromise: (value: MCPServer[]) => void;
      const delayedPromise = new Promise<MCPServer[]>((resolve) => {
        resolvePromise = resolve;
      });

      vi.mocked(window.goodvibes.getMCPServers).mockReturnValue(delayedPromise);

      const { container } = await renderMCPView();

      // Check for loading spinner
      const spinner = container.querySelector('.animate-spin');
      expect(spinner).toBeInTheDocument();

      // Resolve the promise to allow component to settle
      await act(async () => {
        resolvePromise!([]);
        await new Promise(resolve => setTimeout(resolve, 10));
      });
    });
  });

  // ==========================================================================
  // EMPTY STATE TESTS
  // ==========================================================================

  describe('Empty State', () => {
    it('shows empty state when no servers configured', async () => {
      vi.mocked(window.goodvibes.getMCPServers).mockResolvedValue([]);

      await renderMCPView();

      await waitFor(() => {
        expect(screen.getByText('No MCP servers configured')).toBeInTheDocument();
      });
    });

    it('shows description in empty state', async () => {
      vi.mocked(window.goodvibes.getMCPServers).mockResolvedValue([]);

      await renderMCPView();

      await waitFor(() => {
        expect(screen.getByText("Add MCP servers to extend Claude's capabilities")).toBeInTheDocument();
      });
    });

    it('shows Add Custom Server button in empty state', async () => {
      vi.mocked(window.goodvibes.getMCPServers).mockResolvedValue([]);

      await renderMCPView();

      await waitFor(() => {
        expect(screen.getByText('Add Custom Server')).toBeInTheDocument();
      });
    });

    it('shows Browse Marketplace button in empty state', async () => {
      vi.mocked(window.goodvibes.getMCPServers).mockResolvedValue([]);

      await renderMCPView();

      await waitFor(() => {
        expect(screen.getByText('Browse Marketplace')).toBeInTheDocument();
      });
    });
  });

  // ==========================================================================
  // SERVER LIST TESTS
  // ==========================================================================

  describe('Server List', () => {
    it('renders server cards when servers exist', async () => {
      vi.mocked(window.goodvibes.getMCPServers).mockResolvedValue(mockServers);

      await renderMCPView();

      await waitFor(() => {
        expect(screen.getByText('GitHub Server')).toBeInTheDocument();
        expect(screen.getByText('Notion Server')).toBeInTheDocument();
        expect(screen.getByText('Error Server')).toBeInTheDocument();
      });
    });

    it('displays server transport type', async () => {
      vi.mocked(window.goodvibes.getMCPServers).mockResolvedValue(mockServers);

      await renderMCPView();

      await waitFor(() => {
        const stdioBadges = screen.getAllByText('STDIO');
        expect(stdioBadges.length).toBeGreaterThanOrEqual(2);
        expect(screen.getByText('HTTP')).toBeInTheDocument();
      });
    });
  });

  // ==========================================================================
  // SERVER FORM TESTS
  // ==========================================================================

  describe('Server Form', () => {
    it('shows form when Add Server clicked', async () => {
      await renderMCPView();

      await act(async () => {
        fireEvent.click(screen.getByText('Add Server'));
      });

      await waitFor(() => {
        expect(screen.getByPlaceholderText('My MCP Server')).toBeInTheDocument();
      });
    });

    it('hides form when Cancel clicked', async () => {
      await renderMCPView();

      await act(async () => {
        fireEvent.click(screen.getByText('Add Server'));
      });

      await waitFor(() => {
        expect(screen.getByText('Cancel')).toBeInTheDocument();
      });

      await act(async () => {
        fireEvent.click(screen.getByText('Cancel'));
      });

      await waitFor(() => {
        expect(screen.queryByPlaceholderText('My MCP Server')).not.toBeInTheDocument();
      });
    });
  });

  // ==========================================================================
  // SERVER ACTIONS TESTS
  // ==========================================================================

  describe('Server Actions', () => {
    it('calls setServerStatus on Start button click', async () => {
      vi.mocked(window.goodvibes.getMCPServers).mockResolvedValue([mockServers[1]]); // disconnected server

      await renderMCPView();

      await waitFor(() => {
        expect(screen.getByText('Notion Server')).toBeInTheDocument();
      });

      const startButton = screen.getByTitle('Start');
      await act(async () => {
        fireEvent.click(startButton);
      });

      await waitFor(() => {
        expect(vi.mocked(window.goodvibes.setMCPServerStatus)).toHaveBeenCalled();
      });
    });

    it('calls setServerStatus on Stop button click', async () => {
      vi.mocked(window.goodvibes.getMCPServers).mockResolvedValue([mockServers[0]]); // connected server

      await renderMCPView();

      await waitFor(() => {
        expect(screen.getByText('GitHub Server')).toBeInTheDocument();
      });

      const stopButton = screen.getByTitle('Stop');
      await act(async () => {
        fireEvent.click(stopButton);
      });

      await waitFor(() => {
        expect(vi.mocked(window.goodvibes.setMCPServerStatus)).toHaveBeenCalled();
      });
    });
  });

  // ==========================================================================
  // MARKETPLACE TESTS
  // ==========================================================================

  describe('Marketplace', () => {
    it('switches to marketplace tab on click', async () => {
      await renderMCPView();

      await act(async () => {
        fireEvent.click(screen.getByText('Marketplace'));
      });

      await waitFor(() => {
        expect(screen.getByPlaceholderText('Search servers...')).toBeInTheDocument();
      });
    });

    it('displays marketplace servers', async () => {
      await renderMCPView();

      await act(async () => {
        fireEvent.click(screen.getByText('Marketplace'));
      });

      await waitFor(() => {
        expect(screen.getByText('Notion')).toBeInTheDocument();
        expect(screen.getByText('GitHub')).toBeInTheDocument();
      });
    });

    it('filters marketplace servers by search', async () => {
      await renderMCPView();

      await act(async () => {
        fireEvent.click(screen.getByText('Marketplace'));
      });

      await waitFor(() => {
        expect(screen.getByPlaceholderText('Search servers...')).toBeInTheDocument();
      });

      const searchInput = screen.getByPlaceholderText('Search servers...');
      await act(async () => {
        fireEvent.change(searchInput, { target: { value: 'notion' } });
      });

      await waitFor(() => {
        expect(screen.getByText('Notion')).toBeInTheDocument();
        expect(screen.queryByText('PostgreSQL')).not.toBeInTheDocument();
      });
    });

    it('filters marketplace servers by category', async () => {
      await renderMCPView();

      await act(async () => {
        fireEvent.click(screen.getByText('Marketplace'));
      });

      await waitFor(() => {
        expect(screen.getByDisplayValue('All Categories')).toBeInTheDocument();
      });

      const categorySelect = screen.getByDisplayValue('All Categories');
      await act(async () => {
        fireEvent.change(categorySelect, { target: { value: 'database' } });
      });

      await waitFor(() => {
        expect(screen.getByText('PostgreSQL')).toBeInTheDocument();
        expect(screen.queryByText('Slack')).not.toBeInTheDocument();
      });
    });
  });

  // ==========================================================================
  // ERROR HANDLING TESTS
  // ==========================================================================

  describe('Error Handling', () => {
    it('displays error message on server with error status', async () => {
      vi.mocked(window.goodvibes.getMCPServers).mockResolvedValue([mockServers[2]]);

      await renderMCPView();

      await waitFor(() => {
        expect(screen.getByText('Connection refused')).toBeInTheDocument();
      });
    });
  });
});
