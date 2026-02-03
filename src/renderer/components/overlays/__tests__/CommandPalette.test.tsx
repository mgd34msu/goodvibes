// ============================================================================
// COMMAND PALETTE COMPONENT TESTS
// ============================================================================
//
// Comprehensive tests for CommandPalette component including:
// - Opening and closing
// - Search and filtering
// - Keyboard navigation
// - Command execution
// - Escape key handling
// - Category display
//
// ============================================================================

import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { CommandPalette } from '../CommandPalette';
import { useAppStore } from '../../../stores/appStore';

// ============================================================================
// MOCKS
// ============================================================================

// Mock window.goodvibes API
const mockGetSetting = vi.fn();
const mockSetSetting = vi.fn();

global.window.goodvibes = {
  getSetting: mockGetSetting,
  setSetting: mockSetSetting,
} as any;

// Mock appStore functions
const mockCloseCommandPalette = vi.fn();
const mockSetCurrentView = vi.fn();
const mockOpenFolderPicker = vi.fn();
const mockOpenModal = vi.fn();

// ============================================================================
// TEST UTILITIES
// ============================================================================

/**
 * Setup appStore with default state
 */
function setupAppStore(isOpen: boolean = true) {
  useAppStore.setState({
    isCommandPaletteOpen: isOpen,
    closeCommandPalette: mockCloseCommandPalette,
    setCurrentView: mockSetCurrentView,
    openFolderPicker: mockOpenFolderPicker,
    openModal: mockOpenModal,
  });
}

/**
 * Reset all mocks
 */
function resetMocks() {
  vi.clearAllMocks();
  mockGetSetting.mockReset();
  mockSetSetting.mockReset();
  mockCloseCommandPalette.mockReset();
  mockSetCurrentView.mockReset();
  mockOpenFolderPicker.mockReset();
  mockOpenModal.mockReset();
}

// ============================================================================
// COMMAND PALETTE TESTS
// ============================================================================

describe('CommandPalette', () => {
  beforeEach(() => {
    resetMocks();
    setupAppStore(true);
    mockGetSetting.mockResolvedValue('dark');
    mockSetSetting.mockResolvedValue(undefined);
  });

  afterEach(() => {
    resetMocks();
  });

  // ==========================================================================
  // RENDERING TESTS
  // ==========================================================================

  describe('Rendering', () => {
    it('renders when isOpen is true', () => {
      setupAppStore(true);
      render(<CommandPalette />);

      // Should show search input with correct placeholder
      expect(screen.getByPlaceholderText('Type a command...')).toBeInTheDocument();
    });

    it('does not render when isOpen is false', () => {
      setupAppStore(false);
      const { container } = render(<CommandPalette />);

      // Should return null (no content)
      expect(container.firstChild).toBeNull();
    });

    it('displays default commands', () => {
      render(<CommandPalette />);

      // Should show navigation commands
      expect(screen.getByText(/Go to Terminal/i)).toBeInTheDocument();
      expect(screen.getByText(/Go to Settings/i)).toBeInTheDocument();
    });

    it('groups commands by category', () => {
      render(<CommandPalette />);

      // Categories should be visible
      expect(screen.getByText('Navigation')).toBeInTheDocument();
      expect(screen.getByText('Terminal')).toBeInTheDocument();
      expect(screen.getByText('Settings')).toBeInTheDocument();
    });

    it('displays keyboard hints in footer', () => {
      render(<CommandPalette />);

      expect(screen.getByText('Navigate')).toBeInTheDocument();
      expect(screen.getByText('Execute')).toBeInTheDocument();
    });
  });

  // ==========================================================================
  // OPEN/CLOSE TESTS
  // ==========================================================================

  describe('Open/Close', () => {
    it('closes when close function is called', async () => {
      render(<CommandPalette />);

      const input = screen.getByPlaceholderText('Type a command...');
      expect(input).toBeInTheDocument();

      // Simulate store update to close
      await act(async () => {
        setupAppStore(false);
      });

      // Re-render with closed state
      const { container } = render(<CommandPalette />);
      expect(container.firstChild).toBeNull();
    });

    it('closes on escape key', async () => {
      render(<CommandPalette />);

      const input = screen.getByPlaceholderText('Type a command...');
      await act(async () => {
        fireEvent.keyDown(input, { key: 'Escape' });
      });

      expect(mockCloseCommandPalette).toHaveBeenCalled();
    });

    it('resets search when reopened', async () => {
      const user = userEvent.setup();
      const { rerender } = render(<CommandPalette />);

      // Type search query
      const input = screen.getByPlaceholderText('Type a command...');
      await user.type(input, 'test query');
      expect(input).toHaveValue('test query');

      // Close
      setupAppStore(false);
      rerender(<CommandPalette />);

      // Reopen
      setupAppStore(true);
      rerender(<CommandPalette />);

      // Search should be reset
      const newInput = screen.getByPlaceholderText('Type a command...');
      expect(newInput).toHaveValue('');
    });
  });

  // ==========================================================================
  // SEARCH/FILTER TESTS
  // ==========================================================================

  describe('Search and Filtering', () => {
    it('filters commands based on search input', async () => {
      const user = userEvent.setup();
      render(<CommandPalette />);

      const input = screen.getByPlaceholderText('Type a command...');
      
      // Initially shows all commands
      expect(screen.getByText(/Go to Terminal/i)).toBeInTheDocument();
      expect(screen.getByText(/New Terminal/i)).toBeInTheDocument();

      // Search for "settings"
      await user.type(input, 'settings');

      // Should show only settings-related commands
      await waitFor(() => {
        expect(screen.getByText(/Open Settings/i)).toBeInTheDocument();
        expect(screen.queryByText(/New Terminal/i)).not.toBeInTheDocument();
      });
    });

    it('filters by command label', async () => {
      const user = userEvent.setup();
      render(<CommandPalette />);

      const input = screen.getByPlaceholderText('Type a command...');
      await user.type(input, 'terminal');

      await waitFor(() => {
        expect(screen.getByText(/New Terminal/i)).toBeInTheDocument();
        expect(screen.queryByText(/Open Settings/i)).not.toBeInTheDocument();
      });
    });

    it('filters by command description', async () => {
      const user = userEvent.setup();
      render(<CommandPalette />);

      const input = screen.getByPlaceholderText('Type a command...');
      await user.type(input, 'Claude session');

      await waitFor(() => {
        expect(screen.getByText(/New Terminal/i)).toBeInTheDocument();
      });
    });

    it('filters by category', async () => {
      const user = userEvent.setup();
      render(<CommandPalette />);

      const input = screen.getByPlaceholderText('Type a command...');
      await user.type(input, 'navigation');

      await waitFor(() => {
        expect(screen.getByText(/Go to Terminal/i)).toBeInTheDocument();
        expect(screen.queryByText(/Toggle Theme/i)).not.toBeInTheDocument();
      });
    });

    it('shows all commands when search is empty', async () => {
      const user = userEvent.setup();
      render(<CommandPalette />);

      const input = screen.getByPlaceholderText('Type a command...');
      
      // Type and then clear
      await user.type(input, 'test');
      await user.clear(input);

      // All commands should be visible again
      await waitFor(() => {
        expect(screen.getByText(/Go to Terminal/i)).toBeInTheDocument();
        expect(screen.getByText(/New Terminal/i)).toBeInTheDocument();
        expect(screen.getByText(/Open Settings/i)).toBeInTheDocument();
      });
    });

    it('handles case-insensitive search', async () => {
      const user = userEvent.setup();
      render(<CommandPalette />);

      const input = screen.getByPlaceholderText('Type a command...');
      await user.type(input, 'TERMINAL');

      await waitFor(() => {
        expect(screen.getByText(/New Terminal/i)).toBeInTheDocument();
      });
    });

    it('shows no results message when search matches nothing', async () => {
      const user = userEvent.setup();
      render(<CommandPalette />);

      const input = screen.getByPlaceholderText('Type a command...');
      await user.type(input, 'xyznonexistent');

      await waitFor(() => {
        expect(screen.getByText('No commands found')).toBeInTheDocument();
        expect(screen.queryByText(/Go to Terminal/i)).not.toBeInTheDocument();
      });
    });
  });

  // ==========================================================================
  // KEYBOARD NAVIGATION TESTS
  // ==========================================================================

  describe('Keyboard Navigation', () => {
    it('navigates down with ArrowDown key', async () => {
      render(<CommandPalette />);

      const input = screen.getByPlaceholderText('Type a command...');
      const commands = screen.getAllByRole('button').filter(btn => 
        btn.classList.contains('modal-list-item-premium')
      );

      // First command should be selected by default
      expect(commands[0]).toHaveClass('selected');
      
      // Arrow down should select next item
      await act(async () => {
        fireEvent.keyDown(input, { key: 'ArrowDown' });
      });

      // Second command should now be selected
      await waitFor(() => {
        expect(commands[1]).toHaveClass('selected');
      });
    });

    it('navigates up with ArrowUp key', async () => {
      render(<CommandPalette />);

      const input = screen.getByPlaceholderText('Type a command...');
      
      // Arrow down twice, then up once
      await act(async () => {
        fireEvent.keyDown(input, { key: 'ArrowDown' });
        fireEvent.keyDown(input, { key: 'ArrowDown' });
        fireEvent.keyDown(input, { key: 'ArrowUp' });
      });

      const commands = screen.getAllByRole('button').filter(btn => 
        btn.classList.contains('modal-list-item-premium')
      );

      // Should navigate back to second item
      expect(commands[1]).toHaveClass('selected');
    });

    it('does not navigate above first item', async () => {
      render(<CommandPalette />);

      const input = screen.getByPlaceholderText('Type a command...');
      
      // Arrow up when already at first item
      await act(async () => {
        fireEvent.keyDown(input, { key: 'ArrowUp' });
      });

      const commands = screen.getAllByRole('button').filter(btn => 
        btn.classList.contains('modal-list-item-premium')
      );

      // Should stay at first item
      expect(commands[0]).toHaveClass('selected');
    });

    it('does not navigate below last item', async () => {
      render(<CommandPalette />);

      const input = screen.getByPlaceholderText('Type a command...');
      const commands = screen.getAllByRole('button').filter(btn => 
        btn.classList.contains('modal-list-item-premium')
      );
      const commandCount = commands.length;

      // Arrow down many times (more than command count)
      await act(async () => {
        for (let i = 0; i < commandCount + 5; i++) {
          fireEvent.keyDown(input, { key: 'ArrowDown' });
        }
      });

      // Last item should be selected
      await waitFor(() => {
        expect(commands[commandCount - 1]).toHaveClass('selected');
      });
    });

    it('resets selection when search changes', async () => {
      const user = userEvent.setup();
      render(<CommandPalette />);

      const input = screen.getByPlaceholderText('Type a command...');

      // Navigate down
      await act(async () => {
        fireEvent.keyDown(input, { key: 'ArrowDown' });
        fireEvent.keyDown(input, { key: 'ArrowDown' });
      });

      // Type search (should reset selection to 0)
      await user.type(input, 'settings');

      await waitFor(() => {
        const commands = screen.getAllByRole('button').filter(btn => 
          btn.classList.contains('modal-list-item-premium')
        );
        // First command should be selected again
        expect(commands[0]).toHaveClass('selected');
      });
    });
  });

  // ==========================================================================
  // COMMAND EXECUTION TESTS
  // ==========================================================================

  describe('Command Execution', () => {
    it('executes selected command on Enter key', async () => {
      render(<CommandPalette />);

      const input = screen.getByPlaceholderText('Type a command...');
      
      // Press Enter (should execute first command - Go to Terminal)
      await act(async () => {
        fireEvent.keyDown(input, { key: 'Enter' });
      });

      // First command is a navigation command
      await waitFor(() => {
        expect(mockSetCurrentView).toHaveBeenCalled();
        expect(mockCloseCommandPalette).toHaveBeenCalled();
      });
    });

    it('executes selected command on click', async () => {
      render(<CommandPalette />);

      const settingsCommand = screen.getByText(/Open Settings/i).closest('button');
      
      await act(async () => {
        fireEvent.click(settingsCommand!);
      });

      await waitFor(() => {
        expect(mockSetCurrentView).toHaveBeenCalledWith('settings');
        expect(mockCloseCommandPalette).toHaveBeenCalled();
      });
    });

    it('executes new terminal command', async () => {
      render(<CommandPalette />);

      const newTerminalCommand = screen.getByText(/New Terminal/i).closest('button');
      
      await act(async () => {
        fireEvent.click(newTerminalCommand!);
      });

      await waitFor(() => {
        expect(mockOpenFolderPicker).toHaveBeenCalled();
        expect(mockCloseCommandPalette).toHaveBeenCalled();
      });
    });

    it('executes toggle theme command', async () => {
      render(<CommandPalette />);

      const toggleThemeCommand = screen.getByText(/Toggle Theme/i).closest('button');
      
      await act(async () => {
        fireEvent.click(toggleThemeCommand!);
      });

      await waitFor(() => {
        expect(mockGetSetting).toHaveBeenCalledWith('theme');
        expect(mockSetSetting).toHaveBeenCalledWith('theme', 'light');
        expect(mockCloseCommandPalette).toHaveBeenCalled();
      });
    });

    it('executes about command', async () => {
      render(<CommandPalette />);

      const aboutCommand = screen.getByText(/About GoodVibes/i).closest('button');
      
      await act(async () => {
        fireEvent.click(aboutCommand!);
      });

      await waitFor(() => {
        expect(mockOpenModal).toHaveBeenCalledWith('about');
        expect(mockCloseCommandPalette).toHaveBeenCalled();
      });
    });

    it('closes palette after command execution', async () => {
      render(<CommandPalette />);

      const commands = screen.getAllByRole('button').filter(btn => 
        btn.classList.contains('modal-list-item-premium')
      );
      
      await act(async () => {
        fireEvent.click(commands[0]);
      });

      await waitFor(() => {
        expect(mockCloseCommandPalette).toHaveBeenCalled();
      });
    });
  });

  // ==========================================================================
  // ERROR HANDLING TESTS
  // ==========================================================================

  describe('Error Handling', () => {
    it('handles theme toggle failure gracefully', async () => {
      const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
      mockGetSetting.mockRejectedValue(new Error('Failed to get setting'));

      render(<CommandPalette />);

      const toggleThemeCommand = screen.getByText(/Toggle Theme/i).closest('button');
      
      await act(async () => {
        fireEvent.click(toggleThemeCommand!);
      });

      // Should not crash, error should be handled
      await waitFor(() => {
        expect(mockGetSetting).toHaveBeenCalled();
      });

      consoleError.mockRestore();
    });
  });

  // ==========================================================================
  // ACCESSIBILITY TESTS
  // ==========================================================================

  describe('Accessibility', () => {
    it('input has type text', () => {
      render(<CommandPalette />);

      const input = screen.getByPlaceholderText('Type a command...');
      expect(input).toHaveAttribute('type', 'text');
    });

    it('commands are keyboard accessible', async () => {
      render(<CommandPalette />);

      const input = screen.getByPlaceholderText('Type a command...');
      
      // Navigate with keyboard and execute
      await act(async () => {
        fireEvent.keyDown(input, { key: 'ArrowDown' });
        fireEvent.keyDown(input, { key: 'Enter' });
      });

      // Command should execute
      await waitFor(() => {
        expect(mockCloseCommandPalette).toHaveBeenCalled();
      });
    });
  });

  // ==========================================================================
  // EDGE CASES
  // ==========================================================================

  describe('Edge Cases', () => {
    it('handles rapid key presses', async () => {
      render(<CommandPalette />);

      const input = screen.getByPlaceholderText('Type a command...');
      
      // Rapidly press keys
      await act(async () => {
        for (let i = 0; i < 10; i++) {
          fireEvent.keyDown(input, { key: 'ArrowDown' });
        }
        fireEvent.keyDown(input, { key: 'Enter' });
      });

      // Should not crash
      await waitFor(() => {
        expect(mockCloseCommandPalette).toHaveBeenCalled();
      });
    });

    it('handles Enter key with no filtered results', async () => {
      const user = userEvent.setup();
      render(<CommandPalette />);

      const input = screen.getByPlaceholderText('Type a command...');
      await user.type(input, 'xyznonexistent');

      await act(async () => {
        fireEvent.keyDown(input, { key: 'Enter' });
      });

      // Should not crash or execute anything
      expect(mockSetCurrentView).not.toHaveBeenCalled();
    });

    it('handles special characters in search', async () => {
      const user = userEvent.setup();
      render(<CommandPalette />);

      const input = screen.getByPlaceholderText('Type a command...');
      await user.type(input, '!@#$%^&*()');

      // Should not crash
      expect(input).toHaveValue('!@#$%^&*()');
    });
  });
});
