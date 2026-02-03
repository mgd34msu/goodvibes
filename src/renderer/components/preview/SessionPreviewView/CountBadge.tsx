// ============================================================================
// COUNT BADGE COMPONENT
// ============================================================================

import { clsx } from 'clsx';
import type { SessionEntryType } from '../../../../shared/types';
import { getTypeConfig } from './utils';

export function CountBadge({ type, count }: { type: SessionEntryType; count: number }): React.JSX.Element {
  const config = getTypeConfig(type);
  return (
    <span className={clsx('px-1.5 py-0.5 rounded text-xs', config.badgeBg, config.badgeText)}>
      {count} {config.label.toLowerCase()}
    </span>
  );
}
