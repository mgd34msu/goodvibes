// ============================================================================
// DEVICE FLOW LOGIN COMPONENT TESTS
// ============================================================================

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { DeviceFlowLogin } from '../DeviceFlowLogin';

describe('DeviceFlowLogin', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('Initial State', () => {
    it('renders login button in idle state', () => {
      render(<DeviceFlowLogin />);

      expect(screen.getByRole('button', { name: /login with github/i })).toBeInTheDocument();
    });

    it('shows description text when not in compact mode', () => {
      render(<DeviceFlowLogin compact={false} />);

      expect(screen.getByText(/you will be given a code/i)).toBeInTheDocument();
    });

    it('hides description text in compact mode', () => {
      render(<DeviceFlowLogin compact={true} />);

      expect(screen.queryByText(/you will be given a code/i)).not.toBeInTheDocument();
    });
  });

  describe('Starting Device Flow', () => {
    it('calls githubDeviceFlowStart when login button is clicked', async () => {
      const mockStart = vi.fn().mockResolvedValue({
        success: true,
        userCode: 'TEST-CODE',
        verificationUri: 'https://github.com/login/device',
        expiresIn: 900,
      });
      window.goodvibes.githubDeviceFlowStart = mockStart;
      window.goodvibes.githubDeviceFlowWait = vi.fn().mockImplementation(() => new Promise(() => {}));

      render(<DeviceFlowLogin />);

      fireEvent.click(screen.getByRole('button', { name: /login with github/i }));

      await waitFor(() => {
        expect(mockStart).toHaveBeenCalledWith({ openBrowser: true });
      });
    });

    it('displays loading state while starting', async () => {
      window.goodvibes.githubDeviceFlowStart = vi.fn().mockImplementation(
        () => new Promise(() => {}) // Never resolves
      );

      render(<DeviceFlowLogin />);

      fireEvent.click(screen.getByRole('button', { name: /login with github/i }));

      await waitFor(() => {
        expect(screen.getByText(/starting github login/i)).toBeInTheDocument();
      });
    });
  });

  describe('Code Display State', () => {
    it('displays user code when device flow starts successfully', async () => {
      window.goodvibes.githubDeviceFlowStart = vi.fn().mockResolvedValue({
        success: true,
        userCode: 'ABCD-1234',
        verificationUri: 'https://github.com/login/device',
        expiresIn: 900,
      });
      window.goodvibes.githubDeviceFlowWait = vi.fn().mockImplementation(() => new Promise(() => {}));

      render(<DeviceFlowLogin />);

      fireEvent.click(screen.getByRole('button', { name: /login with github/i }));

      await waitFor(() => {
        expect(screen.getByText('ABCD-1234')).toBeInTheDocument();
      });
    });

    it('displays verification URL', async () => {
      window.goodvibes.githubDeviceFlowStart = vi.fn().mockResolvedValue({
        success: true,
        userCode: 'ABCD-1234',
        verificationUri: 'https://github.com/login/device',
        expiresIn: 900,
      });
      window.goodvibes.githubDeviceFlowWait = vi.fn().mockImplementation(() => new Promise(() => {}));

      render(<DeviceFlowLogin />);

      fireEvent.click(screen.getByRole('button', { name: /login with github/i }));

      await waitFor(() => {
        expect(screen.getByText('https://github.com/login/device')).toBeInTheDocument();
      });
    });

    it('shows copy code button', async () => {
      window.goodvibes.githubDeviceFlowStart = vi.fn().mockResolvedValue({
        success: true,
        userCode: 'ABCD-1234',
        verificationUri: 'https://github.com/login/device',
        expiresIn: 900,
      });
      window.goodvibes.githubDeviceFlowWait = vi.fn().mockImplementation(() => new Promise(() => {}));

      render(<DeviceFlowLogin />);

      fireEvent.click(screen.getByRole('button', { name: /login with github/i }));

      await waitFor(() => {
        expect(screen.getByText(/copy code/i)).toBeInTheDocument();
      });
    });

    it('shows cancel button during code display', async () => {
      window.goodvibes.githubDeviceFlowStart = vi.fn().mockResolvedValue({
        success: true,
        userCode: 'ABCD-1234',
        verificationUri: 'https://github.com/login/device',
        expiresIn: 900,
      });
      window.goodvibes.githubDeviceFlowWait = vi.fn().mockImplementation(() => new Promise(() => {}));

      render(<DeviceFlowLogin />);

      fireEvent.click(screen.getByRole('button', { name: /login with github/i }));

      await waitFor(() => {
        expect(screen.getByRole('button', { name: /cancel/i })).toBeInTheDocument();
      });
    });
  });

  describe('Cancellation', () => {
    it('calls cancel callback and resets state when cancelled', async () => {
      const onCancel = vi.fn();
      window.goodvibes.githubDeviceFlowStart = vi.fn().mockResolvedValue({
        success: true,
        userCode: 'ABCD-1234',
        verificationUri: 'https://github.com/login/device',
        expiresIn: 900,
      });
      window.goodvibes.githubDeviceFlowWait = vi.fn().mockImplementation(() => new Promise(() => {}));
      window.goodvibes.githubDeviceFlowCancel = vi.fn().mockResolvedValue({ success: true });

      render(<DeviceFlowLogin onCancel={onCancel} />);

      fireEvent.click(screen.getByRole('button', { name: /login with github/i }));

      await waitFor(() => {
        expect(screen.getByText('ABCD-1234')).toBeInTheDocument();
      });

      fireEvent.click(screen.getByRole('button', { name: /cancel/i }));

      await waitFor(() => {
        expect(onCancel).toHaveBeenCalled();
        expect(screen.getByRole('button', { name: /login with github/i })).toBeInTheDocument();
      });
    });
  });

  describe('Success State', () => {
    it('displays success message and user info when authenticated', async () => {
      const mockUser = {
        login: 'testuser',
        name: 'Test User',
        avatar_url: 'https://github.com/testuser.png',
        id: 123,
        node_id: 'abc123',
        gravatar_id: '',
        url: '',
        html_url: '',
        type: 'User' as const,
        email: null,
        company: null,
        location: null,
        bio: null,
        public_repos: 0,
        followers: 0,
        following: 0,
        created_at: '',
        updated_at: '',
      };

      const onAuthSuccess = vi.fn();
      window.goodvibes.githubDeviceFlowStart = vi.fn().mockResolvedValue({
        success: true,
        userCode: 'ABCD-1234',
        verificationUri: 'https://github.com/login/device',
        expiresIn: 900,
      });
      window.goodvibes.githubDeviceFlowWait = vi.fn().mockResolvedValue({
        success: true,
        user: mockUser,
      });

      render(<DeviceFlowLogin onAuthSuccess={onAuthSuccess} />);

      fireEvent.click(screen.getByRole('button', { name: /login with github/i }));

      await waitFor(() => {
        expect(screen.getByText(/welcome, test user/i)).toBeInTheDocument();
        expect(screen.getByText('@testuser')).toBeInTheDocument();
        expect(onAuthSuccess).toHaveBeenCalledWith(mockUser);
      });
    });
  });

  describe('Error State', () => {
    it('displays error when device flow start fails', async () => {
      const onAuthError = vi.fn();
      window.goodvibes.githubDeviceFlowStart = vi.fn().mockResolvedValue({
        success: false,
        error: 'Failed to start device flow',
      });

      render(<DeviceFlowLogin onAuthError={onAuthError} />);

      fireEvent.click(screen.getByRole('button', { name: /login with github/i }));

      await waitFor(() => {
        expect(screen.getByText(/authentication failed/i)).toBeInTheDocument();
        expect(screen.getByText(/failed to start device flow/i)).toBeInTheDocument();
        expect(onAuthError).toHaveBeenCalledWith('Failed to start device flow');
      });
    });

    it('shows retry button on error', async () => {
      window.goodvibes.githubDeviceFlowStart = vi.fn().mockResolvedValue({
        success: false,
        error: 'Network error',
      });

      render(<DeviceFlowLogin />);

      fireEvent.click(screen.getByRole('button', { name: /login with github/i }));

      await waitFor(() => {
        expect(screen.getByRole('button', { name: /try again/i })).toBeInTheDocument();
      });
    });

    it('allows retrying after error', async () => {
      const mockStart = vi.fn()
        .mockResolvedValueOnce({ success: false, error: 'First error' })
        .mockResolvedValueOnce({
          success: true,
          userCode: 'NEW-CODE',
          verificationUri: 'https://github.com/login/device',
          expiresIn: 900,
        });
      window.goodvibes.githubDeviceFlowStart = mockStart;
      window.goodvibes.githubDeviceFlowWait = vi.fn().mockImplementation(() => new Promise(() => {}));

      render(<DeviceFlowLogin />);

      // First attempt fails
      fireEvent.click(screen.getByRole('button', { name: /login with github/i }));
      await waitFor(() => {
        expect(screen.getByText(/first error/i)).toBeInTheDocument();
      });

      // Retry succeeds
      fireEvent.click(screen.getByRole('button', { name: /try again/i }));
      await waitFor(() => {
        expect(screen.getByText('NEW-CODE')).toBeInTheDocument();
      });
    });
  });

  describe('Access Denied', () => {
    it('shows appropriate message when user denies access', async () => {
      window.goodvibes.githubDeviceFlowStart = vi.fn().mockResolvedValue({
        success: true,
        userCode: 'ABCD-1234',
        verificationUri: 'https://github.com/login/device',
        expiresIn: 900,
      });
      window.goodvibes.githubDeviceFlowWait = vi.fn().mockResolvedValue({
        success: false,
        error: 'access_denied',
      });

      render(<DeviceFlowLogin />);

      fireEvent.click(screen.getByRole('button', { name: /login with github/i }));

      await waitFor(() => {
        expect(screen.getByText(/access was denied/i)).toBeInTheDocument();
      });
    });
  });

  describe('Accessibility', () => {
    it('has accessible code label', async () => {
      window.goodvibes.githubDeviceFlowStart = vi.fn().mockResolvedValue({
        success: true,
        userCode: 'ABCD-1234',
        verificationUri: 'https://github.com/login/device',
        expiresIn: 900,
      });
      window.goodvibes.githubDeviceFlowWait = vi.fn().mockImplementation(() => new Promise(() => {}));

      render(<DeviceFlowLogin />);

      fireEvent.click(screen.getByRole('button', { name: /login with github/i }));

      await waitFor(() => {
        const codeElement = screen.getByLabelText(/your code is/i);
        expect(codeElement).toBeInTheDocument();
      });
    });
  });
});
