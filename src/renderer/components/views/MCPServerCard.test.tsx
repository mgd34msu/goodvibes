// ============================================================================
// MCP SERVER CARD COMPONENT TESTS
// ============================================================================

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { MCPServerCard, type MCPServer } from './MCPServerCard';

// ============================================================================
// MOCK DATA
// ============================================================================

const createMockServer = (overrides: Partial<MCPServer> = {}): MCPServer => ({
  id: 1,
  name: 'Test Server',
  description: 'A test MCP server',
  transport: 'stdio',
  command: 'npx @test/mcp-server',
  url: null,
  args: ['--flag', 'value'],
  env: { API_KEY: 'secret' },
  scope: 'user',
  projectPath: null,
  enabled: true,
  status: 'disconnected',
  lastConnected: null,
  errorMessage: null,
  toolCount: 10,
  createdAt: '2024-01-01T00:00:00Z',
  updatedAt: '2024-01-01T00:00:00Z',
  ...overrides,
});

// ============================================================================
// TESTS
// ============================================================================

describe('MCPServerCard', () => {
  const mockOnStart = vi.fn();
  const mockOnStop = vi.fn();
  const mockOnRestart = vi.fn();
  const mockOnEdit = vi.fn();
  const mockOnDelete = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
  });

  const renderCard = (server: MCPServer = createMockServer()) => {
    return render(
      <MCPServerCard
        server={server}
        onStart={mockOnStart}
        onStop={mockOnStop}
        onRestart={mockOnRestart}
        onEdit={mockOnEdit}
        onDelete={mockOnDelete}
      />
    );
  };

  // ==========================================================================
  // RENDERING TESTS
  // ==========================================================================

  describe('Rendering', () => {
    it('renders server name', () => {
      renderCard();
      expect(screen.getByText('Test Server')).toBeInTheDocument();
    });

    it('renders server description', () => {
      renderCard();
      expect(screen.getByText('A test MCP server')).toBeInTheDocument();
    });

    it('renders transport badge', () => {
      renderCard();
      expect(screen.getByText('STDIO')).toBeInTheDocument();
    });

    it('renders HTTP transport badge for http servers', () => {
      renderCard(createMockServer({ transport: 'http' }));
      expect(screen.getByText('HTTP')).toBeInTheDocument();
    });

    it('renders scope badge', () => {
      renderCard();
      expect(screen.getByText('user')).toBeInTheDocument();
    });

    it('renders project scope badge', () => {
      renderCard(createMockServer({ scope: 'project' }));
      expect(screen.getByText('project')).toBeInTheDocument();
    });

    it('renders tool count', () => {
      renderCard();
      expect(screen.getByText('Tools: 10')).toBeInTheDocument();
    });

    it('renders last connected timestamp when available', () => {
      const lastConnected = '2024-01-15T10:30:00Z';
      renderCard(createMockServer({ lastConnected }));
      expect(screen.getByText(/Last connected:/)).toBeInTheDocument();
    });

    it('does not render last connected when not available', () => {
      renderCard(createMockServer({ lastConnected: null }));
      expect(screen.queryByText(/Last connected:/)).not.toBeInTheDocument();
    });

    it('does not render description when null', () => {
      renderCard(createMockServer({ description: null }));
      expect(screen.queryByText('A test MCP server')).not.toBeInTheDocument();
    });
  });

  // ==========================================================================
  // STATUS DISPLAY TESTS
  // ==========================================================================

  describe('Status Display', () => {
    it('displays connected status', () => {
      const { container } = renderCard(createMockServer({ status: 'connected' }));
      const statusIndicator = container.querySelector('.card-status-connected');
      expect(statusIndicator).toBeInTheDocument();
    });

    it('displays disconnected status', () => {
      const { container } = renderCard(createMockServer({ status: 'disconnected' }));
      const statusIndicator = container.querySelector('.card-status-disconnected');
      expect(statusIndicator).toBeInTheDocument();
    });

    it('displays error status', () => {
      const { container } = renderCard(createMockServer({ status: 'error' }));
      const statusIndicator = container.querySelector('.card-status-error');
      expect(statusIndicator).toBeInTheDocument();
    });

    it('displays unknown status', () => {
      const { container } = renderCard(createMockServer({ status: 'unknown' }));
      const statusIndicator = container.querySelector('.card-status-warning');
      expect(statusIndicator).toBeInTheDocument();
    });

    it('displays error message when present', () => {
      renderCard(createMockServer({
        status: 'error',
        errorMessage: 'Connection refused',
      }));
      expect(screen.getByText('Connection refused')).toBeInTheDocument();
    });

    it('does not display error message when not present', () => {
      renderCard(createMockServer({
        status: 'connected',
        errorMessage: null,
      }));
      expect(screen.queryByText('Connection refused')).not.toBeInTheDocument();
    });
  });

  // ==========================================================================
  // DISABLED STATE TESTS
  // ==========================================================================

  describe('Disabled State', () => {
    it('applies disabled class when server is disabled', () => {
      const { container } = renderCard(createMockServer({ enabled: false }));
      const card = container.querySelector('.card-disabled');
      expect(card).toBeInTheDocument();
    });

    it('does not apply disabled class when server is enabled', () => {
      const { container } = renderCard(createMockServer({ enabled: true }));
      const card = container.querySelector('.card-disabled');
      expect(card).not.toBeInTheDocument();
    });
  });

  // ==========================================================================
  // ACTION BUTTONS TESTS
  // ==========================================================================

  describe('Action Buttons', () => {
    it('shows Start button when disconnected', () => {
      renderCard(createMockServer({ status: 'disconnected' }));
      expect(screen.getByTitle('Start')).toBeInTheDocument();
    });

    it('shows Stop button when connected', () => {
      renderCard(createMockServer({ status: 'connected' }));
      expect(screen.getByTitle('Stop')).toBeInTheDocument();
    });

    it('shows Start button when in error state', () => {
      renderCard(createMockServer({ status: 'error' }));
      expect(screen.getByTitle('Start')).toBeInTheDocument();
    });

    it('shows Start button when in unknown state', () => {
      renderCard(createMockServer({ status: 'unknown' }));
      expect(screen.getByTitle('Start')).toBeInTheDocument();
    });

    it('always shows Restart button', () => {
      renderCard();
      expect(screen.getByTitle('Restart')).toBeInTheDocument();
    });

    it('always shows Edit button', () => {
      renderCard();
      expect(screen.getByTitle('Edit')).toBeInTheDocument();
    });

    it('always shows Delete button', () => {
      renderCard();
      expect(screen.getByTitle('Delete')).toBeInTheDocument();
    });
  });

  // ==========================================================================
  // CALLBACK TESTS
  // ==========================================================================

  describe('Callbacks', () => {
    it('calls onStart with server id when Start clicked', () => {
      const server = createMockServer({ status: 'disconnected' });
      renderCard(server);

      fireEvent.click(screen.getByTitle('Start'));

      expect(mockOnStart).toHaveBeenCalledTimes(1);
      expect(mockOnStart).toHaveBeenCalledWith(server.id);
    });

    it('calls onStop with server id when Stop clicked', () => {
      const server = createMockServer({ status: 'connected' });
      renderCard(server);

      fireEvent.click(screen.getByTitle('Stop'));

      expect(mockOnStop).toHaveBeenCalledTimes(1);
      expect(mockOnStop).toHaveBeenCalledWith(server.id);
    });

    it('calls onRestart with server id when Restart clicked', () => {
      const server = createMockServer();
      renderCard(server);

      fireEvent.click(screen.getByTitle('Restart'));

      expect(mockOnRestart).toHaveBeenCalledTimes(1);
      expect(mockOnRestart).toHaveBeenCalledWith(server.id);
    });

    it('calls onEdit with server object when Edit clicked', () => {
      const server = createMockServer();
      renderCard(server);

      fireEvent.click(screen.getByTitle('Edit'));

      expect(mockOnEdit).toHaveBeenCalledTimes(1);
      expect(mockOnEdit).toHaveBeenCalledWith(server);
    });

    it('calls onDelete with server id when Delete clicked', () => {
      const server = createMockServer();
      renderCard(server);

      fireEvent.click(screen.getByTitle('Delete'));

      expect(mockOnDelete).toHaveBeenCalledTimes(1);
      expect(mockOnDelete).toHaveBeenCalledWith(server.id);
    });
  });

  // ==========================================================================
  // ICON DISPLAY TESTS
  // ==========================================================================

  describe('Icon Display', () => {
    it('shows success icon styling for connected status', () => {
      const { container } = renderCard(createMockServer({ status: 'connected' }));
      const iconContainer = container.querySelector('.card-icon-success');
      expect(iconContainer).toBeInTheDocument();
    });

    it('shows error icon styling for error status', () => {
      const { container } = renderCard(createMockServer({ status: 'error' }));
      const iconContainer = container.querySelector('.card-icon-error');
      expect(iconContainer).toBeInTheDocument();
    });

    it('shows warning icon styling for unknown status', () => {
      const { container } = renderCard(createMockServer({ status: 'unknown' }));
      const iconContainer = container.querySelector('.card-icon-warning');
      expect(iconContainer).toBeInTheDocument();
    });
  });

  // ==========================================================================
  // EDGE CASES
  // ==========================================================================

  describe('Edge Cases', () => {
    it('handles server with minimal data', () => {
      const minimalServer = createMockServer({
        description: null,
        lastConnected: null,
        errorMessage: null,
        args: [],
        env: {},
        toolCount: 0,
      });

      renderCard(minimalServer);

      expect(screen.getByText('Test Server')).toBeInTheDocument();
      expect(screen.getByText('Tools: 0')).toBeInTheDocument();
    });

    it('handles server with very long name', () => {
      const longName = 'A'.repeat(100);
      renderCard(createMockServer({ name: longName }));
      expect(screen.getByText(longName)).toBeInTheDocument();
    });

    it('handles server with very long description', () => {
      const longDescription = 'B'.repeat(500);
      renderCard(createMockServer({ description: longDescription }));
      expect(screen.getByText(longDescription)).toBeInTheDocument();
    });

    it('handles server with special characters in name', () => {
      const specialName = 'Test <Server> & "More"';
      renderCard(createMockServer({ name: specialName }));
      expect(screen.getByText(specialName)).toBeInTheDocument();
    });

    it('handles server with zero tool count', () => {
      renderCard(createMockServer({ toolCount: 0 }));
      expect(screen.getByText('Tools: 0')).toBeInTheDocument();
    });

    it('handles server with high tool count', () => {
      renderCard(createMockServer({ toolCount: 9999 }));
      expect(screen.getByText('Tools: 9999')).toBeInTheDocument();
    });
  });
});
