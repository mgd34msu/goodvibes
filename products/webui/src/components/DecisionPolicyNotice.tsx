import { useSyncExternalStore } from 'react';
import { BrainCircuit, TriangleAlert } from 'lucide-react';
import { decisionModelUse } from '@goodvibes-jev/engine/platform/browser/decision-policy';
import { browserDecisionPolicy } from '../lib/decision-policy';
import { Menu, MenuItem, MenuMeta } from './ui/Menu';
import '../styles/components/status.css';

/**
 * The standing indication, a chip in the shell header's indicator slot: shown
 * whenever the daemon reports that no decision model is in use. The chip names
 * the state in two words; opening it shows the daemon's sentence (why, and what
 * to do) and a way to the decision-model settings. A set model that is failing
 * is a warning chip announced as an alert.
 */
export function DecisionPolicyNotice({ onOpenSettings }: { onOpenSettings: (section: string) => void }) {
  const state = useSyncExternalStore(browserDecisionPolicy.subscribe, browserDecisionPolicy.snapshot, () => undefined);
  if (state === undefined) return null;
  const use = decisionModelUse(state);
  if (use.inUse) return null;
  const failing = use.failure !== undefined || use.reason === 'unavailable';
  const label = failing ? 'Decision model failing' : 'No decision model';
  return (
    <Menu
      label="Decision model"
      placement="bottom-end"
      width={280}
      trigger={(props) => (
        <button
          type="button"
          {...props}
          role={failing ? 'alert' : undefined}
          aria-label={`${label}: ${use.line}`}
          title={use.line}
          className={`status-strip__segment status-strip__segment--button${failing ? ' status-strip__segment--compatibility-warning' : ''}`}
        >
          {failing
            ? <TriangleAlert className="status-strip__icon" aria-hidden="true" size={12} />
            : <BrainCircuit className="status-strip__icon" aria-hidden="true" size={12} />}
          <span className="status-strip__label">{label}</span>
        </button>
      )}
    >
      <MenuMeta>{use.line}</MenuMeta>
      <MenuItem onSelect={() => onOpenSettings('models')}>Decision model settings</MenuItem>
    </Menu>
  );
}
