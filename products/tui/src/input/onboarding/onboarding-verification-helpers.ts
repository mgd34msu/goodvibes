import { isLoopbackHost } from '@goodvibes-jev/engine/terminal-shell';
import type { OnboardingVerificationItem } from '../../runtime/onboarding/index.ts';

/**
 * The platform's one loopback rule (localhost, *.localhost, 127.0.0.0/8, ::1 in
 * any spelling), so onboarding agrees with `goodvibes status` about which binds
 * are local. Null, undefined and empty values are not loopback.
 */
export function isLoopbackHostValue(value: string | null | undefined): boolean {
  return isLoopbackHost(value ?? undefined);
}

/** Priority rank used when de-duplicating verification items by id. */
function onboardingVerificationStatusRank(item: OnboardingVerificationItem): number {
  if (item.status === 'fail') return 3;
  if (item.status === 'warn') return 2;
  return 1;
}

/**
 * Collapse a list of OnboardingVerificationItem entries so that each unique id
 * appears at most once, keeping the highest-severity status when duplicates exist.
 */
export function dedupeOnboardingVerificationItems(
  items: readonly OnboardingVerificationItem[],
): OnboardingVerificationItem[] {
  const order: string[] = [];
  const byId = new Map<string, OnboardingVerificationItem>();
  for (const item of items) {
    const existing = byId.get(item.id);
    if (!existing) {
      order.push(item.id);
      byId.set(item.id, item);
      continue;
    }
    if (onboardingVerificationStatusRank(item) > onboardingVerificationStatusRank(existing)) {
      byId.set(item.id, item);
    }
  }
  return order.map((id) => byId.get(id)).filter((item): item is OnboardingVerificationItem => Boolean(item));
}

/**
 * Format a human-readable summary of an onboarding apply operation given the
 * list of verification items returned after the apply completed.
 */
export function formatOnboardingApplyCompletionMessage(items: readonly OnboardingVerificationItem[]): string {
  const warnings = items.filter((item) => item.status === 'warn');
  if (warnings.length === 0) return `Onboarding applied and verified ${items.length} item(s).`;
  const passed = items.filter((item) => item.status === 'pass').length;
  return [
    `Onboarding settings applied. ${passed} verification item(s) passed; ${warnings.length} warning(s) need attention.`,
    ...warnings.map((warning) => `  warning ${warning.id}: ${warning.message}`),
  ].join('\n');
}
