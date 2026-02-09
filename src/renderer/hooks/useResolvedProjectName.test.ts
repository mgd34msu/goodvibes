// ============================================================================
// USE RESOLVED PROJECT NAME HOOK TESTS
// ============================================================================

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import React from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useResolvedProjectName } from './useResolvedProjectName';

// ============================================================================
// TEST UTILITIES
// ============================================================================

function createWrapper() {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
      },
    },
  });

  return function Wrapper({ children }: { children: React.ReactNode }) {
    return React.createElement(
      QueryClientProvider,
      { client: queryClient },
      children
    );
  };
}

// ============================================================================
// MOCKS
// ============================================================================

const mockResolveProjectPath = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();

  // Mock window.goodvibes
  (globalThis as Record<string, unknown>).window = {
    goodvibes: {
      resolveProjectPath: mockResolveProjectPath,
    },
  };

  // Mock process.env for formatProjectDisplayName
  process.env.HOME = '/home/buzzkill';
});

// ============================================================================
// TESTS
// ============================================================================

describe('useResolvedProjectName', () => {
  it('returns naive fallback initially before resolution', () => {
    mockResolveProjectPath.mockResolvedValue({ path: '/home/buzzkill/Projects/my-app' });

    const { result } = renderHook(
      () => useResolvedProjectName('-home-buzzkill-Projects-my-app', '/home/buzzkill/Projects'),
      { wrapper: createWrapper() }
    );

    // Initially returns the naive decode (before IPC resolves)
    // decodeProjectName('-home-buzzkill-Projects-my-app', '/home/buzzkill/Projects') = 'my-app' or similar
    expect(typeof result.current).toBe('string');
    expect(result.current.length).toBeGreaterThan(0);
  });

  it('resolves to correct display name after IPC call', async () => {
    mockResolveProjectPath.mockResolvedValue({ path: '/home/buzzkill/Projects/goodvibes-plugin' });

    const { result } = renderHook(
      () => useResolvedProjectName('-home-buzzkill-Projects-goodvibes-plugin', '/home/buzzkill/Projects'),
      { wrapper: createWrapper() }
    );

    // Wait for query to resolve
    await vi.waitFor(() => {
      expect(result.current).toBe('goodvibes-plugin');
    });
    expect(mockResolveProjectPath).toHaveBeenCalledWith('-home-buzzkill-Projects-goodvibes-plugin');
  });

  it('handles null encoded name', () => {
    const { result } = renderHook(
      () => useResolvedProjectName(null, '/home/buzzkill/Projects'),
      { wrapper: createWrapper() }
    );

    expect(result.current).toBe('Unknown');
    expect(mockResolveProjectPath).not.toHaveBeenCalled();
  });

  it('handles undefined encoded name', () => {
    const { result } = renderHook(
      () => useResolvedProjectName(undefined),
      { wrapper: createWrapper() }
    );

    expect(result.current).toBe('Unknown');
    expect(mockResolveProjectPath).not.toHaveBeenCalled();
  });

  it('falls back to naive decode on IPC error', async () => {
    mockResolveProjectPath.mockRejectedValue(new Error('IPC failed'));

    const { result } = renderHook(
      () => useResolvedProjectName('-home-buzzkill-Projects-myapp', '/home/buzzkill/Projects'),
      { wrapper: createWrapper() }
    );

    // Should still show a reasonable name (the naive fallback)
    await vi.waitFor(() => {
      expect(typeof result.current).toBe('string');
    });
    expect(result.current.length).toBeGreaterThan(0);
  });

  it('falls back when IPC returns null path', async () => {
    mockResolveProjectPath.mockResolvedValue({ path: null });

    const { result } = renderHook(
      () => useResolvedProjectName('-home-buzzkill-Projects-myapp', '/home/buzzkill/Projects'),
      { wrapper: createWrapper() }
    );

    // When path is null, should fall back to naive decode
    await vi.waitFor(() => {
      expect(mockResolveProjectPath).toHaveBeenCalled();
    });
    expect(typeof result.current).toBe('string');
    expect(result.current.length).toBeGreaterThan(0);
  });

  it('caches results across renders', async () => {
    mockResolveProjectPath.mockResolvedValue({ path: '/home/buzzkill/Projects/my-app' });

    const wrapper = createWrapper();

    const { result, rerender } = renderHook(
      () => useResolvedProjectName('-home-buzzkill-Projects-my-app', '/home/buzzkill/Projects'),
      { wrapper }
    );

    // Wait for query to resolve
    await vi.waitFor(() => {
      expect(result.current).toBe('my-app');
    });

    // Rerender should not trigger another IPC call
    rerender();

    expect(mockResolveProjectPath).toHaveBeenCalledTimes(1);
  });

  it('returns home shorthand for home directory paths', async () => {
    mockResolveProjectPath.mockResolvedValue({ path: '/home/buzzkill' });

    const { result } = renderHook(
      () => useResolvedProjectName('-home-buzzkill'),
      { wrapper: createWrapper() }
    );

    // Wait for query to resolve
    await vi.waitFor(() => {
      expect(result.current).toBe('~');
    });
  });
});
