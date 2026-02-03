// ============================================================================
// ONBOARDING WIZARD
// Multi-step wizard for initial setup
// ============================================================================

import { useState, useCallback, type ReactNode } from 'react';
import { clsx } from 'clsx';
import { ChevronLeft, ChevronRight, Check, X } from 'lucide-react';
import { FocusTrap } from '../common/FocusTrap';

// ============================================================================
// Types
// ============================================================================

export interface OnboardingStep {
  id: string;
  title: string;
  description?: string;
  component: ReactNode;
  isOptional?: boolean;
  canSkip?: boolean;
  validate?: () => boolean | Promise<boolean>;
}

export interface OnboardingWizardProps {
  steps: OnboardingStep[];
  onComplete: () => void;
  onSkip?: () => void;
  onStepChange?: (stepIndex: number, stepId: string) => void;
  initialStep?: number;
  allowSkip?: boolean;
  showProgress?: boolean;
  showStepList?: boolean;
  className?: string;
}

export interface OnboardingContextValue {
  currentStep: number;
  totalSteps: number;
  goNext: () => void;
  goPrev: () => void;
  goToStep: (index: number) => void;
  canGoNext: boolean;
  canGoPrev: boolean;
  isFirstStep: boolean;
  isLastStep: boolean;
  markStepComplete: (stepId: string) => void;
  isStepComplete: (stepId: string) => boolean;
}

// ============================================================================
// Context for Steps
// ============================================================================

import { createContext, useContext } from 'react';

const OnboardingContext = createContext<OnboardingContextValue | null>(null);

export function useOnboarding(): OnboardingContextValue {
  const context = useContext(OnboardingContext);
  if (!context) {
    throw new Error('useOnboarding must be used within OnboardingWizard');
  }
  return context;
}

// ============================================================================
// Component
// ============================================================================

export function OnboardingWizard({
  steps,
  onComplete,
  onSkip,
  onStepChange,
  initialStep = 0,
  allowSkip = true,
  showProgress = true,
  showStepList = true,
  className,
}: OnboardingWizardProps) {
  const [currentStep, setCurrentStep] = useState(initialStep);
  const [completedSteps, setCompletedSteps] = useState<Set<string>>(new Set());
  const [isTransitioning, setIsTransitioning] = useState(false);

  const totalSteps = steps.length;
  const step = steps[currentStep];
  const isFirstStep = currentStep === 0;
  const isLastStep = currentStep === totalSteps - 1;

  const markStepComplete = useCallback((stepId: string) => {
    setCompletedSteps((prev) => new Set([...prev, stepId]));
  }, []);

  const isStepComplete = useCallback(
    (stepId: string) => completedSteps.has(stepId),
    [completedSteps]
  );

  const goToStep = useCallback(
    async (index: number) => {
      if (index < 0 || index >= totalSteps || isTransitioning) return;

      const targetStep = steps[index];
      if (!targetStep) return;

      // Validate current step before leaving (if going forward)
      if (index > currentStep && step?.validate) {
        setIsTransitioning(true);
        const isValid = await step.validate();
        setIsTransitioning(false);

        if (!isValid) return;
      }

      setCurrentStep(index);
      onStepChange?.(index, targetStep.id);
    },
    [currentStep, totalSteps, steps, step, onStepChange, isTransitioning]
  );

  const goNext = useCallback(async () => {
    if (isLastStep) {
      // Mark final step complete and finish
      if (step) {
        markStepComplete(step.id);
      }
      onComplete();
    } else {
      // Mark current step complete
      if (step) {
        markStepComplete(step.id);
      }
      await goToStep(currentStep + 1);
    }
  }, [currentStep, isLastStep, step, goToStep, onComplete, markStepComplete]);

  const goPrev = useCallback(() => {
    if (!isFirstStep) {
      goToStep(currentStep - 1);
    }
  }, [currentStep, isFirstStep, goToStep]);

  const handleSkip = useCallback(() => {
    onSkip?.();
  }, [onSkip]);

  const contextValue: OnboardingContextValue = {
    currentStep,
    totalSteps,
    goNext,
    goPrev,
    goToStep,
    canGoNext: true,
    canGoPrev: !isFirstStep,
    isFirstStep,
    isLastStep,
    markStepComplete,
    isStepComplete,
  };

  if (!step) return null;

  return (
    <OnboardingContext.Provider value={contextValue}>
      <FocusTrap active>
        <div
          className={clsx(
            'fixed inset-0 z-[9999] flex items-center justify-center',
            'bg-surface-950/95 backdrop-blur-sm',
            className
          )}
          role="dialog"
          aria-modal="true"
          aria-label="Setup Wizard"
        >
          <div className="w-full max-w-3xl mx-4">
            {/* Header */}
            <div className="flex items-center justify-between mb-8">
              {/* Progress */}
              {showProgress && (
                <div className="flex items-center gap-4">
                  <span className="text-sm text-surface-400">
                    Step {currentStep + 1} of {totalSteps}
                  </span>
                  <div className="flex gap-1.5">
                    {steps.map((s, i) => (
                      <button
                        key={s.id}
                        onClick={() => i <= currentStep && goToStep(i)}
                        disabled={i > currentStep}
                        className={clsx(
                          'w-8 h-1.5 rounded-full transition-all',
                          i === currentStep
                            ? 'bg-primary-500'
                            : i < currentStep
                            ? 'bg-primary-500/50 hover:bg-primary-500/70 cursor-pointer'
                            : 'bg-surface-700'
                        )}
                        aria-label={`Go to step ${i + 1}: ${s.title}`}
                        aria-current={i === currentStep ? 'step' : undefined}
                      />
                    ))}
                  </div>
                </div>
              )}

              {/* Skip button */}
              {allowSkip && onSkip && (
                <button
                  onClick={handleSkip}
                  className="btn btn-ghost text-surface-400 hover:text-surface-200"
                >
                  Skip Setup
                  <X className="w-4 h-4 ml-1" />
                </button>
              )}
            </div>

            {/* Content Card */}
            <div className="card bg-surface-900 border border-surface-800 rounded-xl overflow-hidden">
              {/* Step List Sidebar */}
              {showStepList && (
                <div className="border-b border-surface-800 p-4">
                  <nav aria-label="Setup steps">
                    <ol className="flex items-center gap-2 overflow-x-auto">
                      {steps.map((s, i) => {
                        const isComplete = isStepComplete(s.id);
                        const isCurrent = i === currentStep;
                        const isPast = i < currentStep;

                        return (
                          <li key={s.id} className="flex items-center">
                            <button
                              onClick={() => isPast && goToStep(i)}
                              disabled={!isPast}
                              className={clsx(
                                'flex items-center gap-2 px-3 py-1.5 rounded-lg text-sm transition-colors',
                                isCurrent && 'bg-primary-500/20 text-primary-400',
                                isPast && 'text-surface-400 hover:text-surface-200 hover:bg-surface-800',
                                !isPast && !isCurrent && 'text-surface-600'
                              )}
                            >
                              <span
                                className={clsx(
                                  'w-5 h-5 rounded-full flex items-center justify-center text-xs',
                                  isCurrent && 'bg-primary-500 text-white',
                                  isComplete && !isCurrent && 'bg-success-500 text-white',
                                  !isComplete && !isCurrent && 'bg-surface-700 text-surface-400'
                                )}
                              >
                                {isComplete && !isCurrent ? (
                                  <Check className="w-3 h-3" />
                                ) : (
                                  i + 1
                                )}
                              </span>
                              <span className="hidden sm:inline whitespace-nowrap">{s.title}</span>
                            </button>
                            {i < steps.length - 1 && (
                              <ChevronRight className="w-4 h-4 text-surface-700 mx-1 flex-shrink-0" />
                            )}
                          </li>
                        );
                      })}
                    </ol>
                  </nav>
                </div>
              )}

              {/* Step Content */}
              <div className="p-8">
                {/* Step Header */}
                <div className="mb-6">
                  <h2 className="text-2xl font-semibold text-surface-100 mb-2">
                    {step.title}
                  </h2>
                  {step.description && (
                    <p className="text-surface-400">{step.description}</p>
                  )}
                </div>

                {/* Step Component */}
                <div className="min-h-[200px]">{step.component}</div>
              </div>

              {/* Footer */}
              <div className="flex items-center justify-between p-4 border-t border-surface-800 bg-surface-900/50">
                <div>
                  {!isFirstStep && (
                    <button
                      onClick={goPrev}
                      className="btn btn-ghost flex items-center gap-1"
                      disabled={isTransitioning}
                    >
                      <ChevronLeft className="w-4 h-4" />
                      Back
                    </button>
                  )}
                </div>

                <div className="flex items-center gap-3">
                  {step.canSkip && !isLastStep && (
                    <button
                      onClick={goNext}
                      className="btn btn-ghost text-surface-400"
                      disabled={isTransitioning}
                    >
                      Skip this step
                    </button>
                  )}

                  <button
                    onClick={goNext}
                    className="btn btn-primary flex items-center gap-1"
                    disabled={isTransitioning}
                  >
                    {isLastStep ? (
                      <>
                        Complete Setup
                        <Check className="w-4 h-4" />
                      </>
                    ) : (
                      <>
                        Continue
                        <ChevronRight className="w-4 h-4" />
                      </>
                    )}
                  </button>
                </div>
              </div>
            </div>
          </div>
        </div>
      </FocusTrap>
    </OnboardingContext.Provider>
  );
}

// ============================================================================
// Exports
// ============================================================================

export { OnboardingContext };
