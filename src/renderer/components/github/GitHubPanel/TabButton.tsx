// ============================================================================
// TAB BUTTON COMPONENT
// ============================================================================

import React from 'react';
import { clsx } from 'clsx';

interface TabButtonProps {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}

export function TabButton({ active, onClick, children }: TabButtonProps): React.JSX.Element {
  return (
    <button
      onClick={onClick}
      className={clsx(
        'px-4 py-2 text-xs font-medium border-b-2 -mb-px transition-colors',
        active
          ? 'text-primary-400 border-primary-400'
          : 'text-surface-400 border-transparent hover:text-surface-200'
      )}
    >
      {children}
    </button>
  );
}
