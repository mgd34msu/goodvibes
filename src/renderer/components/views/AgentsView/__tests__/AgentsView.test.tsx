// ============================================================================
// AGENTS VIEW COMPONENT TESTS
// Comprehensive test suite for AgentsView and child components
// ============================================================================

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import AgentsView from '../index';
import { AgentCard } from '../AgentCard';
import { AgentFilters } from '../AgentFilters';
import { AgentForm } from '../AgentForm';
import { AgentList } from '../AgentList';
import { InstallAgentModal } from '../InstallAgentModal';
import { useAgents, useAgentFilters } from '../hooks';
import { BUILT_IN_AGENTS } from '../constants';
import type { AgentTemplate, BuiltInAgent, AgentCardAgent } from '../types';
import { renderHook } from '@testing-library/react';
import { useToastStore } from '../../../../stores/toastStore';

// ============================================================================
// TEST UTILITIES
// ============================================================================

async function renderAgentsView() {
  let result: ReturnType<typeof render>;

  await act(async () => {
    result = render(<AgentsView />);
    await new Promise(resolve => setTimeout(resolve, 0));
  });

  return result!;
}

// ============================================================================
// MOCK DATA
// ============================================================================

const mockAgentTemplate: AgentTemplate = {
  id: '1',
  name: 'test-agent',
  description: 'A test agent for unit testing',
  cwd: null,
  initialPrompt: 'You are a helpful test agent.',
  claudeMdContent: '# Test CLAUDE.md content',
  flags: ['--verbose'],
  model: 'claude-sonnet-4-20250514',
  permissionMode: 'default',
  allowedTools: ['Read', 'Write', 'Edit'],
  deniedTools: null,
  createdAt: '2024-01-01T00:00:00Z',
  updatedAt: '2024-01-15T10:00:00Z',
};

const mockProjectAgent: AgentTemplate = {
  id: '2',
  name: 'project-agent',
  description: 'A project-specific agent',
  cwd: '/projects/my-project',
  initialPrompt: 'You help with this specific project.',
  claudeMdContent: null,
  flags: [],
  model: null,
  permissionMode: 'plan',
  allowedTools: null,
  deniedTools: ['Bash'],
  createdAt: '2024-01-02T00:00:00Z',
  updatedAt: '2024-01-02T00:00:00Z',
};

const mockBuiltInAgent: BuiltInAgent & { isBuiltIn: true } = {
  name: 'explore',
  description: 'Quickly explore and understand unfamiliar codebases',
  cwd: null,
  initialPrompt: 'You are an exploration agent.',
  claudeMdContent: null,
  flags: [],
  model: null,
  permissionMode: 'default',
  allowedTools: ['Read', 'Grep', 'Glob', 'LSP'],
  deniedTools: ['Edit', 'Write', 'Bash'],
  isBuiltIn: true,
};

const mockAgents: AgentTemplate[] = [mockAgentTemplate, mockProjectAgent];

// ============================================================================
// AGENTS VIEW TESTS
// ============================================================================

describe('AgentsView', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(window.goodvibes.getAgentTemplates).mockResolvedValue([]);
    vi.mocked(window.goodvibes.projectGetAll).mockResolvedValue([]);
    useToastStore.setState({ toasts: [] });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  // ==========================================================================
  // RENDERING TESTS
  // ==========================================================================

  describe('Rendering', () => {
    it('renders the Agents header', async () => {
      await renderAgentsView();
      expect(screen.getByText('Agents')).toBeInTheDocument();
    });

    it('renders the subtitle description', async () => {
      await renderAgentsView();
      expect(screen.getByText('Agent template library for Claude Code')).toBeInTheDocument();
    });

    it('renders the New Agent button', async () => {
      await renderAgentsView();
      expect(screen.getByText('New Agent')).toBeInTheDocument();
    });

    it('renders search input', async () => {
      await renderAgentsView();
      expect(screen.getByPlaceholderText('Search agents...')).toBeInTheDocument();
    });

    it('renders show built-in toggle button', async () => {
      await renderAgentsView();
      expect(screen.getByText('Hide Built-in')).toBeInTheDocument();
    });

    it('renders About Agents info section', async () => {
      await renderAgentsView();
      expect(screen.getByText('About Agents')).toBeInTheDocument();
    });
  });

  // ==========================================================================
  // LOADING STATE TESTS
  // ==========================================================================

  describe('Loading State', () => {
    it('shows loading spinner while fetching agents', async () => {
      let resolvePromise: (value: AgentTemplate[]) => void;
      const delayedPromise = new Promise<AgentTemplate[]>((resolve) => {
        resolvePromise = resolve;
      });

      vi.mocked(window.goodvibes.getAgentTemplates).mockReturnValue(delayedPromise);

      const { container } = await renderAgentsView();

      const spinner = container.querySelector('.animate-spin');
      expect(spinner).toBeInTheDocument();

      await act(async () => {
        resolvePromise!([]);
        await new Promise(resolve => setTimeout(resolve, 0));
      });
    });

    it('removes loading spinner after agents are loaded', async () => {
      vi.mocked(window.goodvibes.getAgentTemplates).mockResolvedValue(mockAgents);

      const { container } = await renderAgentsView();

      await waitFor(() => {
        const spinner = container.querySelector('.animate-spin');
        expect(spinner).not.toBeInTheDocument();
      });
    });
  });

  // ==========================================================================
  // AGENT LIST TESTS
  // ==========================================================================

  describe('Agent List', () => {
    it('renders custom agents when they exist', async () => {
      vi.mocked(window.goodvibes.getAgentTemplates).mockResolvedValue(mockAgents);

      await renderAgentsView();

      await waitFor(() => {
        expect(screen.getByText('test-agent')).toBeInTheDocument();
        expect(screen.getByText('project-agent')).toBeInTheDocument();
      });
    });

    it('shows custom agent count in section header', async () => {
      vi.mocked(window.goodvibes.getAgentTemplates).mockResolvedValue(mockAgents);

      await renderAgentsView();

      await waitFor(() => {
        expect(screen.getByText('Custom Agents (2)')).toBeInTheDocument();
      });
    });

    it('shows built-in agents section', async () => {
      vi.mocked(window.goodvibes.getAgentTemplates).mockResolvedValue([]);

      await renderAgentsView();

      await waitFor(() => {
        expect(screen.getByText(/Built-in Agents/)).toBeInTheDocument();
      });
    });

    it('displays built-in agents from constants', async () => {
      vi.mocked(window.goodvibes.getAgentTemplates).mockResolvedValue([]);

      await renderAgentsView();

      await waitFor(() => {
        expect(screen.getByText('explore')).toBeInTheDocument();
        expect(screen.getByText('implement')).toBeInTheDocument();
        expect(screen.getByText('test-writer')).toBeInTheDocument();
      });
    });
  });

  // ==========================================================================
  // EMPTY STATE TESTS
  // ==========================================================================

  describe('Empty State', () => {
    it('shows empty state message when no agents and built-in hidden', async () => {
      vi.mocked(window.goodvibes.getAgentTemplates).mockResolvedValue([]);

      await renderAgentsView();

      // Hide built-in agents
      const toggleButton = screen.getByText('Hide Built-in');
      await act(async () => {
        fireEvent.click(toggleButton);
      });

      await waitFor(() => {
        expect(screen.getByText('No custom agents yet')).toBeInTheDocument();
      });
    });

    it('shows create first agent button in empty state', async () => {
      vi.mocked(window.goodvibes.getAgentTemplates).mockResolvedValue([]);

      await renderAgentsView();

      const toggleButton = screen.getByText('Hide Built-in');
      await act(async () => {
        fireEvent.click(toggleButton);
      });

      await waitFor(() => {
        expect(screen.getByText('Create your first agent')).toBeInTheDocument();
      });
    });
  });

  // ==========================================================================
  // FORM TOGGLE TESTS
  // ==========================================================================

  describe('Form Toggle', () => {
    it('shows form when New Agent clicked', async () => {
      await renderAgentsView();

      await act(async () => {
        fireEvent.click(screen.getByText('New Agent'));
      });

      await waitFor(() => {
        expect(screen.getByText('Agent Name')).toBeInTheDocument();
        expect(screen.getByPlaceholderText('my-agent')).toBeInTheDocument();
      });
    });

    it('hides form when Cancel clicked', async () => {
      await renderAgentsView();

      await act(async () => {
        fireEvent.click(screen.getByText('New Agent'));
      });

      await waitFor(() => {
        expect(screen.getByText('Cancel')).toBeInTheDocument();
      });

      await act(async () => {
        fireEvent.click(screen.getByText('Cancel'));
      });

      await waitFor(() => {
        expect(screen.queryByPlaceholderText('my-agent')).not.toBeInTheDocument();
      });
    });
  });

  // ==========================================================================
  // SEARCH/FILTER TESTS
  // ==========================================================================

  describe('Search and Filters', () => {
    it('filters agents by search query', async () => {
      vi.mocked(window.goodvibes.getAgentTemplates).mockResolvedValue(mockAgents);

      await renderAgentsView();

      await waitFor(() => {
        expect(screen.getByText('test-agent')).toBeInTheDocument();
        expect(screen.getByText('project-agent')).toBeInTheDocument();
      });

      const searchInput = screen.getByPlaceholderText('Search agents...');
      await act(async () => {
        fireEvent.change(searchInput, { target: { value: 'project' } });
      });

      await waitFor(() => {
        expect(screen.queryByText('test-agent')).not.toBeInTheDocument();
        expect(screen.getByText('project-agent')).toBeInTheDocument();
      });
    });

    it('filters by description text as well', async () => {
      vi.mocked(window.goodvibes.getAgentTemplates).mockResolvedValue(mockAgents);

      await renderAgentsView();

      const searchInput = screen.getByPlaceholderText('Search agents...');
      await act(async () => {
        fireEvent.change(searchInput, { target: { value: 'unit testing' } });
      });

      await waitFor(() => {
        expect(screen.getByText('test-agent')).toBeInTheDocument();
        expect(screen.queryByText('project-agent')).not.toBeInTheDocument();
      });
    });

    it('shows no match message when search has no results', async () => {
      vi.mocked(window.goodvibes.getAgentTemplates).mockResolvedValue([]);

      await renderAgentsView();

      const searchInput = screen.getByPlaceholderText('Search agents...');
      await act(async () => {
        fireEvent.change(searchInput, { target: { value: 'nonexistent' } });
      });

      // Hide built-in to see empty state
      const toggleButton = screen.getByText('Hide Built-in');
      await act(async () => {
        fireEvent.click(toggleButton);
      });

      await waitFor(() => {
        expect(screen.getByText('No agents match your search')).toBeInTheDocument();
      });
    });

    it('toggles built-in agents visibility', async () => {
      vi.mocked(window.goodvibes.getAgentTemplates).mockResolvedValue([]);

      await renderAgentsView();

      await waitFor(() => {
        expect(screen.getByText('explore')).toBeInTheDocument();
      });

      const toggleButton = screen.getByText('Hide Built-in');
      await act(async () => {
        fireEvent.click(toggleButton);
      });

      await waitFor(() => {
        expect(screen.queryByText('explore')).not.toBeInTheDocument();
        expect(screen.getByText('Show Built-in')).toBeInTheDocument();
      });
    });
  });

  // ==========================================================================
  // CREATE AGENT TESTS
  // ==========================================================================

  describe('Create Agent', () => {
    it('calls createAgentTemplate when form submitted', async () => {
      const user = userEvent.setup();
      vi.mocked(window.goodvibes.getAgentTemplates).mockResolvedValue([]);
      vi.mocked(window.goodvibes.createAgentTemplate).mockResolvedValue({
        id: '3',
        name: 'new-agent',
      } as AgentTemplate);

      await renderAgentsView();

      await act(async () => {
        fireEvent.click(screen.getByText('New Agent'));
      });

      await waitFor(() => {
        expect(screen.getByPlaceholderText('my-agent')).toBeInTheDocument();
      });

      await user.type(screen.getByPlaceholderText('my-agent'), 'new-agent');
      await user.type(screen.getByPlaceholderText('What this agent does...'), 'A new test agent');

      const createButton = screen.getByRole('button', { name: /Create Agent/i });
      await act(async () => {
        fireEvent.click(createButton);
      });

      await waitFor(() => {
        expect(vi.mocked(window.goodvibes.createAgentTemplate)).toHaveBeenCalledWith(
          expect.objectContaining({
            name: 'new-agent',
            description: 'A new test agent',
          })
        );
      });
    });

    it('closes form after successful creation', async () => {
      const user = userEvent.setup();
      vi.mocked(window.goodvibes.getAgentTemplates).mockResolvedValue([]);
      vi.mocked(window.goodvibes.createAgentTemplate).mockResolvedValue({
        id: '3',
        name: 'new-agent',
      } as AgentTemplate);

      await renderAgentsView();

      await act(async () => {
        fireEvent.click(screen.getByText('New Agent'));
      });

      await user.type(screen.getByPlaceholderText('my-agent'), 'new-agent');

      const createButton = screen.getByRole('button', { name: /Create Agent/i });
      await act(async () => {
        fireEvent.click(createButton);
      });

      await waitFor(() => {
        expect(screen.queryByPlaceholderText('my-agent')).not.toBeInTheDocument();
      });
    });
  });

  // ==========================================================================
  // DELETE AGENT TESTS
  // ==========================================================================

  describe('Delete Agent', () => {
    it('shows confirmation dialog when Delete clicked', async () => {
      vi.mocked(window.goodvibes.getAgentTemplates).mockResolvedValue([mockAgentTemplate]);

      await renderAgentsView();

      await waitFor(() => {
        expect(screen.getByText('test-agent')).toBeInTheDocument();
      });

      // Find the Delete button in the card (not the confirmation dialog)
      const deleteButtons = screen.getAllByRole('button', { name: /delete/i });
      const deleteButton = deleteButtons[0];
      await act(async () => {
        fireEvent.click(deleteButton);
      });

      await waitFor(() => {
        expect(screen.getByText('Delete Agent Template')).toBeInTheDocument();
      });
    });

    it('calls deleteAgentTemplate on confirmation', async () => {
      vi.mocked(window.goodvibes.getAgentTemplates).mockResolvedValue([mockAgentTemplate]);
      vi.mocked(window.goodvibes.deleteAgentTemplate).mockResolvedValue(true);

      await renderAgentsView();

      await waitFor(() => {
        expect(screen.getByText('test-agent')).toBeInTheDocument();
      });

      // Find the Delete button in the card (first one)
      const deleteButtons = screen.getAllByRole('button', { name: /delete/i });
      const deleteButton = deleteButtons[0];
      await act(async () => {
        fireEvent.click(deleteButton);
      });

      await waitFor(() => {
        expect(screen.getByText('Delete Agent Template')).toBeInTheDocument();
      });

      // Find the Delete button in the confirmation dialog (inside the alertdialog)
      const dialog = screen.getByRole('alertdialog');
      const confirmButton = within(dialog).getByRole('button', { name: /delete/i });

      await act(async () => {
        fireEvent.click(confirmButton);
      });

      await waitFor(() => {
        expect(vi.mocked(window.goodvibes.deleteAgentTemplate)).toHaveBeenCalledWith('1');
      });
    });

    it('does not delete when Cancel clicked in confirmation', async () => {
      vi.mocked(window.goodvibes.getAgentTemplates).mockResolvedValue([mockAgentTemplate]);

      await renderAgentsView();

      await waitFor(() => {
        expect(screen.getByText('test-agent')).toBeInTheDocument();
      });

      // Find the Delete button in the card
      const deleteButtons = screen.getAllByRole('button', { name: /delete/i });
      const deleteButton = deleteButtons[0];
      await act(async () => {
        fireEvent.click(deleteButton);
      });

      await waitFor(() => {
        expect(screen.getByText('Delete Agent Template')).toBeInTheDocument();
      });

      await act(async () => {
        fireEvent.click(screen.getByText('Cancel'));
      });

      expect(vi.mocked(window.goodvibes.deleteAgentTemplate)).not.toHaveBeenCalled();
    });
  });

  // ==========================================================================
  // ERROR HANDLING TESTS
  // ==========================================================================

  describe('Error Handling', () => {
    it('handles agent loading failure gracefully', async () => {
      vi.mocked(window.goodvibes.getAgentTemplates).mockRejectedValue(new Error('Network error'));

      await renderAgentsView();

      // Should render without crashing - show the empty state with built-in agents
      await waitFor(() => {
        expect(screen.getByText('Agents')).toBeInTheDocument();
      });
    });

    it('handles agent creation failure gracefully', async () => {
      const user = userEvent.setup();
      vi.mocked(window.goodvibes.getAgentTemplates).mockResolvedValue([]);
      vi.mocked(window.goodvibes.createAgentTemplate).mockRejectedValue(new Error('Creation failed'));

      await renderAgentsView();

      await act(async () => {
        fireEvent.click(screen.getByText('New Agent'));
      });

      await user.type(screen.getByPlaceholderText('my-agent'), 'failing-agent');

      const createButton = screen.getByRole('button', { name: /Create Agent/i });
      await act(async () => {
        fireEvent.click(createButton);
      });

      // Form should remain open on failure
      await waitFor(() => {
        expect(screen.getByDisplayValue('failing-agent')).toBeInTheDocument();
      });
    });

    it('handles agent deletion failure gracefully', async () => {
      vi.mocked(window.goodvibes.getAgentTemplates).mockResolvedValue([mockAgentTemplate]);
      vi.mocked(window.goodvibes.deleteAgentTemplate).mockRejectedValue(new Error('Deletion failed'));

      await renderAgentsView();

      await waitFor(() => {
        expect(screen.getByText('test-agent')).toBeInTheDocument();
      });

      // Find the Delete button in the card
      const deleteButtons = screen.getAllByRole('button', { name: /delete/i });
      const deleteButton = deleteButtons[0];
      await act(async () => {
        fireEvent.click(deleteButton);
      });

      await waitFor(() => {
        expect(screen.getByText('Delete Agent Template')).toBeInTheDocument();
      });

      // Find the Delete button in the confirmation dialog (inside the alertdialog)
      const dialog = screen.getByRole('alertdialog');
      const confirmButton = within(dialog).getByRole('button', { name: /delete/i });

      await act(async () => {
        fireEvent.click(confirmButton);
      });

      // Should handle error without crashing
      await waitFor(() => {
        expect(vi.mocked(window.goodvibes.deleteAgentTemplate)).toHaveBeenCalled();
      });
    });
  });
});

// ============================================================================
// AGENT CARD TESTS
// ============================================================================

describe('AgentCard', () => {
  const defaultProps = {
    agent: mockAgentTemplate as AgentCardAgent,
    onDelete: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders agent name', () => {
    render(<AgentCard {...defaultProps} />);
    expect(screen.getByText('test-agent')).toBeInTheDocument();
  });

  it('renders agent description', () => {
    render(<AgentCard {...defaultProps} />);
    expect(screen.getByText('A test agent for unit testing')).toBeInTheDocument();
  });

  it('shows user scope badge for global agents', () => {
    render(<AgentCard {...defaultProps} />);
    expect(screen.getByText('user')).toBeInTheDocument();
  });

  it('shows project scope badge for project-specific agents', () => {
    const projectAgent = { ...mockProjectAgent } as AgentCardAgent;
    render(<AgentCard {...defaultProps} agent={projectAgent} />);
    expect(screen.getByText('project')).toBeInTheDocument();
  });

  it('shows model badge when model is set', () => {
    render(<AgentCard {...defaultProps} />);
    expect(screen.getByText('sonnet-4')).toBeInTheDocument();
  });

  it('shows Built-in badge for built-in agents', () => {
    render(<AgentCard {...defaultProps} agent={mockBuiltInAgent} onInstall={vi.fn()} />);
    expect(screen.getByText('Built-in')).toBeInTheDocument();
  });

  it('shows Delete button for custom agents', () => {
    render(<AgentCard {...defaultProps} />);
    expect(screen.getByRole('button', { name: /delete/i })).toBeInTheDocument();
  });

  it('shows Install button for built-in agents', () => {
    render(<AgentCard {...defaultProps} agent={mockBuiltInAgent} onInstall={vi.fn()} />);
    expect(screen.getByText('Install')).toBeInTheDocument();
  });

  it('calls onInstall when Install button clicked', async () => {
    const onInstall = vi.fn();
    render(<AgentCard {...defaultProps} agent={mockBuiltInAgent} onInstall={onInstall} />);

    await act(async () => {
      fireEvent.click(screen.getByText('Install'));
    });

    expect(onInstall).toHaveBeenCalledTimes(1);
  });

  it('calls onDelete when Delete button clicked for custom agents', async () => {
    const onDelete = vi.fn();
    render(<AgentCard {...defaultProps} onDelete={onDelete} />);

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /delete/i }));
    });

    expect(onDelete).toHaveBeenCalledTimes(1);
  });

  it('does not show Delete button for built-in agents', () => {
    render(<AgentCard {...defaultProps} agent={mockBuiltInAgent} onInstall={vi.fn()} />);
    expect(screen.queryByRole('button', { name: /delete/i })).not.toBeInTheDocument();
  });

  it('expands to show details when clicked', async () => {
    render(<AgentCard {...defaultProps} />);

    // Click to expand
    const expandArea = screen.getByText('test-agent').closest('div[class*="cursor-pointer"]');
    await act(async () => {
      fireEvent.click(expandArea!);
    });

    await waitFor(() => {
      expect(screen.getByText('Initial Prompt')).toBeInTheDocument();
      expect(screen.getByText('You are a helpful test agent.')).toBeInTheDocument();
    });
  });

  it('shows CLAUDE.md content when expanded', async () => {
    render(<AgentCard {...defaultProps} />);

    const expandArea = screen.getByText('test-agent').closest('div[class*="cursor-pointer"]');
    await act(async () => {
      fireEvent.click(expandArea!);
    });

    await waitFor(() => {
      expect(screen.getByText('CLAUDE.md Content')).toBeInTheDocument();
      expect(screen.getByText('# Test CLAUDE.md content')).toBeInTheDocument();
    });
  });

  it('shows allowed tools when expanded', async () => {
    render(<AgentCard {...defaultProps} />);

    const expandArea = screen.getByText('test-agent').closest('div[class*="cursor-pointer"]');
    await act(async () => {
      fireEvent.click(expandArea!);
    });

    await waitFor(() => {
      expect(screen.getByText('Allowed Tools:')).toBeInTheDocument();
      expect(screen.getByText('Read')).toBeInTheDocument();
      expect(screen.getByText('Write')).toBeInTheDocument();
      expect(screen.getByText('Edit')).toBeInTheDocument();
    });
  });

  it('shows CLI flags when expanded', async () => {
    render(<AgentCard {...defaultProps} />);

    const expandArea = screen.getByText('test-agent').closest('div[class*="cursor-pointer"]');
    await act(async () => {
      fireEvent.click(expandArea!);
    });

    await waitFor(() => {
      expect(screen.getByText('CLI Flags:')).toBeInTheDocument();
      expect(screen.getByText('--verbose')).toBeInTheDocument();
    });
  });

  it('shows creation date for custom agents', () => {
    render(<AgentCard {...defaultProps} />);
    expect(screen.getByText(/Created:/)).toBeInTheDocument();
  });
});

// ============================================================================
// AGENT FILTERS TESTS
// ============================================================================

describe('AgentFilters', () => {
  const defaultProps = {
    searchQuery: '',
    onSearchChange: vi.fn(),
    showBuiltIn: true,
    onToggleBuiltIn: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders search input with correct placeholder', () => {
    render(<AgentFilters {...defaultProps} />);
    expect(screen.getByPlaceholderText('Search agents...')).toBeInTheDocument();
  });

  it('displays current search query value', () => {
    render(<AgentFilters {...defaultProps} searchQuery="test-query" />);
    expect(screen.getByDisplayValue('test-query')).toBeInTheDocument();
  });

  it('calls onSearchChange when input changes', async () => {
    const onSearchChange = vi.fn();
    render(<AgentFilters {...defaultProps} onSearchChange={onSearchChange} />);

    const searchInput = screen.getByPlaceholderText('Search agents...');
    await act(async () => {
      fireEvent.change(searchInput, { target: { value: 'new search' } });
    });

    expect(onSearchChange).toHaveBeenCalledWith('new search');
  });

  it('shows Hide Built-in when showBuiltIn is true', () => {
    render(<AgentFilters {...defaultProps} showBuiltIn={true} />);
    expect(screen.getByText('Hide Built-in')).toBeInTheDocument();
  });

  it('shows Show Built-in when showBuiltIn is false', () => {
    render(<AgentFilters {...defaultProps} showBuiltIn={false} />);
    expect(screen.getByText('Show Built-in')).toBeInTheDocument();
  });

  it('calls onToggleBuiltIn when toggle button clicked', async () => {
    const onToggleBuiltIn = vi.fn();
    render(<AgentFilters {...defaultProps} onToggleBuiltIn={onToggleBuiltIn} />);

    await act(async () => {
      fireEvent.click(screen.getByText('Hide Built-in'));
    });

    expect(onToggleBuiltIn).toHaveBeenCalledTimes(1);
  });
});

// ============================================================================
// AGENT FORM TESTS
// ============================================================================

describe('AgentForm', () => {
  const defaultProps = {
    onSave: vi.fn(),
    onCancel: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(window.goodvibes.projectGetAll).mockResolvedValue([]);
  });

  it('renders form with all fields', async () => {
    await act(async () => {
      render(<AgentForm {...defaultProps} />);
    });

    // Check for labels by text content
    expect(screen.getByText('Agent Name')).toBeInTheDocument();
    expect(screen.getByText('Scope')).toBeInTheDocument();
    expect(screen.getByText('Model')).toBeInTheDocument();
    expect(screen.getByText('Permission Mode')).toBeInTheDocument();
    expect(screen.getByText('Description')).toBeInTheDocument();
    expect(screen.getByText(/Initial Prompt/)).toBeInTheDocument();
    expect(screen.getByText(/CLAUDE.md Content/)).toBeInTheDocument();
    expect(screen.getByText(/Allowed Tools/)).toBeInTheDocument();
    expect(screen.getByText(/CLI Flags/)).toBeInTheDocument();

    // Check for inputs by placeholder
    expect(screen.getByPlaceholderText('my-agent')).toBeInTheDocument();
    expect(screen.getByPlaceholderText('What this agent does...')).toBeInTheDocument();
  });

  it('shows Create Agent button for new agent', async () => {
    await act(async () => {
      render(<AgentForm {...defaultProps} />);
    });

    expect(screen.getByRole('button', { name: /Create Agent/i })).toBeInTheDocument();
  });

  it('shows Update Agent button when editing', async () => {
    await act(async () => {
      render(<AgentForm {...defaultProps} agent={mockAgentTemplate} />);
    });

    expect(screen.getByRole('button', { name: /Update Agent/i })).toBeInTheDocument();
  });

  it('populates fields when editing existing agent', async () => {
    await act(async () => {
      render(<AgentForm {...defaultProps} agent={mockAgentTemplate} />);
    });

    expect(screen.getByDisplayValue('test-agent')).toBeInTheDocument();
    expect(screen.getByDisplayValue('A test agent for unit testing')).toBeInTheDocument();
    expect(screen.getByDisplayValue('You are a helpful test agent.')).toBeInTheDocument();
  });

  it('requires agent name (has required attribute)', async () => {
    await act(async () => {
      render(<AgentForm {...defaultProps} />);
    });

    const nameInput = screen.getByPlaceholderText('my-agent');
    expect(nameInput).toBeRequired();
  });

  it('validates name pattern (lowercase, numbers, hyphens)', async () => {
    await act(async () => {
      render(<AgentForm {...defaultProps} />);
    });

    const nameInput = screen.getByPlaceholderText('my-agent');
    expect(nameInput).toHaveAttribute('pattern', '[a-z0-9-]+');
  });

  it('calls onSave with form data when submitted', async () => {
    const user = userEvent.setup();
    const onSave = vi.fn();

    await act(async () => {
      render(<AgentForm {...defaultProps} onSave={onSave} />);
    });

    await user.type(screen.getByPlaceholderText('my-agent'), 'my-new-agent');
    await user.type(screen.getByPlaceholderText('What this agent does...'), 'Test description');

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /Create Agent/i }));
    });

    await waitFor(() => {
      expect(onSave).toHaveBeenCalledWith(
        expect.objectContaining({
          name: 'my-new-agent',
          description: 'Test description',
        }),
        null
      );
    });
  });

  it('calls onCancel when Cancel button clicked', async () => {
    const onCancel = vi.fn();
    await act(async () => {
      render(<AgentForm {...defaultProps} onCancel={onCancel} />);
    });

    await act(async () => {
      fireEvent.click(screen.getByText('Cancel'));
    });

    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it('parses allowed tools from comma-separated string', async () => {
    const user = userEvent.setup();
    const onSave = vi.fn();

    await act(async () => {
      render(<AgentForm {...defaultProps} onSave={onSave} />);
    });

    await user.type(screen.getByPlaceholderText('my-agent'), 'tool-agent');
    await user.type(screen.getByPlaceholderText('Bash, Read, Edit, Grep, Glob'), 'Read, Write, Bash');

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /Create Agent/i }));
    });

    await waitFor(() => {
      expect(onSave).toHaveBeenCalledWith(
        expect.objectContaining({
          allowedTools: ['Read', 'Write', 'Bash'],
        }),
        null
      );
    });
  });

  it('parses CLI flags from comma-separated string', async () => {
    const user = userEvent.setup();
    const onSave = vi.fn();

    await act(async () => {
      render(<AgentForm {...defaultProps} onSave={onSave} />);
    });

    await user.type(screen.getByPlaceholderText('my-agent'), 'flag-agent');
    await user.type(screen.getByPlaceholderText('--verbose, --no-cache'), '--verbose, --no-cache');

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /Create Agent/i }));
    });

    await waitFor(() => {
      expect(onSave).toHaveBeenCalledWith(
        expect.objectContaining({
          flags: ['--verbose', '--no-cache'],
        }),
        null
      );
    });
  });

  it('shows model selection options', async () => {
    await act(async () => {
      render(<AgentForm {...defaultProps} />);
    });

    // Find all selects and check the model options
    const selects = screen.getAllByRole('combobox');
    const modelSelect = selects.find(select =>
      select.querySelector('option[value="claude-sonnet-4-20250514"]')
    );
    expect(modelSelect).toBeTruthy();
    expect(within(modelSelect!).getByText('Default')).toBeInTheDocument();
    expect(within(modelSelect!).getByText('Claude Sonnet 4')).toBeInTheDocument();
  });

  it('shows permission mode options', async () => {
    await act(async () => {
      render(<AgentForm {...defaultProps} />);
    });

    // Find the permission mode select by its options
    const selects = screen.getAllByRole('combobox');
    const permSelect = selects.find(select =>
      select.querySelector('option[value="plan"]')
    );
    expect(permSelect).toBeTruthy();
    expect(within(permSelect!).getByText('Plan Mode')).toBeInTheDocument();
    expect(within(permSelect!).getByText('Bypass Permissions')).toBeInTheDocument();
  });
});

// ============================================================================
// AGENT LIST TESTS
// ============================================================================

describe('AgentList', () => {
  const defaultProps = {
    customAgents: [] as AgentTemplate[],
    builtInAgents: [] as (BuiltInAgent & { isBuiltIn: true })[],
    showBuiltIn: true,
    onInstallAgent: vi.fn(),
    onDeleteAgent: vi.fn(),
    onCreateNew: vi.fn(),
    searchQuery: '',
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders custom agents section when agents exist', () => {
    render(<AgentList {...defaultProps} customAgents={mockAgents} />);
    expect(screen.getByText('Custom Agents (2)')).toBeInTheDocument();
    expect(screen.getByText('test-agent')).toBeInTheDocument();
    expect(screen.getByText('project-agent')).toBeInTheDocument();
  });

  it('renders built-in agents section when showBuiltIn is true', () => {
    render(
      <AgentList
        {...defaultProps}
        builtInAgents={[mockBuiltInAgent]}
        showBuiltIn={true}
      />
    );
    expect(screen.getByText('Built-in Agents (1)')).toBeInTheDocument();
    expect(screen.getByText('explore')).toBeInTheDocument();
  });

  it('hides built-in agents when showBuiltIn is false', () => {
    render(
      <AgentList
        {...defaultProps}
        builtInAgents={[mockBuiltInAgent]}
        showBuiltIn={false}
      />
    );
    expect(screen.queryByText('Built-in Agents (1)')).not.toBeInTheDocument();
    expect(screen.queryByText('explore')).not.toBeInTheDocument();
  });

  it('shows empty state when no agents and built-in hidden', () => {
    render(
      <AgentList
        {...defaultProps}
        customAgents={[]}
        builtInAgents={[]}
        showBuiltIn={false}
      />
    );
    expect(screen.getByText('No custom agents yet')).toBeInTheDocument();
  });

  it('shows search no results message when search active', () => {
    render(
      <AgentList
        {...defaultProps}
        customAgents={[]}
        builtInAgents={[]}
        showBuiltIn={false}
        searchQuery="nonexistent"
      />
    );
    expect(screen.getByText('No agents match your search')).toBeInTheDocument();
  });

  it('shows Create your first agent button in empty state', () => {
    render(
      <AgentList
        {...defaultProps}
        customAgents={[]}
        builtInAgents={[]}
        showBuiltIn={false}
      />
    );
    expect(screen.getByText('Create your first agent')).toBeInTheDocument();
  });

  it('calls onCreateNew when Create button clicked', async () => {
    const onCreateNew = vi.fn();
    render(
      <AgentList
        {...defaultProps}
        customAgents={[]}
        builtInAgents={[]}
        showBuiltIn={false}
        onCreateNew={onCreateNew}
      />
    );

    await act(async () => {
      fireEvent.click(screen.getByText('Create your first agent'));
    });

    expect(onCreateNew).toHaveBeenCalledTimes(1);
  });

  it('calls onDeleteAgent with agent id when Delete clicked', async () => {
    const onDeleteAgent = vi.fn();
    render(<AgentList {...defaultProps} customAgents={[mockAgentTemplate]} onDeleteAgent={onDeleteAgent} />);

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /delete/i }));
    });

    expect(onDeleteAgent).toHaveBeenCalledWith('1');
  });
});

// ============================================================================
// INSTALL AGENT MODAL TESTS
// ============================================================================

describe('InstallAgentModal', () => {
  const mockAgent: BuiltInAgent = {
    name: 'explore',
    description: 'Quickly explore and understand unfamiliar codebases',
    cwd: null,
    initialPrompt: 'You are an exploration agent.',
    claudeMdContent: null,
    flags: [],
    model: null,
    permissionMode: 'default',
    allowedTools: ['Read', 'Grep', 'Glob', 'LSP'],
    deniedTools: ['Edit', 'Write', 'Bash'],
  };

  const defaultProps = {
    agent: mockAgent,
    isOpen: true,
    onClose: vi.fn(),
    onInstall: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(window.goodvibes.projectGetAll).mockResolvedValue([]);
  });

  it('renders modal when isOpen is true', async () => {
    await act(async () => {
      render(<InstallAgentModal {...defaultProps} />);
    });

    expect(screen.getByRole('dialog')).toBeInTheDocument();
    // "Install Agent" appears in header and potentially button
    const installAgentElements = screen.getAllByText('Install Agent');
    expect(installAgentElements.length).toBeGreaterThanOrEqual(1);
  });

  it('does not render when isOpen is false', () => {
    render(<InstallAgentModal {...defaultProps} isOpen={false} />);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('displays agent name in the modal', async () => {
    await act(async () => {
      render(<InstallAgentModal {...defaultProps} />);
    });

    // The agent name appears in multiple places - header and preview
    const exploreElements = screen.getAllByText('explore');
    expect(exploreElements.length).toBeGreaterThanOrEqual(1);
  });

  it('displays agent description', async () => {
    await act(async () => {
      render(<InstallAgentModal {...defaultProps} />);
    });

    expect(screen.getByText('Quickly explore and understand unfamiliar codebases')).toBeInTheDocument();
  });

  it('shows User (Global) and Project scope options', async () => {
    await act(async () => {
      render(<InstallAgentModal {...defaultProps} />);
    });

    expect(screen.getByText('User (Global)')).toBeInTheDocument();
    expect(screen.getByText('Project')).toBeInTheDocument();
  });

  it('selects User scope by default', async () => {
    await act(async () => {
      render(<InstallAgentModal {...defaultProps} />);
    });

    const userButton = screen.getByText('User (Global)').closest('button');
    expect(userButton).toHaveClass('border-accent-purple');
  });

  it('calls onClose when Cancel clicked', async () => {
    const onClose = vi.fn();
    await act(async () => {
      render(<InstallAgentModal {...defaultProps} onClose={onClose} />);
    });

    await act(async () => {
      fireEvent.click(screen.getByText('Cancel'));
    });

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('calls onClose when X button clicked', async () => {
    const onClose = vi.fn();
    await act(async () => {
      render(<InstallAgentModal {...defaultProps} onClose={onClose} />);
    });

    // The X button is the first button in the header section
    const dialog = screen.getByRole('dialog');
    const headerButtons = dialog.querySelectorAll('button');
    const closeButton = Array.from(headerButtons).find(btn =>
      btn.querySelector('svg.lucide-x')
    );

    await act(async () => {
      fireEvent.click(closeButton!);
    });

    expect(onClose).toHaveBeenCalled();
  });

  it('calls onClose when backdrop clicked', async () => {
    const onClose = vi.fn();
    await act(async () => {
      render(<InstallAgentModal {...defaultProps} onClose={onClose} />);
    });

    const backdrop = screen.getByRole('dialog').parentElement;
    await act(async () => {
      fireEvent.click(backdrop!);
    });

    expect(onClose).toHaveBeenCalled();
  });

  it('calls onInstall with user scope when Install clicked', async () => {
    const onInstall = vi.fn();
    const onClose = vi.fn();
    await act(async () => {
      render(<InstallAgentModal {...defaultProps} onInstall={onInstall} onClose={onClose} />);
    });

    // Find the Install Agent button (not the Install button in preview)
    const installButton = screen.getByRole('button', { name: /Install Agent/i });

    await act(async () => {
      fireEvent.click(installButton);
    });

    expect(onInstall).toHaveBeenCalledWith(mockAgent, 'user', null);
    expect(onClose).toHaveBeenCalled();
  });

  it('shows project selector when Project scope selected', async () => {
    vi.mocked(window.goodvibes.projectGetAll).mockResolvedValue([
      { id: 1, name: 'My Project', path: '/my/project', description: null, lastOpened: '', createdAt: '', updatedAt: '' },
    ]);

    await act(async () => {
      render(<InstallAgentModal {...defaultProps} />);
    });

    // Click the Project scope button
    const projectButton = screen.getByText('Project').closest('button');
    await act(async () => {
      fireEvent.click(projectButton!);
    });

    // The project selector should appear
    await waitFor(() => {
      expect(screen.getByText('Select a project...')).toBeInTheDocument();
    });
  });

  it('shows allowed tools in preview', async () => {
    await act(async () => {
      render(<InstallAgentModal {...defaultProps} />);
    });

    expect(screen.getByText('Allowed Tools')).toBeInTheDocument();
    expect(screen.getByText('Read')).toBeInTheDocument();
    expect(screen.getByText('Grep')).toBeInTheDocument();
  });

  it('shows denied tools in preview', async () => {
    await act(async () => {
      render(<InstallAgentModal {...defaultProps} />);
    });

    expect(screen.getByText('Denied Tools')).toBeInTheDocument();
    expect(screen.getByText('Bash')).toBeInTheDocument();
  });

  it('shows permission mode in preview', async () => {
    await act(async () => {
      render(<InstallAgentModal {...defaultProps} />);
    });

    expect(screen.getByText('Permission Mode')).toBeInTheDocument();
    // Default appears multiple times (model and permission mode)
    const defaultTexts = screen.getAllByText('Default');
    expect(defaultTexts.length).toBeGreaterThanOrEqual(1);
  });

  it('closes on Escape key press', async () => {
    const onClose = vi.fn();
    await act(async () => {
      render(<InstallAgentModal {...defaultProps} onClose={onClose} />);
    });

    await act(async () => {
      fireEvent.keyDown(document, { key: 'Escape' });
    });

    expect(onClose).toHaveBeenCalled();
  });
});

// ============================================================================
// HOOKS TESTS
// ============================================================================

describe('useAgents hook', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useToastStore.setState({ toasts: [] });
  });

  it('loads agents on mount', async () => {
    vi.mocked(window.goodvibes.getAgentTemplates).mockResolvedValue(mockAgents);

    const { result } = renderHook(() => useAgents());

    expect(result.current.loading).toBe(true);

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    expect(result.current.agents).toEqual(mockAgents);
    expect(vi.mocked(window.goodvibes.getAgentTemplates)).toHaveBeenCalledTimes(1);
  });

  it('handles loading error gracefully', async () => {
    vi.mocked(window.goodvibes.getAgentTemplates).mockRejectedValue(new Error('Network error'));

    const { result } = renderHook(() => useAgents());

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    expect(result.current.agents).toEqual([]);
  });

  it('saveAgent creates new agent', async () => {
    vi.mocked(window.goodvibes.getAgentTemplates).mockResolvedValue([]);
    vi.mocked(window.goodvibes.createAgentTemplate).mockResolvedValue({
      id: '1',
      name: 'new-agent',
    } as AgentTemplate);

    const { result } = renderHook(() => useAgents());

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    let saveResult: { success: boolean };
    await act(async () => {
      saveResult = await result.current.saveAgent({ name: 'new-agent' }, null);
    });

    expect(saveResult!.success).toBe(true);
    expect(vi.mocked(window.goodvibes.createAgentTemplate)).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'new-agent' })
    );
  });

  it('saveAgent updates existing agent', async () => {
    vi.mocked(window.goodvibes.getAgentTemplates).mockResolvedValue([mockAgentTemplate]);
    vi.mocked(window.goodvibes.updateAgentTemplate).mockResolvedValue(true);

    const { result } = renderHook(() => useAgents());

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    let saveResult: { success: boolean };
    await act(async () => {
      saveResult = await result.current.saveAgent({ id: '1', name: 'updated-agent' }, null);
    });

    expect(saveResult!.success).toBe(true);
    expect(vi.mocked(window.goodvibes.updateAgentTemplate)).toHaveBeenCalledWith(
      '1',
      expect.objectContaining({ name: 'updated-agent' })
    );
  });

  it('deleteAgent removes agent', async () => {
    vi.mocked(window.goodvibes.getAgentTemplates).mockResolvedValue([mockAgentTemplate]);
    vi.mocked(window.goodvibes.deleteAgentTemplate).mockResolvedValue(true);

    const { result } = renderHook(() => useAgents());

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    let deleteResult: { success: boolean };
    await act(async () => {
      deleteResult = await result.current.deleteAgent('1');
    });

    expect(deleteResult!.success).toBe(true);
    expect(vi.mocked(window.goodvibes.deleteAgentTemplate)).toHaveBeenCalledWith('1');
  });

  it('copyToClipboard copies content', async () => {
    const mockWriteText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText: mockWriteText },
      writable: true,
      configurable: true,
    });

    vi.mocked(window.goodvibes.getAgentTemplates).mockResolvedValue([]);

    const { result } = renderHook(() => useAgents());

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    let copyResult: { success: boolean };
    await act(async () => {
      copyResult = await result.current.copyToClipboard('test content');
    });

    expect(copyResult!.success).toBe(true);
    expect(mockWriteText).toHaveBeenCalledWith('test content');
  });
});

describe('useAgentFilters hook', () => {
  it('returns initial state correctly', () => {
    const { result } = renderHook(() => useAgentFilters(mockAgents, BUILT_IN_AGENTS));

    expect(result.current.searchQuery).toBe('');
    expect(result.current.showBuiltIn).toBe(true);
    expect(result.current.filteredAgents).toEqual(mockAgents);
    expect(result.current.filteredBuiltIn).toEqual(BUILT_IN_AGENTS);
  });

  it('filters agents by search query', () => {
    const { result } = renderHook(() => useAgentFilters(mockAgents, BUILT_IN_AGENTS));

    act(() => {
      result.current.setSearchQuery('project');
    });

    expect(result.current.filteredAgents).toHaveLength(1);
    expect(result.current.filteredAgents[0]?.name).toBe('project-agent');
  });

  it('filters built-in agents by search query', () => {
    const { result } = renderHook(() => useAgentFilters(mockAgents, BUILT_IN_AGENTS));

    act(() => {
      result.current.setSearchQuery('explore');
    });

    expect(result.current.filteredBuiltIn).toHaveLength(1);
    expect(result.current.filteredBuiltIn[0]?.name).toBe('explore');
  });

  it('filters by description text', () => {
    const { result } = renderHook(() => useAgentFilters(mockAgents, BUILT_IN_AGENTS));

    act(() => {
      result.current.setSearchQuery('unit testing');
    });

    expect(result.current.filteredAgents).toHaveLength(1);
    expect(result.current.filteredAgents[0]?.name).toBe('test-agent');
  });

  it('toggles showBuiltIn state', () => {
    const { result } = renderHook(() => useAgentFilters(mockAgents, BUILT_IN_AGENTS));

    expect(result.current.showBuiltIn).toBe(true);

    act(() => {
      result.current.setShowBuiltIn(false);
    });

    expect(result.current.showBuiltIn).toBe(false);
  });

  it('case-insensitive search', () => {
    const { result } = renderHook(() => useAgentFilters(mockAgents, BUILT_IN_AGENTS));

    act(() => {
      result.current.setSearchQuery('TEST');
    });

    expect(result.current.filteredAgents).toHaveLength(1);
    expect(result.current.filteredAgents[0]?.name).toBe('test-agent');
  });
});
