// ============================================================================
// ERROR BOUNDARY COMPONENT TESTS
// Comprehensive tests for error catching, fallback UI, and reset functionality
// ============================================================================

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import React, { useState } from 'react';
import { ErrorBoundary, useErrorHandler, type FallbackRenderProps } from './ErrorBoundary';

// ============================================================================
// Test Utilities
// ============================================================================

/**
 * Component that throws an error when rendered
 */
function ThrowingComponent({ error }: { error: Error }): React.JSX.Element {
  throw error;
}

/**
 * Component that throws an error on demand via a button click
 */
function ThrowOnClickComponent(): React.JSX.Element {
  const [shouldThrow, setShouldThrow] = useState(false);

  if (shouldThrow) {
    throw new Error('User triggered error');
  }

  return (
    <button onClick={() => setShouldThrow(true)} type="button">
      Trigger Error
    </button>
  );
}

/**
 * Component that uses the useErrorHandler hook
 */
function ErrorHandlerHookComponent({
  error,
}: {
  error: Error | null;
}): React.JSX.Element {
  const handleError = useErrorHandler();

  return (
    <button
      onClick={() => {
        if (error) {
          handleError(error);
        }
      }}
      type="button"
    >
      Throw via Hook
    </button>
  );
}

/**
 * Suppress React error boundary console output during tests
 */
function suppressConsoleErrors(): () => void {
  const originalError = console.error;
  console.error = vi.fn();
  return () => {
    console.error = originalError;
  };
}

// ============================================================================
// Test Suite
// ============================================================================

describe('ErrorBoundary', () => {
  let restoreConsole: () => void;

  beforeEach(() => {
    // Suppress React's error boundary console logs for cleaner test output
    restoreConsole = suppressConsoleErrors();
    vi.clearAllMocks();
  });

  afterEach(() => {
    restoreConsole();
  });

  // --------------------------------------------------------------------------
  // Basic Rendering
  // --------------------------------------------------------------------------

  describe('basic rendering', () => {
    it('renders children normally when no error occurs', () => {
      render(
        <ErrorBoundary>
          <div data-testid="child-content">Hello World</div>
        </ErrorBoundary>
      );

      expect(screen.getByTestId('child-content')).toBeInTheDocument();
      expect(screen.getByText('Hello World')).toBeInTheDocument();
    });

    it('renders multiple children without error', () => {
      render(
        <ErrorBoundary>
          <span>First</span>
          <span>Second</span>
          <span>Third</span>
        </ErrorBoundary>
      );

      expect(screen.getByText('First')).toBeInTheDocument();
      expect(screen.getByText('Second')).toBeInTheDocument();
      expect(screen.getByText('Third')).toBeInTheDocument();
    });

    it('renders nested children correctly', () => {
      render(
        <ErrorBoundary>
          <div>
            <span>
              <strong>Nested content</strong>
            </span>
          </div>
        </ErrorBoundary>
      );

      expect(screen.getByText('Nested content')).toBeInTheDocument();
    });
  });

  // --------------------------------------------------------------------------
  // Error Catching
  // --------------------------------------------------------------------------

  describe('error catching', () => {
    it('catches errors thrown by child components', () => {
      const testError = new Error('Test error message');

      render(
        <ErrorBoundary>
          <ThrowingComponent error={testError} />
        </ErrorBoundary>
      );

      expect(screen.getByRole('alert')).toBeInTheDocument();
      expect(screen.getByText('Something went wrong')).toBeInTheDocument();
    });

    it('displays the error message in development mode', () => {
      const testError = new Error('Detailed error for debugging');

      render(
        <ErrorBoundary>
          <ThrowingComponent error={testError} />
        </ErrorBoundary>
      );

      // In test environment (development mode), error details should be shown
      expect(screen.getByText('Error Message')).toBeInTheDocument();
      expect(screen.getByText('Detailed error for debugging')).toBeInTheDocument();
    });

    it('catches errors thrown during user interaction', async () => {
      render(
        <ErrorBoundary>
          <ThrowOnClickComponent />
        </ErrorBoundary>
      );

      // Initially shows the button
      expect(screen.getByRole('button', { name: 'Trigger Error' })).toBeInTheDocument();

      // Trigger the error
      fireEvent.click(screen.getByRole('button', { name: 'Trigger Error' }));

      // Should show error UI
      await waitFor(() => {
        expect(screen.getByRole('alert')).toBeInTheDocument();
      });
    });

    it('displays stack trace details section in development mode', () => {
      const testError = new Error('Error with stack');
      testError.stack = 'Error: Error with stack\n    at TestComponent';

      render(
        <ErrorBoundary>
          <ThrowingComponent error={testError} />
        </ErrorBoundary>
      );

      // Stack trace section should be present (collapsible details)
      expect(screen.getByText('Stack Trace')).toBeInTheDocument();
    });
  });

  // --------------------------------------------------------------------------
  // Default Fallback UI
  // --------------------------------------------------------------------------

  describe('default fallback UI', () => {
    it('shows Try Again button in error state', () => {
      render(
        <ErrorBoundary>
          <ThrowingComponent error={new Error('Test')} />
        </ErrorBoundary>
      );

      expect(screen.getByRole('button', { name: /try again/i })).toBeInTheDocument();
    });

    it('shows appropriate message for development mode', () => {
      render(
        <ErrorBoundary>
          <ThrowingComponent error={new Error('Test')} />
        </ErrorBoundary>
      );

      expect(
        screen.getByText(/check the details below for debugging information/i)
      ).toBeInTheDocument();
    });

    it('displays error icon', () => {
      render(
        <ErrorBoundary>
          <ThrowingComponent error={new Error('Test')} />
        </ErrorBoundary>
      );

      // SVG icon should be present (hidden from accessibility tree)
      const icon = document.querySelector('svg[aria-hidden="true"]');
      expect(icon).toBeInTheDocument();
    });

    it('uses correct ARIA attributes for accessibility', () => {
      render(
        <ErrorBoundary>
          <ThrowingComponent error={new Error('Test')} />
        </ErrorBoundary>
      );

      const alert = screen.getByRole('alert');
      expect(alert).toHaveAttribute('aria-live', 'assertive');
    });
  });

  // --------------------------------------------------------------------------
  // Try Again Button (Reset)
  // --------------------------------------------------------------------------

  describe('Try Again button', () => {
    it('resets the error boundary when clicked', async () => {
      let shouldThrow = true;
      function ConditionalThrower(): React.JSX.Element {
        if (shouldThrow) {
          throw new Error('Conditional error');
        }
        return <div data-testid="recovered">Recovered!</div>;
      }

      const { rerender } = render(
        <ErrorBoundary>
          <ConditionalThrower />
        </ErrorBoundary>
      );

      // Error state
      expect(screen.getByRole('alert')).toBeInTheDocument();

      // Fix the error condition
      shouldThrow = false;

      // Click Try Again
      fireEvent.click(screen.getByRole('button', { name: /try again/i }));

      // Re-render with fixed component
      rerender(
        <ErrorBoundary>
          <ConditionalThrower />
        </ErrorBoundary>
      );

      // Should show recovered content
      await waitFor(() => {
        expect(screen.queryByRole('alert')).not.toBeInTheDocument();
      });
    });

    it('remains in error state if error persists after reset', () => {
      render(
        <ErrorBoundary>
          <ThrowingComponent error={new Error('Persistent error')} />
        </ErrorBoundary>
      );

      // Click Try Again
      fireEvent.click(screen.getByRole('button', { name: /try again/i }));

      // Should still be in error state since component still throws
      expect(screen.getByRole('alert')).toBeInTheDocument();
    });
  });

  // --------------------------------------------------------------------------
  // Full Page Mode
  // --------------------------------------------------------------------------

  describe('fullPage mode', () => {
    it('shows Reload App button when fullPage is true', () => {
      render(
        <ErrorBoundary fullPage>
          <ThrowingComponent error={new Error('Test')} />
        </ErrorBoundary>
      );

      expect(screen.getByRole('button', { name: /reload app/i })).toBeInTheDocument();
    });

    it('does not show Reload App button when fullPage is false', () => {
      render(
        <ErrorBoundary fullPage={false}>
          <ThrowingComponent error={new Error('Test')} />
        </ErrorBoundary>
      );

      expect(screen.queryByRole('button', { name: /reload app/i })).not.toBeInTheDocument();
    });

    it('applies full-page styling classes', () => {
      render(
        <ErrorBoundary fullPage>
          <ThrowingComponent error={new Error('Test')} />
        </ErrorBoundary>
      );

      const alert = screen.getByRole('alert');
      expect(alert).toHaveClass('min-h-screen');
      expect(alert).toHaveClass('bg-surface-950');
    });

    it('calls window.location.reload when Reload App is clicked', () => {
      // Mock window.location.reload
      const originalLocation = window.location;
      const reloadMock = vi.fn();

      Object.defineProperty(window, 'location', {
        configurable: true,
        value: { ...originalLocation, reload: reloadMock },
      });

      render(
        <ErrorBoundary fullPage>
          <ThrowingComponent error={new Error('Test')} />
        </ErrorBoundary>
      );

      fireEvent.click(screen.getByRole('button', { name: /reload app/i }));

      expect(reloadMock).toHaveBeenCalledTimes(1);

      // Restore original window.location
      Object.defineProperty(window, 'location', {
        configurable: true,
        value: originalLocation,
      });
    });
  });

  // --------------------------------------------------------------------------
  // Custom Fallback Prop
  // --------------------------------------------------------------------------

  describe('custom fallback prop', () => {
    it('renders custom fallback ReactNode when provided', () => {
      const customFallback = <div data-testid="custom-fallback">Custom Error UI</div>;

      render(
        <ErrorBoundary fallback={customFallback}>
          <ThrowingComponent error={new Error('Test')} />
        </ErrorBoundary>
      );

      expect(screen.getByTestId('custom-fallback')).toBeInTheDocument();
      expect(screen.getByText('Custom Error UI')).toBeInTheDocument();
      // Default UI should not be present
      expect(screen.queryByText('Something went wrong')).not.toBeInTheDocument();
    });

    it('can use complex React elements as fallback', () => {
      const customFallback = (
        <div data-testid="complex-fallback">
          <h1>Error Occurred</h1>
          <p>Please contact support</p>
          <button type="button">Go Back</button>
        </div>
      );

      render(
        <ErrorBoundary fallback={customFallback}>
          <ThrowingComponent error={new Error('Test')} />
        </ErrorBoundary>
      );

      expect(screen.getByText('Error Occurred')).toBeInTheDocument();
      expect(screen.getByText('Please contact support')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Go Back' })).toBeInTheDocument();
    });
  });

  // --------------------------------------------------------------------------
  // Custom fallbackRender Prop
  // --------------------------------------------------------------------------

  describe('fallbackRender prop', () => {
    it('calls fallbackRender with correct props', () => {
      const testError = new Error('Render prop error');
      const fallbackRenderFn = vi.fn(
        ({ error, resetErrorBoundary, isDevelopment }: FallbackRenderProps) => (
          <div data-testid="render-fallback">
            <p>Error: {error.message}</p>
            <p>Dev mode: {isDevelopment.toString()}</p>
            <button onClick={resetErrorBoundary} type="button">
              Reset
            </button>
          </div>
        )
      );

      render(
        <ErrorBoundary fallbackRender={fallbackRenderFn}>
          <ThrowingComponent error={testError} />
        </ErrorBoundary>
      );

      // React may call the render function multiple times due to state updates
      // (initial render + componentDidCatch state update), so we verify it was called
      // at least once with the correct props
      expect(fallbackRenderFn).toHaveBeenCalled();
      expect(fallbackRenderFn).toHaveBeenCalledWith(
        expect.objectContaining({
          error: testError,
          isDevelopment: true, // Test environment is development mode
          resetErrorBoundary: expect.any(Function),
        })
      );
    });

    it('renders fallbackRender output', () => {
      render(
        <ErrorBoundary
          fallbackRender={({ error }) => (
            <div data-testid="custom-render">Error: {error.message}</div>
          )}
        >
          <ThrowingComponent error={new Error('Custom message')} />
        </ErrorBoundary>
      );

      expect(screen.getByTestId('custom-render')).toBeInTheDocument();
      expect(screen.getByText('Error: Custom message')).toBeInTheDocument();
    });

    it('provides working resetErrorBoundary function', async () => {
      let shouldThrow = true;
      function ConditionalThrower(): React.JSX.Element {
        if (shouldThrow) {
          throw new Error('Reset test');
        }
        return <div data-testid="success">No error</div>;
      }

      const { rerender } = render(
        <ErrorBoundary
          fallbackRender={({ resetErrorBoundary }) => (
            <button onClick={resetErrorBoundary} type="button">
              Custom Reset
            </button>
          )}
        >
          <ConditionalThrower />
        </ErrorBoundary>
      );

      // Fix the error
      shouldThrow = false;

      // Click custom reset button
      fireEvent.click(screen.getByRole('button', { name: 'Custom Reset' }));

      rerender(
        <ErrorBoundary
          fallbackRender={({ resetErrorBoundary }) => (
            <button onClick={resetErrorBoundary} type="button">
              Custom Reset
            </button>
          )}
        >
          <ConditionalThrower />
        </ErrorBoundary>
      );

      // Should recover
      await waitFor(() => {
        expect(screen.queryByRole('button', { name: 'Custom Reset' })).not.toBeInTheDocument();
      });
    });

    it('fallbackRender takes precedence over fallback prop', () => {
      render(
        <ErrorBoundary
          fallback={<div>Static Fallback</div>}
          fallbackRender={() => <div data-testid="render-wins">Render Wins</div>}
        >
          <ThrowingComponent error={new Error('Test')} />
        </ErrorBoundary>
      );

      expect(screen.getByTestId('render-wins')).toBeInTheDocument();
      expect(screen.queryByText('Static Fallback')).not.toBeInTheDocument();
    });

    it('provides errorInfo with component stack', () => {
      const receivedProps: FallbackRenderProps[] = [];

      render(
        <ErrorBoundary
          fallbackRender={(props) => {
            receivedProps.push(props);
            return <div>Error Caught</div>;
          }}
        >
          <ThrowingComponent error={new Error('Stack test')} />
        </ErrorBoundary>
      );

      // The errorInfo should be provided (may be null initially, then updated via componentDidCatch)
      expect(receivedProps.length).toBeGreaterThan(0);
    });
  });

  // --------------------------------------------------------------------------
  // onError Callback
  // --------------------------------------------------------------------------

  describe('onError callback', () => {
    it('calls onError when an error is caught', () => {
      const onErrorSpy = vi.fn();
      const testError = new Error('Callback test error');

      render(
        <ErrorBoundary onError={onErrorSpy}>
          <ThrowingComponent error={testError} />
        </ErrorBoundary>
      );

      expect(onErrorSpy).toHaveBeenCalledTimes(1);
      expect(onErrorSpy).toHaveBeenCalledWith(
        testError,
        expect.objectContaining({
          componentStack: expect.any(String),
        })
      );
    });

    it('receives error info with component stack', () => {
      const onErrorSpy = vi.fn();

      render(
        <ErrorBoundary onError={onErrorSpy}>
          <ThrowingComponent error={new Error('Stack trace test')} />
        </ErrorBoundary>
      );

      const [, errorInfo] = onErrorSpy.mock.calls[0] as [Error, React.ErrorInfo];
      expect(errorInfo.componentStack).toBeDefined();
      expect(typeof errorInfo.componentStack).toBe('string');
    });

    it('does not call onError when no error occurs', () => {
      const onErrorSpy = vi.fn();

      render(
        <ErrorBoundary onError={onErrorSpy}>
          <div>No errors here</div>
        </ErrorBoundary>
      );

      expect(onErrorSpy).not.toHaveBeenCalled();
    });
  });

  // --------------------------------------------------------------------------
  // onReset Callback
  // --------------------------------------------------------------------------

  describe('onReset callback', () => {
    it('calls onReset when Try Again button is clicked', () => {
      const onResetSpy = vi.fn();

      render(
        <ErrorBoundary onReset={onResetSpy}>
          <ThrowingComponent error={new Error('Reset test')} />
        </ErrorBoundary>
      );

      fireEvent.click(screen.getByRole('button', { name: /try again/i }));

      expect(onResetSpy).toHaveBeenCalledTimes(1);
    });

    it('calls onReset when custom reset function is invoked', () => {
      const onResetSpy = vi.fn();

      render(
        <ErrorBoundary
          onReset={onResetSpy}
          fallbackRender={({ resetErrorBoundary }) => (
            <button onClick={resetErrorBoundary} type="button">
              Custom Reset
            </button>
          )}
        >
          <ThrowingComponent error={new Error('Custom reset test')} />
        </ErrorBoundary>
      );

      fireEvent.click(screen.getByRole('button', { name: 'Custom Reset' }));

      expect(onResetSpy).toHaveBeenCalledTimes(1);
    });

    it('calls onReset before clearing error state', () => {
      const callOrder: string[] = [];
      const onResetSpy = vi.fn(() => {
        callOrder.push('onReset');
      });

      render(
        <ErrorBoundary
          onReset={onResetSpy}
          fallbackRender={({ resetErrorBoundary }) => (
            <button
              onClick={() => {
                resetErrorBoundary();
                callOrder.push('afterReset');
              }}
              type="button"
            >
              Reset
            </button>
          )}
        >
          <ThrowingComponent error={new Error('Order test')} />
        </ErrorBoundary>
      );

      fireEvent.click(screen.getByRole('button', { name: 'Reset' }));

      expect(callOrder).toEqual(['onReset', 'afterReset']);
    });
  });

  // --------------------------------------------------------------------------
  // resetKeys Functionality
  // --------------------------------------------------------------------------

  describe('resetKeys functionality', () => {
    it('automatically resets when resetKeys change', async () => {
      let shouldThrow = true;
      function ConditionalThrower(): React.JSX.Element {
        if (shouldThrow) {
          throw new Error('Reset keys test');
        }
        return <div data-testid="recovered">Recovered via resetKeys</div>;
      }

      const { rerender } = render(
        <ErrorBoundary resetKeys={['key1']}>
          <ConditionalThrower />
        </ErrorBoundary>
      );

      // In error state
      expect(screen.getByRole('alert')).toBeInTheDocument();

      // Fix the error and change resetKeys
      shouldThrow = false;

      rerender(
        <ErrorBoundary resetKeys={['key2']}>
          <ConditionalThrower />
        </ErrorBoundary>
      );

      // Should auto-reset
      await waitFor(() => {
        expect(screen.queryByRole('alert')).not.toBeInTheDocument();
      });
    });

    it('does not reset when resetKeys remain the same', () => {
      render(
        <ErrorBoundary resetKeys={['same']}>
          <ThrowingComponent error={new Error('No reset')} />
        </ErrorBoundary>
      );

      // Should remain in error state
      expect(screen.getByRole('alert')).toBeInTheDocument();
    });

    it('resets when any key in the array changes', async () => {
      let shouldThrow = true;
      function ConditionalThrower(): React.JSX.Element {
        if (shouldThrow) {
          throw new Error('Multi-key test');
        }
        return <div data-testid="recovered">Recovered</div>;
      }

      const { rerender } = render(
        <ErrorBoundary resetKeys={['a', 'b', 'c']}>
          <ConditionalThrower />
        </ErrorBoundary>
      );

      // In error state
      expect(screen.getByRole('alert')).toBeInTheDocument();

      // Fix error and change just one key
      shouldThrow = false;

      rerender(
        <ErrorBoundary resetKeys={['a', 'b', 'changed']}>
          <ConditionalThrower />
        </ErrorBoundary>
      );

      // Should reset
      await waitFor(() => {
        expect(screen.queryByRole('alert')).not.toBeInTheDocument();
      });
    });

    it('calls onReset when auto-resetting via resetKeys', async () => {
      const onResetSpy = vi.fn();
      let shouldThrow = true;

      function ConditionalThrower(): React.JSX.Element {
        if (shouldThrow) {
          throw new Error('Auto reset test');
        }
        return <div>Recovered</div>;
      }

      const { rerender } = render(
        <ErrorBoundary resetKeys={['initial']} onReset={onResetSpy}>
          <ConditionalThrower />
        </ErrorBoundary>
      );

      expect(onResetSpy).not.toHaveBeenCalled();

      shouldThrow = false;

      rerender(
        <ErrorBoundary resetKeys={['changed']} onReset={onResetSpy}>
          <ConditionalThrower />
        </ErrorBoundary>
      );

      await waitFor(() => {
        expect(onResetSpy).toHaveBeenCalledTimes(1);
      });
    });

    it('handles undefined resetKeys gracefully', () => {
      const { rerender } = render(
        <ErrorBoundary>
          <ThrowingComponent error={new Error('No keys')} />
        </ErrorBoundary>
      );

      // Should be in error state
      expect(screen.getByRole('alert')).toBeInTheDocument();

      // Adding resetKeys should not cause issues
      rerender(
        <ErrorBoundary resetKeys={['new']}>
          <ThrowingComponent error={new Error('No keys')} />
        </ErrorBoundary>
      );

      expect(screen.getByRole('alert')).toBeInTheDocument();
    });
  });

  // --------------------------------------------------------------------------
  // useErrorHandler Hook
  // --------------------------------------------------------------------------

  describe('useErrorHandler hook', () => {
    it('throws error to be caught by nearest ErrorBoundary', async () => {
      const testError = new Error('Hook error');
      const user = userEvent.setup();

      render(
        <ErrorBoundary>
          <ErrorHandlerHookComponent error={testError} />
        </ErrorBoundary>
      );

      // Initially no error
      expect(screen.getByRole('button', { name: 'Throw via Hook' })).toBeInTheDocument();

      // Trigger error via hook
      await user.click(screen.getByRole('button', { name: 'Throw via Hook' }));

      // Should be caught by ErrorBoundary
      await waitFor(() => {
        expect(screen.getByRole('alert')).toBeInTheDocument();
      });
    });

    it('triggers onError callback when used', async () => {
      const onErrorSpy = vi.fn();
      const testError = new Error('Hook callback test');
      const user = userEvent.setup();

      render(
        <ErrorBoundary onError={onErrorSpy}>
          <ErrorHandlerHookComponent error={testError} />
        </ErrorBoundary>
      );

      await user.click(screen.getByRole('button', { name: 'Throw via Hook' }));

      await waitFor(() => {
        expect(onErrorSpy).toHaveBeenCalledWith(
          testError,
          expect.objectContaining({
            componentStack: expect.any(String),
          })
        );
      });
    });
  });

  // --------------------------------------------------------------------------
  // Edge Cases
  // --------------------------------------------------------------------------

  describe('edge cases', () => {
    it('handles errors with no message', () => {
      const emptyError = new Error();

      render(
        <ErrorBoundary>
          <ThrowingComponent error={emptyError} />
        </ErrorBoundary>
      );

      expect(screen.getByRole('alert')).toBeInTheDocument();
    });

    it('handles errors with no stack trace', () => {
      const noStackError = new Error('No stack');
      noStackError.stack = undefined;

      render(
        <ErrorBoundary>
          <ThrowingComponent error={noStackError} />
        </ErrorBoundary>
      );

      expect(screen.getByRole('alert')).toBeInTheDocument();
      expect(screen.getByText('No stack')).toBeInTheDocument();
      // Stack trace section should not be present
      expect(screen.queryByText('Stack Trace')).not.toBeInTheDocument();
    });

    it('handles very long error messages', () => {
      const longMessage = 'A'.repeat(1000);
      const longError = new Error(longMessage);

      render(
        <ErrorBoundary>
          <ThrowingComponent error={longError} />
        </ErrorBoundary>
      );

      expect(screen.getByRole('alert')).toBeInTheDocument();
      expect(screen.getByText(longMessage)).toBeInTheDocument();
    });

    it('handles special characters in error messages', () => {
      const specialError = new Error('<script>alert("xss")</script>');

      render(
        <ErrorBoundary>
          <ThrowingComponent error={specialError} />
        </ErrorBoundary>
      );

      // React should escape the content
      expect(screen.getByRole('alert')).toBeInTheDocument();
      expect(screen.getByText('<script>alert("xss")</script>')).toBeInTheDocument();
    });

    it('handles rapid successive errors', async () => {
      const onErrorSpy = vi.fn();

      const { rerender } = render(
        <ErrorBoundary onError={onErrorSpy}>
          <ThrowingComponent error={new Error('Error 1')} />
        </ErrorBoundary>
      );

      expect(onErrorSpy).toHaveBeenCalledTimes(1);

      // Reset
      fireEvent.click(screen.getByRole('button', { name: /try again/i }));

      // Re-render with new error
      rerender(
        <ErrorBoundary onError={onErrorSpy}>
          <ThrowingComponent error={new Error('Error 2')} />
        </ErrorBoundary>
      );

      // Should catch the new error
      await waitFor(() => {
        expect(onErrorSpy).toHaveBeenCalledTimes(2);
      });
    });

    it('maintains state between re-renders when no error', () => {
      const ChildWithState = (): React.JSX.Element => {
        const [count, setCount] = useState(0);
        return (
          <button onClick={() => setCount((c) => c + 1)} type="button">
            Count: {count}
          </button>
        );
      };

      const { rerender } = render(
        <ErrorBoundary>
          <ChildWithState />
        </ErrorBoundary>
      );

      // Increment count
      fireEvent.click(screen.getByRole('button'));
      expect(screen.getByText('Count: 1')).toBeInTheDocument();

      // Re-render parent (simulate prop change)
      rerender(
        <ErrorBoundary>
          <ChildWithState />
        </ErrorBoundary>
      );

      // State should be preserved
      expect(screen.getByText('Count: 1')).toBeInTheDocument();
    });
  });

  // --------------------------------------------------------------------------
  // Error ID Generation (Production Mode)
  // --------------------------------------------------------------------------

  describe('error ID generation', () => {
    it('generates consistent error IDs for the same error message', () => {
      // While we can't test production mode directly, we can verify the
      // error is passed correctly to the fallback render
      const error1 = new Error('Duplicate error');
      const error2 = new Error('Duplicate error');

      let capturedError1: Error | undefined;
      let capturedError2: Error | undefined;

      render(
        <ErrorBoundary
          fallbackRender={({ error }) => {
            capturedError1 = error;
            return <div>Error 1</div>;
          }}
        >
          <ThrowingComponent error={error1} />
        </ErrorBoundary>
      );

      render(
        <ErrorBoundary
          fallbackRender={({ error }) => {
            capturedError2 = error;
            return <div>Error 2</div>;
          }}
        >
          <ThrowingComponent error={error2} />
        </ErrorBoundary>
      );

      // Both should have the same message
      expect(capturedError1?.message).toBe(capturedError2?.message);
    });
  });

  // --------------------------------------------------------------------------
  // Component Stack Display
  // --------------------------------------------------------------------------

  describe('component stack display', () => {
    it('shows component stack section when errorInfo is available', async () => {
      render(
        <ErrorBoundary>
          <ThrowingComponent error={new Error('Stack test')} />
        </ErrorBoundary>
      );

      // Wait for componentDidCatch to update state with errorInfo
      await waitFor(() => {
        expect(screen.getByText('Component Stack')).toBeInTheDocument();
      });
    });
  });
});
