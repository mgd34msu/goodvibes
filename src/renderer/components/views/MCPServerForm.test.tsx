// ============================================================================
// MCP SERVER FORM COMPONENT TESTS
// ============================================================================

import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MCPServerForm } from './MCPServerForm';
import type { MCPServer } from './MCPServerCard';

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
  env: { API_KEY: 'secret', OTHER_KEY: 'value' },
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

describe('MCPServerForm', () => {
  const mockOnSave = vi.fn();
  const mockOnCancel = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
  });

  const renderForm = (server?: MCPServer) => {
    return render(
      <MCPServerForm
        server={server}
        onSave={mockOnSave}
        onCancel={mockOnCancel}
      />
    );
  };

  // ==========================================================================
  // RENDERING TESTS
  // ==========================================================================

  describe('Rendering', () => {
    it('renders Name input field', () => {
      renderForm();
      expect(screen.getByLabelText('Name')).toBeInTheDocument();
    });

    it('renders Transport select field', () => {
      renderForm();
      expect(screen.getByLabelText('Transport')).toBeInTheDocument();
    });

    it('renders Description input field', () => {
      renderForm();
      expect(screen.getByLabelText('Description')).toBeInTheDocument();
    });

    it('renders Command field for STDIO transport', () => {
      renderForm();
      expect(screen.getByLabelText('Command')).toBeInTheDocument();
    });

    it('renders Arguments field for STDIO transport', () => {
      renderForm();
      expect(screen.getByLabelText(/Arguments/)).toBeInTheDocument();
    });

    it('renders Environment Variables textarea', () => {
      renderForm();
      expect(screen.getByLabelText(/Environment Variables/)).toBeInTheDocument();
    });

    it('renders Scope select field', () => {
      renderForm();
      expect(screen.getByLabelText('Scope')).toBeInTheDocument();
    });

    it('renders Cancel button', () => {
      renderForm();
      expect(screen.getByText('Cancel')).toBeInTheDocument();
    });

    it('renders Add Server button when creating new server', () => {
      renderForm();
      expect(screen.getByText('Add Server')).toBeInTheDocument();
    });

    it('renders Update Server button when editing server', () => {
      renderForm(createMockServer());
      expect(screen.getByText('Update Server')).toBeInTheDocument();
    });
  });

  // ==========================================================================
  // TRANSPORT SWITCHING TESTS
  // ==========================================================================

  describe('Transport Switching', () => {
    it('shows Command field when transport is STDIO', () => {
      renderForm();
      expect(screen.getByLabelText('Command')).toBeInTheDocument();
      expect(screen.queryByLabelText('URL')).not.toBeInTheDocument();
    });

    it('shows URL field when transport is HTTP', async () => {
      renderForm();

      fireEvent.change(screen.getByLabelText('Transport'), { target: { value: 'http' } });

      await waitFor(() => {
        expect(screen.getByLabelText('URL')).toBeInTheDocument();
        expect(screen.queryByLabelText('Command')).not.toBeInTheDocument();
      });
    });

    it('hides Arguments field when transport is HTTP', async () => {
      renderForm();

      fireEvent.change(screen.getByLabelText('Transport'), { target: { value: 'http' } });

      await waitFor(() => {
        expect(screen.queryByLabelText(/Arguments/)).not.toBeInTheDocument();
      });
    });
  });

  // ==========================================================================
  // PRE-FILLED FORM TESTS (EDIT MODE)
  // ==========================================================================

  describe('Edit Mode Pre-filled Values', () => {
    it('pre-fills name from existing server', () => {
      renderForm(createMockServer({ name: 'My Server' }));
      expect(screen.getByDisplayValue('My Server')).toBeInTheDocument();
    });

    it('pre-fills description from existing server', () => {
      renderForm(createMockServer({ description: 'Server description' }));
      expect(screen.getByDisplayValue('Server description')).toBeInTheDocument();
    });

    it('pre-fills transport from existing server', () => {
      renderForm(createMockServer({ transport: 'http' }));
      expect(screen.getByDisplayValue('HTTP')).toBeInTheDocument();
    });

    it('pre-fills command from existing server', () => {
      renderForm(createMockServer({ command: 'npx my-server' }));
      expect(screen.getByDisplayValue('npx my-server')).toBeInTheDocument();
    });

    it('pre-fills URL from existing HTTP server', () => {
      renderForm(createMockServer({
        transport: 'http',
        url: 'http://localhost:3000',
        command: null,
      }));
      expect(screen.getByDisplayValue('http://localhost:3000')).toBeInTheDocument();
    });

    it('pre-fills arguments from existing server', () => {
      renderForm(createMockServer({ args: ['--arg1', '--arg2'] }));
      expect(screen.getByDisplayValue('--arg1 --arg2')).toBeInTheDocument();
    });

    it('pre-fills environment variables from existing server', () => {
      renderForm(createMockServer({
        env: { KEY1: 'value1', KEY2: 'value2' },
      }));
      const textarea = screen.getByLabelText(/Environment Variables/);
      expect(textarea).toHaveValue('KEY1=value1\nKEY2=value2');
    });

    it('pre-fills scope from existing server', () => {
      renderForm(createMockServer({ scope: 'project' }));
      expect(screen.getByDisplayValue('Project')).toBeInTheDocument();
    });
  });

  // ==========================================================================
  // FORM SUBMISSION TESTS
  // ==========================================================================

  describe('Form Submission', () => {
    it('calls onSave with form data on submit', async () => {
      const user = userEvent.setup();
      renderForm();

      await user.type(screen.getByLabelText('Name'), 'New Server');
      await user.type(screen.getByLabelText('Command'), 'npx new-server');

      fireEvent.submit(screen.getByRole('form') || screen.getByText('Add Server').closest('form')!);

      await waitFor(() => {
        expect(mockOnSave).toHaveBeenCalledWith(
          expect.objectContaining({
            name: 'New Server',
            transport: 'stdio',
            command: 'npx new-server',
            enabled: true,
          })
        );
      });
    });

    it('includes server id when editing', async () => {
      const user = userEvent.setup();
      renderForm(createMockServer({ id: 5 }));

      await user.clear(screen.getByDisplayValue('Test Server'));
      await user.type(screen.getByLabelText('Name'), 'Updated Server');

      fireEvent.submit(screen.getByText('Update Server').closest('form')!);

      await waitFor(() => {
        expect(mockOnSave).toHaveBeenCalledWith(
          expect.objectContaining({
            id: 5,
            name: 'Updated Server',
          })
        );
      });
    });

    it('parses environment variables correctly', async () => {
      const user = userEvent.setup();
      renderForm();

      await user.type(screen.getByLabelText('Name'), 'Server');
      await user.type(screen.getByLabelText('Command'), 'cmd');
      await user.type(screen.getByLabelText(/Environment Variables/), 'KEY1=value1\nKEY2=value2');

      fireEvent.submit(screen.getByText('Add Server').closest('form')!);

      await waitFor(() => {
        expect(mockOnSave).toHaveBeenCalledWith(
          expect.objectContaining({
            env: { KEY1: 'value1', KEY2: 'value2' },
          })
        );
      });
    });

    it('handles environment variables with equals in value', async () => {
      const user = userEvent.setup();
      renderForm();

      await user.type(screen.getByLabelText('Name'), 'Server');
      await user.type(screen.getByLabelText('Command'), 'cmd');
      await user.type(screen.getByLabelText(/Environment Variables/), 'CONNECTION=host=localhost;port=5432');

      fireEvent.submit(screen.getByText('Add Server').closest('form')!);

      await waitFor(() => {
        expect(mockOnSave).toHaveBeenCalledWith(
          expect.objectContaining({
            env: { CONNECTION: 'host=localhost;port=5432' },
          })
        );
      });
    });

    it('parses arguments correctly', async () => {
      const user = userEvent.setup();
      renderForm();

      await user.type(screen.getByLabelText('Name'), 'Server');
      await user.type(screen.getByLabelText('Command'), 'cmd');
      await user.type(screen.getByLabelText(/Arguments/), '--flag1 --flag2 value');

      fireEvent.submit(screen.getByText('Add Server').closest('form')!);

      await waitFor(() => {
        expect(mockOnSave).toHaveBeenCalledWith(
          expect.objectContaining({
            args: ['--flag1', '--flag2', 'value'],
          })
        );
      });
    });

    it('filters empty argument strings', async () => {
      const user = userEvent.setup();
      renderForm();

      await user.type(screen.getByLabelText('Name'), 'Server');
      await user.type(screen.getByLabelText('Command'), 'cmd');
      await user.type(screen.getByLabelText(/Arguments/), '  --flag1   --flag2  ');

      fireEvent.submit(screen.getByText('Add Server').closest('form')!);

      await waitFor(() => {
        expect(mockOnSave).toHaveBeenCalledWith(
          expect.objectContaining({
            args: ['--flag1', '--flag2'],
          })
        );
      });
    });

    it('sets command to null for HTTP transport', async () => {
      const user = userEvent.setup();
      renderForm();

      await user.type(screen.getByLabelText('Name'), 'HTTP Server');
      fireEvent.change(screen.getByLabelText('Transport'), { target: { value: 'http' } });

      await waitFor(() => {
        expect(screen.getByLabelText('URL')).toBeInTheDocument();
      });

      await user.type(screen.getByLabelText('URL'), 'http://localhost:3000');

      fireEvent.submit(screen.getByText('Add Server').closest('form')!);

      await waitFor(() => {
        expect(mockOnSave).toHaveBeenCalledWith(
          expect.objectContaining({
            command: null,
            url: 'http://localhost:3000',
          })
        );
      });
    });

    it('sets url to null for STDIO transport', async () => {
      const user = userEvent.setup();
      renderForm();

      await user.type(screen.getByLabelText('Name'), 'STDIO Server');
      await user.type(screen.getByLabelText('Command'), 'npx server');

      fireEvent.submit(screen.getByText('Add Server').closest('form')!);

      await waitFor(() => {
        expect(mockOnSave).toHaveBeenCalledWith(
          expect.objectContaining({
            url: null,
            command: 'npx server',
          })
        );
      });
    });

    it('includes description when provided', async () => {
      const user = userEvent.setup();
      renderForm();

      await user.type(screen.getByLabelText('Name'), 'Server');
      await user.type(screen.getByLabelText('Description'), 'A useful server');
      await user.type(screen.getByLabelText('Command'), 'cmd');

      fireEvent.submit(screen.getByText('Add Server').closest('form')!);

      await waitFor(() => {
        expect(mockOnSave).toHaveBeenCalledWith(
          expect.objectContaining({
            description: 'A useful server',
          })
        );
      });
    });

    it('sets description to null when empty', async () => {
      const user = userEvent.setup();
      renderForm();

      await user.type(screen.getByLabelText('Name'), 'Server');
      await user.type(screen.getByLabelText('Command'), 'cmd');

      fireEvent.submit(screen.getByText('Add Server').closest('form')!);

      await waitFor(() => {
        expect(mockOnSave).toHaveBeenCalledWith(
          expect.objectContaining({
            description: null,
          })
        );
      });
    });
  });

  // ==========================================================================
  // CANCEL BUTTON TESTS
  // ==========================================================================

  describe('Cancel Button', () => {
    it('calls onCancel when Cancel clicked', () => {
      renderForm();

      fireEvent.click(screen.getByText('Cancel'));

      expect(mockOnCancel).toHaveBeenCalledTimes(1);
    });

    it('does not call onSave when Cancel clicked', () => {
      renderForm();

      fireEvent.click(screen.getByText('Cancel'));

      expect(mockOnSave).not.toHaveBeenCalled();
    });
  });

  // ==========================================================================
  // FORM VALIDATION TESTS
  // ==========================================================================

  describe('Form Validation', () => {
    it('requires Name field', () => {
      renderForm();
      const nameInput = screen.getByLabelText('Name');
      expect(nameInput).toBeRequired();
    });

    it('requires Command field for STDIO transport', () => {
      renderForm();
      const commandInput = screen.getByLabelText('Command');
      expect(commandInput).toBeRequired();
    });

    it('requires URL field for HTTP transport', async () => {
      renderForm();

      fireEvent.change(screen.getByLabelText('Transport'), { target: { value: 'http' } });

      await waitFor(() => {
        const urlInput = screen.getByLabelText('URL');
        expect(urlInput).toBeRequired();
      });
    });
  });

  // ==========================================================================
  // SCOPE OPTIONS TESTS
  // ==========================================================================

  describe('Scope Options', () => {
    it('has User (Global) option', () => {
      renderForm();
      expect(screen.getByText('User (Global)')).toBeInTheDocument();
    });

    it('has Project option', () => {
      renderForm();
      expect(screen.getByText('Project')).toBeInTheDocument();
    });

    it('defaults to user scope', () => {
      renderForm();
      expect(screen.getByDisplayValue('User (Global)')).toBeInTheDocument();
    });
  });

  // ==========================================================================
  // EDGE CASES
  // ==========================================================================

  describe('Edge Cases', () => {
    it('handles empty environment variables', async () => {
      const user = userEvent.setup();
      renderForm();

      await user.type(screen.getByLabelText('Name'), 'Server');
      await user.type(screen.getByLabelText('Command'), 'cmd');

      fireEvent.submit(screen.getByText('Add Server').closest('form')!);

      await waitFor(() => {
        expect(mockOnSave).toHaveBeenCalledWith(
          expect.objectContaining({
            env: {},
          })
        );
      });
    });

    it('handles environment variable lines without equals sign', async () => {
      const user = userEvent.setup();
      renderForm();

      await user.type(screen.getByLabelText('Name'), 'Server');
      await user.type(screen.getByLabelText('Command'), 'cmd');
      await user.type(screen.getByLabelText(/Environment Variables/), 'INVALID_LINE\nKEY=value');

      fireEvent.submit(screen.getByText('Add Server').closest('form')!);

      await waitFor(() => {
        expect(mockOnSave).toHaveBeenCalledWith(
          expect.objectContaining({
            env: { KEY: 'value' },
          })
        );
      });
    });

    it('handles empty arguments string', async () => {
      const user = userEvent.setup();
      renderForm();

      await user.type(screen.getByLabelText('Name'), 'Server');
      await user.type(screen.getByLabelText('Command'), 'cmd');

      fireEvent.submit(screen.getByText('Add Server').closest('form')!);

      await waitFor(() => {
        expect(mockOnSave).toHaveBeenCalledWith(
          expect.objectContaining({
            args: [],
          })
        );
      });
    });

    it('preserves enabled state when editing', async () => {
      renderForm(createMockServer({ enabled: false }));

      fireEvent.submit(screen.getByText('Update Server').closest('form')!);

      await waitFor(() => {
        expect(mockOnSave).toHaveBeenCalledWith(
          expect.objectContaining({
            enabled: false,
          })
        );
      });
    });

    it('handles server with empty env object', () => {
      renderForm(createMockServer({ env: {} }));
      const textarea = screen.getByLabelText(/Environment Variables/);
      expect(textarea).toHaveValue('');
    });

    it('handles server with empty args array', () => {
      renderForm(createMockServer({ args: [] }));
      const argsInput = screen.getByLabelText(/Arguments/);
      expect(argsInput).toHaveValue('');
    });
  });
});
