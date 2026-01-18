// ============================================================================
// MCP MARKETPLACE CARD COMPONENT TESTS
// ============================================================================

import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { MCPMarketplaceCard, type MarketplaceServer, MARKETPLACE_SERVERS } from './MCPMarketplaceCard';

// ============================================================================
// MOCK DATA
// ============================================================================

const createMockMarketplaceServer = (overrides: Partial<MarketplaceServer> = {}): MarketplaceServer => ({
  id: 'test-server',
  name: 'Test Server',
  description: 'A test marketplace server for unit testing',
  category: 'productivity',
  transport: 'stdio',
  npmPackage: '@test/mcp-server',
  requiredEnv: ['API_KEY'],
  documentation: 'https://docs.example.com',
  repository: 'https://github.com/example/mcp-server',
  popular: false,
  featured: false,
  ...overrides,
});

// ============================================================================
// TESTS
// ============================================================================

describe('MCPMarketplaceCard', () => {
  const mockOnInstall = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
  });

  const renderCard = (
    server: MarketplaceServer = createMockMarketplaceServer(),
    installed: boolean = false
  ) => {
    return render(
      <MCPMarketplaceCard
        server={server}
        installed={installed}
        onInstall={mockOnInstall}
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
      expect(screen.getByText('A test marketplace server for unit testing')).toBeInTheDocument();
    });

    it('renders required environment variables', () => {
      renderCard();
      expect(screen.getByText(/Requires:/)).toBeInTheDocument();
      expect(screen.getByText(/API_KEY/)).toBeInTheDocument();
    });

    it('renders multiple required env vars', () => {
      renderCard(createMockMarketplaceServer({
        requiredEnv: ['API_KEY', 'SECRET_TOKEN', 'DATABASE_URL'],
      }));
      expect(screen.getByText(/API_KEY, SECRET_TOKEN, DATABASE_URL/)).toBeInTheDocument();
    });

    it('does not render required env section when not required', () => {
      renderCard(createMockMarketplaceServer({
        requiredEnv: undefined,
      }));
      expect(screen.queryByText(/Requires:/)).not.toBeInTheDocument();
    });

    it('does not render required env section for empty array', () => {
      renderCard(createMockMarketplaceServer({
        requiredEnv: [],
      }));
      expect(screen.queryByText(/Requires:/)).not.toBeInTheDocument();
    });

    it('renders documentation link when available', () => {
      renderCard();
      const docLink = screen.getByTitle('Documentation');
      expect(docLink).toBeInTheDocument();
      expect(docLink).toHaveAttribute('href', 'https://docs.example.com');
    });

    it('does not render documentation link when not available', () => {
      renderCard(createMockMarketplaceServer({
        documentation: undefined,
      }));
      expect(screen.queryByTitle('Documentation')).not.toBeInTheDocument();
    });
  });

  // ==========================================================================
  // INSTALLATION STATE TESTS
  // ==========================================================================

  describe('Installation State', () => {
    it('shows Install button when not installed', () => {
      renderCard(createMockMarketplaceServer(), false);
      expect(screen.getByText('Install')).toBeInTheDocument();
    });

    it('shows Installed badge when installed', () => {
      renderCard(createMockMarketplaceServer(), true);
      expect(screen.getByText('Installed')).toBeInTheDocument();
    });

    it('does not show Install button when installed', () => {
      renderCard(createMockMarketplaceServer(), true);
      expect(screen.queryByRole('button', { name: 'Install' })).not.toBeInTheDocument();
    });

    it('applies card-selected class when installed', () => {
      const { container } = renderCard(createMockMarketplaceServer(), true);
      const card = container.querySelector('.card-selected');
      expect(card).toBeInTheDocument();
    });
  });

  // ==========================================================================
  // POPULAR BADGE TESTS
  // ==========================================================================

  describe('Popular Badge', () => {
    it('shows Popular badge when popular is true', () => {
      renderCard(createMockMarketplaceServer({ popular: true }));
      expect(screen.getByText('Popular')).toBeInTheDocument();
    });

    it('does not show Popular badge when popular is false', () => {
      renderCard(createMockMarketplaceServer({ popular: false }));
      expect(screen.queryByText('Popular')).not.toBeInTheDocument();
    });

    it('does not show Popular badge for featured items', () => {
      renderCard(createMockMarketplaceServer({ popular: true, featured: true }));
      // Featured items don't show Popular badge (they have vibes badge instead)
      expect(screen.queryByText('Popular')).not.toBeInTheDocument();
    });
  });

  // ==========================================================================
  // FEATURED ITEM TESTS
  // ==========================================================================

  describe('Featured Items', () => {
    it('applies featured card class when featured', () => {
      const { container } = renderCard(createMockMarketplaceServer({ featured: true }));
      const card = container.querySelector('.card-featured');
      expect(card).toBeInTheDocument();
    });

    it('shows vibes badge when featured with vibes', () => {
      renderCard(createMockMarketplaceServer({
        featured: true,
        vibes: 'immaculate',
      }));
      expect(screen.getByText('immaculate vibes')).toBeInTheDocument();
    });

    it('applies rainbow title styling for featured items', () => {
      const { container } = renderCard(createMockMarketplaceServer({ featured: true }));
      const title = container.querySelector('.card-title-rainbow');
      expect(title).toBeInTheDocument();
    });

    it('applies gradient title styling for non-featured items', () => {
      const { container } = renderCard(createMockMarketplaceServer({ featured: false }));
      const title = container.querySelector('.card-title-gradient');
      expect(title).toBeInTheDocument();
    });
  });

  // ==========================================================================
  // CATEGORY ICON TESTS
  // ==========================================================================

  describe('Category Icons', () => {
    it('renders productivity category icon', () => {
      const { container } = renderCard(createMockMarketplaceServer({ category: 'productivity' }));
      const iconContainer = container.querySelector('.card-icon');
      expect(iconContainer).toBeInTheDocument();
    });

    it('renders devops category icon', () => {
      const { container } = renderCard(createMockMarketplaceServer({ category: 'devops' }));
      const iconContainer = container.querySelector('.card-icon');
      expect(iconContainer).toBeInTheDocument();
    });

    it('renders communication category icon', () => {
      const { container } = renderCard(createMockMarketplaceServer({ category: 'communication' }));
      const iconContainer = container.querySelector('.card-icon');
      expect(iconContainer).toBeInTheDocument();
    });

    it('renders database category icon', () => {
      const { container } = renderCard(createMockMarketplaceServer({ category: 'database' }));
      const iconContainer = container.querySelector('.card-icon');
      expect(iconContainer).toBeInTheDocument();
    });

    it('renders custom category icon', () => {
      const { container } = renderCard(createMockMarketplaceServer({ category: 'custom' }));
      const iconContainer = container.querySelector('.card-icon');
      expect(iconContainer).toBeInTheDocument();
    });

    it('renders featured icon for featured items', () => {
      const { container } = renderCard(createMockMarketplaceServer({ featured: true }));
      const iconContainer = container.querySelector('.card-icon-featured');
      expect(iconContainer).toBeInTheDocument();
    });
  });

  // ==========================================================================
  // INSTALL CALLBACK TESTS
  // ==========================================================================

  describe('Install Callback', () => {
    it('calls onInstall with server when Install clicked', () => {
      const server = createMockMarketplaceServer();
      renderCard(server, false);

      fireEvent.click(screen.getByText('Install'));

      expect(mockOnInstall).toHaveBeenCalledTimes(1);
      expect(mockOnInstall).toHaveBeenCalledWith(server);
    });

    it('does not call onInstall when server is already installed', () => {
      renderCard(createMockMarketplaceServer(), true);

      // No install button to click, but verify callback not called
      expect(mockOnInstall).not.toHaveBeenCalled();
    });
  });

  // ==========================================================================
  // DOCUMENTATION LINK TESTS
  // ==========================================================================

  describe('Documentation Link', () => {
    it('opens documentation in new tab', () => {
      renderCard();
      const docLink = screen.getByTitle('Documentation');
      expect(docLink).toHaveAttribute('target', '_blank');
      expect(docLink).toHaveAttribute('rel', 'noopener noreferrer');
    });
  });

  // ==========================================================================
  // MARKETPLACE_SERVERS DATA TESTS
  // ==========================================================================

  describe('MARKETPLACE_SERVERS Data', () => {
    it('exports marketplace servers array', () => {
      expect(Array.isArray(MARKETPLACE_SERVERS)).toBe(true);
      expect(MARKETPLACE_SERVERS.length).toBeGreaterThan(0);
    });

    it('includes Notion server', () => {
      const notion = MARKETPLACE_SERVERS.find(s => s.id === 'notion');
      expect(notion).toBeDefined();
      expect(notion?.name).toBe('Notion');
      expect(notion?.category).toBe('productivity');
    });

    it('includes GitHub server', () => {
      const github = MARKETPLACE_SERVERS.find(s => s.id === 'github');
      expect(github).toBeDefined();
      expect(github?.name).toBe('GitHub');
      expect(github?.category).toBe('devops');
    });

    it('includes Slack server', () => {
      const slack = MARKETPLACE_SERVERS.find(s => s.id === 'slack');
      expect(slack).toBeDefined();
      expect(slack?.name).toBe('Slack');
      expect(slack?.category).toBe('communication');
    });

    it('includes PostgreSQL server', () => {
      const postgres = MARKETPLACE_SERVERS.find(s => s.id === 'postgres');
      expect(postgres).toBeDefined();
      expect(postgres?.name).toBe('PostgreSQL');
      expect(postgres?.category).toBe('database');
    });

    it('all servers have required fields', () => {
      MARKETPLACE_SERVERS.forEach(server => {
        expect(server.id).toBeDefined();
        expect(server.name).toBeDefined();
        expect(server.description).toBeDefined();
        expect(server.category).toBeDefined();
        expect(server.transport).toBeDefined();
      });
    });

    it('all servers have valid transport type', () => {
      MARKETPLACE_SERVERS.forEach(server => {
        expect(['stdio', 'http']).toContain(server.transport);
      });
    });

    it('all servers have valid category', () => {
      const validCategories = ['productivity', 'devops', 'communication', 'database', 'custom'];
      MARKETPLACE_SERVERS.forEach(server => {
        expect(validCategories).toContain(server.category);
      });
    });
  });

  // ==========================================================================
  // EDGE CASES
  // ==========================================================================

  describe('Edge Cases', () => {
    it('handles server with minimal data', () => {
      const minimalServer: MarketplaceServer = {
        id: 'minimal',
        name: 'Minimal',
        description: 'Minimal server',
        category: 'custom',
        transport: 'stdio',
      };
      renderCard(minimalServer);
      expect(screen.getByText('Minimal')).toBeInTheDocument();
    });

    it('handles server with very long name', () => {
      const longName = 'A'.repeat(100);
      renderCard(createMockMarketplaceServer({ name: longName }));
      expect(screen.getByText(longName)).toBeInTheDocument();
    });

    it('handles server with very long description', () => {
      const longDesc = 'B'.repeat(500);
      renderCard(createMockMarketplaceServer({ description: longDesc }));
      expect(screen.getByText(longDesc)).toBeInTheDocument();
    });

    it('handles server with special characters in name', () => {
      const specialName = 'Test <Server> & "More"';
      renderCard(createMockMarketplaceServer({ name: specialName }));
      expect(screen.getByText(specialName)).toBeInTheDocument();
    });

    it('handles server with all optional fields', () => {
      const fullServer = createMockMarketplaceServer({
        npmPackage: '@full/server',
        command: 'npx server',
        args: ['--arg'],
        requiredEnv: ['KEY1', 'KEY2'],
        documentation: 'https://docs.example.com',
        repository: 'https://github.com/example/server',
        popular: true,
        featured: true,
        vibes: 'great',
      });
      renderCard(fullServer);
      expect(screen.getByText(fullServer.name)).toBeInTheDocument();
    });

    it('handles unknown category gracefully', () => {
      const unknownCategory = createMockMarketplaceServer({
        // @ts-expect-error Testing invalid category
        category: 'unknown',
      });
      const { container } = renderCard(unknownCategory);
      // Should still render with default icon
      expect(container.querySelector('.card-icon')).toBeInTheDocument();
    });
  });

  // ==========================================================================
  // ACCESSIBILITY TESTS
  // ==========================================================================

  describe('Accessibility', () => {
    it('documentation link has title for accessibility', () => {
      renderCard();
      const docLink = screen.getByTitle('Documentation');
      expect(docLink).toBeInTheDocument();
    });

    it('install button is focusable', () => {
      renderCard(createMockMarketplaceServer(), false);
      const installButton = screen.getByText('Install');
      expect(installButton.closest('button')).toBeInTheDocument();
    });
  });
});
