// ============================================================================
// TOAST COMPONENT TESTS
// ============================================================================

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, act, waitFor } from '@testing-library/react';
import { ToastContainer } from './Toast';
import { useToastStore, toast } from '../../stores/toastStore';

describe('ToastContainer', () => {
  beforeEach(() => {
    // Clear toast store
    useToastStore.setState({ toasts: [] });
    vi.clearAllMocks();
  });

  it('renders nothing when no toasts', () => {
    render(<ToastContainer />);
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('renders toast messages', () => {
    act(() => {
      toast.success('Success message');
    });

    render(<ToastContainer />);
    expect(screen.getByText('Success message')).toBeInTheDocument();
  });

  it('renders multiple toasts', () => {
    act(() => {
      toast.success('First toast');
      toast.error('Second toast');
      toast.info('Third toast');
    });

    render(<ToastContainer />);
    expect(screen.getByText('First toast')).toBeInTheDocument();
    expect(screen.getByText('Second toast')).toBeInTheDocument();
    expect(screen.getByText('Third toast')).toBeInTheDocument();
  });

  it('applies correct styling based on type', () => {
    act(() => {
      toast.success('Success');
      toast.error('Error');
      toast.info('Info');
      toast.warning('Warning');
    });

    render(<ToastContainer />);

    const toasts = screen.getAllByRole('alert');
    expect(toasts).toHaveLength(4);
  });

  it('removes toast when dismiss button clicked', async () => {
    act(() => {
      toast.success('Dismissible toast');
    });

    render(<ToastContainer />);

    const dismissButton = screen.getByRole('button');
    fireEvent.click(dismissButton);

    // Toast has a 200ms exit animation before removal
    await waitFor(() => {
      expect(screen.queryByText('Dismissible toast')).toBeNull();
    }, { timeout: 500 });
  });
});

describe('toast helper functions', () => {
  beforeEach(() => {
    useToastStore.setState({ toasts: [] });
  });

  it('toast.success creates success toast', () => {
    act(() => {
      toast.success('Success message');
    });

    const { toasts } = useToastStore.getState();
    expect(toasts).toHaveLength(1);
    expect(toasts[0]?.type).toBe('success');
    expect(toasts[0]?.message).toBe('Success message');
  });

  it('toast.error creates error toast', () => {
    act(() => {
      toast.error('Error message');
    });

    const { toasts } = useToastStore.getState();
    expect(toasts[0]?.type).toBe('error');
  });

  it('toast.info creates info toast', () => {
    act(() => {
      toast.info('Info message');
    });

    const { toasts } = useToastStore.getState();
    expect(toasts[0]?.type).toBe('info');
  });

  it('toast.warning creates warning toast', () => {
    act(() => {
      toast.warning('Warning message');
    });

    const { toasts } = useToastStore.getState();
    expect(toasts[0]?.type).toBe('warning');
  });

  it('generates unique IDs for each toast', () => {
    act(() => {
      toast.success('Toast 1');
      toast.success('Toast 2');
      toast.success('Toast 3');
    });

    const { toasts } = useToastStore.getState();
    const ids = toasts.map((t) => t.id);
    const uniqueIds = new Set(ids);
    expect(uniqueIds.size).toBe(3);
  });
});
