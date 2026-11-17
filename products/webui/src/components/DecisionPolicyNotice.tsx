import { useSyncExternalStore } from 'react';
import { decisionModelUse } from '@goodvibes-jev/engine/platform/browser/decision-policy';
import { browserDecisionPolicy } from '../lib/decision-policy';

/** The standing indication: shown whenever the daemon reports that no decision model is in use, and why. */
export function DecisionPolicyNotice() {
  const state = useSyncExternalStore(browserDecisionPolicy.subscribe, browserDecisionPolicy.snapshot, () => undefined);
  if (state === undefined) return null;
  const use = decisionModelUse(state);
  if (use.inUse) return null;
  return <div role={use.failure ? 'alert' : 'status'} className="px-4 py-2 text-sm border-b border-border text-muted-foreground">
    {use.line}
  </div>;
}
