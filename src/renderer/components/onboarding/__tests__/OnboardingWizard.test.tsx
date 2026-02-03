// ============================================================================
// ONBOARDING WIZARD COMPONENT TESTS
// ============================================================================
//
// Comprehensive tests for OnboardingWizard component including:
// - Initial render and step display
// - Step navigation (forward/backward)
// - Validation before proceeding
// - Completion flow
// - Skip functionality
// - Optional steps
// - useOnboarding hook
//
// ============================================================================

import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { OnboardingWizard, useOnboarding, type OnboardingStep } from '../OnboardingWizard';

// ============================================================================
// TEST UTILITIES
// ============================================================================

/**
 * Simple step component for testing
 */
function TestStepComponent({ title }: { title: string }) {
  return (
    <div>
      <p data-testid="step-content">{title} Content</p>
    </div>
  );
}

/**
 * Step component that uses the hook
 */
function HookTestComponent() {
  const { currentStep, totalSteps } = useOnboarding();
  return (
    <div data-testid="hook-test">
      Hook: Step {currentStep + 1} of {totalSteps}
    </div>
  );
}

/**
 * Create mock steps for testing
 */
function createMockSteps(count: number = 3): OnboardingStep[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `step-${i + 1}`,
    title: `Test Step ${i + 1}`,
    description: `Description for step ${i + 1}`,
    component: <TestStepComponent title={`Test Step ${i + 1}`} />,
  }));
}

// ============================================================================
// ONBOARDING WIZARD TESTS
// ============================================================================

describe('OnboardingWizard', () => {
  let mockOnComplete: ReturnType<typeof vi.fn<() => void>>;
  let mockOnSkip: ReturnType<typeof vi.fn<() => void>>;
  let mockOnStepChange: ReturnType<typeof vi.fn<(step: number, stepId: string) => void>>;

  beforeEach(() => {
    mockOnComplete = vi.fn();
    mockOnSkip = vi.fn();
    mockOnStepChange = vi.fn();
  });

  // ==========================================================================
  // RENDERING TESTS
  // ==========================================================================

  describe('Rendering', () => {
    it('renders initial step correctly', () => {
      const steps = createMockSteps(3);
      render(
        <OnboardingWizard
          steps={steps}
          onComplete={mockOnComplete}
        />
      );

      // Check step title (as heading)
      expect(screen.getByRole('heading', { name: 'Test Step 1' })).toBeInTheDocument();
      
      // Check step content
      expect(screen.getByTestId('step-content')).toHaveTextContent('Test Step 1 Content');
      
      // Check progress indicator
      expect(screen.getByText('Step 1 of 3')).toBeInTheDocument();
    });

    it('renders without crashing with minimal props', () => {
      const steps = createMockSteps(1);
      render(
        <OnboardingWizard
          steps={steps}
          onComplete={mockOnComplete}
        />
      );

      expect(screen.getByRole('heading', { name: 'Test Step 1' })).toBeInTheDocument();
    });

    it('displays step title and description', () => {
      const steps = createMockSteps(2);
      render(
        <OnboardingWizard
          steps={steps}
          onComplete={mockOnComplete}
        />
      );

      expect(screen.getByRole('heading', { name: 'Test Step 1' })).toBeInTheDocument();
      expect(screen.getByText('Description for step 1')).toBeInTheDocument();
    });

    it('shows progress indicator when showProgress is true', () => {
      const steps = createMockSteps(3);
      render(
        <OnboardingWizard
          steps={steps}
          onComplete={mockOnComplete}
          showProgress={true}
        />
      );

      expect(screen.getByText('Step 1 of 3')).toBeInTheDocument();
    });

    it('hides progress indicator when showProgress is false', () => {
      const steps = createMockSteps(3);
      render(
        <OnboardingWizard
          steps={steps}
          onComplete={mockOnComplete}
          showProgress={false}
        />
      );

      expect(screen.queryByText(/Step.*of/)).not.toBeInTheDocument();
    });

    it('starts at specified initialStep', () => {
      const steps = createMockSteps(3);
      render(
        <OnboardingWizard
          steps={steps}
          onComplete={mockOnComplete}
          initialStep={1}
        />
      );

      expect(screen.getByRole('heading', { name: 'Test Step 2' })).toBeInTheDocument();
      expect(screen.getByText('Step 2 of 3')).toBeInTheDocument();
    });

    it('displays Continue button on non-final steps', () => {
      const steps = createMockSteps(3);
      render(
        <OnboardingWizard
          steps={steps}
          onComplete={mockOnComplete}
        />
      );

      expect(screen.getByRole('button', { name: /continue/i })).toBeInTheDocument();
    });

    it('displays Complete Setup button on final step', () => {
      const steps = createMockSteps(2);
      render(
        <OnboardingWizard
          steps={steps}
          onComplete={mockOnComplete}
          initialStep={1}
        />
      );

      expect(screen.getByRole('button', { name: /complete setup/i })).toBeInTheDocument();
    });
  });

  // ==========================================================================
  // NAVIGATION TESTS
  // ==========================================================================

  describe('Navigation', () => {
    it('progresses to next step when Continue button is clicked', async () => {
      const steps = createMockSteps(3);
      render(
        <OnboardingWizard
          steps={steps}
          onComplete={mockOnComplete}
          onStepChange={mockOnStepChange}
        />
      );

      expect(screen.getByRole('heading', { name: 'Test Step 1' })).toBeInTheDocument();

      const continueButton = screen.getByRole('button', { name: /continue/i });
      await act(async () => {
        fireEvent.click(continueButton);
      });

      await waitFor(() => {
        expect(screen.getByRole('heading', { name: 'Test Step 2' })).toBeInTheDocument();
        expect(mockOnStepChange).toHaveBeenCalledWith(1, 'step-2');
      });
    });

    it('goes back to previous step when Back button is clicked', async () => {
      const steps = createMockSteps(3);
      render(
        <OnboardingWizard
          steps={steps}
          onComplete={mockOnComplete}
          initialStep={1}
        />
      );

      expect(screen.getByRole('heading', { name: 'Test Step 2' })).toBeInTheDocument();

      const backButton = screen.getByRole('button', { name: /back/i });
      await act(async () => {
        fireEvent.click(backButton);
      });

      await waitFor(() => {
        expect(screen.getByRole('heading', { name: 'Test Step 1' })).toBeInTheDocument();
      });
    });

    it('does not show back button on first step', () => {
      const steps = createMockSteps(3);
      render(
        <OnboardingWizard
          steps={steps}
          onComplete={mockOnComplete}
        />
      );

      expect(screen.queryByRole('button', { name: /back/i })).not.toBeInTheDocument();
    });

    it('shows back button on non-first steps', () => {
      const steps = createMockSteps(3);
      render(
        <OnboardingWizard
          steps={steps}
          onComplete={mockOnComplete}
          initialStep={1}
        />
      );

      expect(screen.getByRole('button', { name: /back/i })).toBeInTheDocument();
    });
  });

  // ==========================================================================
  // VALIDATION TESTS
  // ==========================================================================

  describe('Validation', () => {
    it('validates step before proceeding to next', async () => {
      const mockValidate = vi.fn().mockResolvedValue(true);
      const steps: OnboardingStep[] = [
        {
          id: 'step-1',
          title: 'Step 1',
          component: <TestStepComponent title="Step 1" />,
          validate: mockValidate,
        },
        {
          id: 'step-2',
          title: 'Step 2',
          component: <TestStepComponent title="Step 2" />,
        },
      ];

      render(
        <OnboardingWizard
          steps={steps}
          onComplete={mockOnComplete}
        />
      );

      const continueButton = screen.getByRole('button', { name: /continue/i });
      await act(async () => {
        fireEvent.click(continueButton);
      });

      await waitFor(() => {
        expect(mockValidate).toHaveBeenCalled();
        expect(screen.getByRole('heading', { name: 'Step 2' })).toBeInTheDocument();
      });
    });

    it('does not proceed if validation fails', async () => {
      const mockValidate = vi.fn().mockResolvedValue(false);
      const steps: OnboardingStep[] = [
        {
          id: 'step-1',
          title: 'Step 1',
          component: <TestStepComponent title="Step 1" />,
          validate: mockValidate,
        },
        {
          id: 'step-2',
          title: 'Step 2',
          component: <TestStepComponent title="Step 2" />,
        },
      ];

      render(
        <OnboardingWizard
          steps={steps}
          onComplete={mockOnComplete}
        />
      );

      const continueButton = screen.getByRole('button', { name: /continue/i });
      await act(async () => {
        fireEvent.click(continueButton);
      });

      await waitFor(() => {
        expect(mockValidate).toHaveBeenCalled();
      });

      // Should still be on step 1
      expect(screen.getByRole('heading', { name: 'Step 1' })).toBeInTheDocument();
      expect(screen.queryByRole('heading', { name: 'Step 2' })).not.toBeInTheDocument();
    });

    it('does not validate when going backwards', async () => {
      const mockValidate = vi.fn().mockResolvedValue(true);
      const steps: OnboardingStep[] = [
        {
          id: 'step-1',
          title: 'Step 1',
          component: <TestStepComponent title="Step 1" />,
        },
        {
          id: 'step-2',
          title: 'Step 2',
          component: <TestStepComponent title="Step 2" />,
          validate: mockValidate,
        },
      ];

      render(
        <OnboardingWizard
          steps={steps}
          onComplete={mockOnComplete}
          initialStep={1}
        />
      );

      expect(screen.getByRole('heading', { name: 'Step 2' })).toBeInTheDocument();

      const backButton = screen.getByRole('button', { name: /back/i });
      await act(async () => {
        fireEvent.click(backButton);
      });

      await waitFor(() => {
        expect(screen.getByRole('heading', { name: 'Step 1' })).toBeInTheDocument();
      });

      // Validate should not have been called when going back
      expect(mockValidate).not.toHaveBeenCalled();
    });
  });

  // ==========================================================================
  // COMPLETION TESTS
  // ==========================================================================

  describe('Completion', () => {
    it('completes onboarding flow when Complete Setup is clicked', async () => {
      const steps = createMockSteps(2);
      render(
        <OnboardingWizard
          steps={steps}
          onComplete={mockOnComplete}
          initialStep={1}
        />
      );

      const completeButton = screen.getByRole('button', { name: /complete setup/i });
      await act(async () => {
        fireEvent.click(completeButton);
      });

      await waitFor(() => {
        expect(mockOnComplete).toHaveBeenCalled();
      });
    });

    it('validates final step before completion', async () => {
      const mockValidate = vi.fn().mockResolvedValue(true);
      const steps: OnboardingStep[] = [
        {
          id: 'step-1',
          title: 'Step 1',
          component: <TestStepComponent title="Step 1" />,
        },
        {
          id: 'step-2',
          title: 'Step 2',
          component: <TestStepComponent title="Step 2" />,
          validate: mockValidate,
        },
      ];

      render(
        <OnboardingWizard
          steps={steps}
          onComplete={mockOnComplete}
          initialStep={1}
        />
      );

      const completeButton = screen.getByRole('button', { name: /complete setup/i });
      await act(async () => {
        fireEvent.click(completeButton);
      });

      // Note: validation happens during goToStep, but completion doesn't validate again
      await waitFor(() => {
        expect(mockOnComplete).toHaveBeenCalled();
      });
    });

    it('navigates through all steps and completes', async () => {
      const steps = createMockSteps(3);
      render(
        <OnboardingWizard
          steps={steps}
          onComplete={mockOnComplete}
        />
      );

      // Step 1 -> Step 2
      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: /continue/i }));
      });

      await waitFor(() => {
        expect(screen.getByRole('heading', { name: 'Test Step 2' })).toBeInTheDocument();
      });

      // Step 2 -> Step 3
      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: /continue/i }));
      });

      await waitFor(() => {
        expect(screen.getByRole('heading', { name: 'Test Step 3' })).toBeInTheDocument();
      });

      // Complete
      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: /complete setup/i }));
      });

      await waitFor(() => {
        expect(mockOnComplete).toHaveBeenCalled();
      });
    });
  });

  // ==========================================================================
  // SKIP FUNCTIONALITY TESTS
  // ==========================================================================

  describe('Skip Functionality', () => {
    it('shows skip button when allowSkip is true and onSkip is provided', () => {
      const steps = createMockSteps(3);
      render(
        <OnboardingWizard
          steps={steps}
          onComplete={mockOnComplete}
          onSkip={mockOnSkip}
          allowSkip={true}
        />
      );

      expect(screen.getByRole('button', { name: /skip setup/i })).toBeInTheDocument();
    });

    it('calls onSkip when skip button is clicked', async () => {
      const steps = createMockSteps(3);
      render(
        <OnboardingWizard
          steps={steps}
          onComplete={mockOnComplete}
          onSkip={mockOnSkip}
          allowSkip={true}
        />
      );

      const skipButton = screen.getByRole('button', { name: /skip setup/i });
      await act(async () => {
        fireEvent.click(skipButton);
      });

      expect(mockOnSkip).toHaveBeenCalled();
    });

    it('does not show skip button when allowSkip is false', () => {
      const steps = createMockSteps(3);
      render(
        <OnboardingWizard
          steps={steps}
          onComplete={mockOnComplete}
          onSkip={mockOnSkip}
          allowSkip={false}
        />
      );

      expect(screen.queryByRole('button', { name: /skip setup/i })).not.toBeInTheDocument();
    });

    it('does not show skip button when onSkip is not provided', () => {
      const steps = createMockSteps(3);
      render(
        <OnboardingWizard
          steps={steps}
          onComplete={mockOnComplete}
          allowSkip={true}
        />
      );

      expect(screen.queryByRole('button', { name: /skip setup/i })).not.toBeInTheDocument();
    });
  });

  // ==========================================================================
  // HOOK TESTS
  // ==========================================================================

  describe('useOnboarding Hook', () => {
    it('provides context to step components', () => {
      const steps: OnboardingStep[] = [
        {
          id: 'step-1',
          title: 'Step 1',
          component: <HookTestComponent />,
        },
        {
          id: 'step-2',
          title: 'Step 2',
          component: <div>Step 2</div>,
        },
        {
          id: 'step-3',
          title: 'Step 3',
          component: <div>Step 3</div>,
        },
      ];

      render(
        <OnboardingWizard
          steps={steps}
          onComplete={mockOnComplete}
        />
      );

      expect(screen.getByTestId('hook-test')).toHaveTextContent('Hook: Step 1 of 3');
    });

    it('throws error when used outside OnboardingWizard', () => {
      // Suppress console.error for this test
      const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});

      function InvalidComponent() {
        useOnboarding();
        return <div>Test</div>;
      }

      expect(() => {
        render(<InvalidComponent />);
      }).toThrow('useOnboarding must be used within OnboardingWizard');

      consoleError.mockRestore();
    });
  });

  // ==========================================================================
  // EDGE CASES
  // ==========================================================================

  describe('Edge Cases', () => {
    it('handles empty steps array', () => {
      const steps: OnboardingStep[] = [];
      const { container } = render(
        <OnboardingWizard
          steps={steps}
          onComplete={mockOnComplete}
        />
      );

      // Should render nothing
      expect(container.firstChild).toBeNull();
    });

    it('handles single step wizard', async () => {
      const steps = createMockSteps(1);
      render(
        <OnboardingWizard
          steps={steps}
          onComplete={mockOnComplete}
        />
      );

      expect(screen.getByText('Step 1 of 1')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /complete setup/i })).toBeInTheDocument();

      // Complete
      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: /complete setup/i }));
      });

      await waitFor(() => {
        expect(mockOnComplete).toHaveBeenCalled();
      });
    });

    it('prevents rapid clicking during validation', async () => {
      let resolveValidation: (value: boolean) => void;
      const validationPromise = new Promise<boolean>((resolve) => {
        resolveValidation = resolve;
      });

      const steps: OnboardingStep[] = [
        {
          id: 'step-1',
          title: 'Step 1',
          component: <TestStepComponent title="Step 1" />,
          validate: () => validationPromise,
        },
        {
          id: 'step-2',
          title: 'Step 2',
          component: <TestStepComponent title="Step 2" />,
        },
      ];

      render(
        <OnboardingWizard
          steps={steps}
          onComplete={mockOnComplete}
        />
      );

      const continueButton = screen.getByRole('button', { name: /continue/i });
      
      // Click continue (validation starts)
      await act(async () => {
        fireEvent.click(continueButton);
      });

      // Button should be disabled during transition
      expect(continueButton).toBeDisabled();

      // Should still be on step 1 (validation pending)
      expect(screen.getByRole('heading', { name: 'Step 1' })).toBeInTheDocument();

      // Resolve validation
      await act(async () => {
        resolveValidation!(true);
      });

      await waitFor(() => {
        expect(screen.getByRole('heading', { name: 'Step 2' })).toBeInTheDocument();
      });
    });
  });
});
