import { useSyncExternalStore } from 'react';
import { browserDecisionPolicy } from '../lib/decision-policy';

export function DecisionPolicyNotice() {
  const state = useSyncExternalStore(browserDecisionPolicy.subscribe, browserDecisionPolicy.snapshot, () => undefined);
  if (state?.operation !== 'classic') return null;
  return <div role="status" className="px-4 py-2 text-sm border-b border-border text-muted-foreground">
    {state.reason === 'selected' ? 'Classic - Off: decision models are disabled.'
      : 'Preferred: decision models were unavailable; this operation used Classic.'}
    {' '}Tools follow owner permission rules. Responses have no independent semantic verification.
  </div>;
}
