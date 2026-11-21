import type { AgentWorkspaceAction, AgentWorkspaceCategory } from './agent-workspace-types.ts';

export const ONBOARDING_COMPLETE_SYNTHETIC_ACTION: AgentWorkspaceAction = {
  id: 'onboarding-apply-close',
  label: 'Apply & close',
  detail: 'Marks setup finished when a model answers, so later starts open the conversation, and closes the workspace. When no model answers yet it says what is missing and setup stays open.',
  kind: 'onboarding-complete',
  safety: 'safe',
};

export function shouldShowOnboardingFinishFooter(
  category: AgentWorkspaceCategory,
  baseActions: readonly AgentWorkspaceAction[],
  readyToChat?: boolean,
): boolean {
  if (category.group !== 'ONBOARDING') return false;
  if (baseActions.some((a) => a.kind === 'onboarding-complete')) return false;
  // When readyToChat is explicitly false (we have a valid OnboardingState and the user
  // cannot chat yet), withhold the footer so completion is not premature.
  // When readyToChat is undefined (no OnboardingState available), default to showing.
  if (readyToChat === false) return false;
  return true;
}
