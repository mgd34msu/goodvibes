// ============================================================================
// SESSION DETAIL MODAL HELPER COMPONENTS
// Small reusable components for the modal
// ============================================================================

import React from 'react';
import { clsx } from 'clsx';

export function StatCard({ label, value, highlight }: { label: string; value: string; highlight?: boolean }): React.JSX.Element {
  return (
    <div className="bg-surface-800 rounded-lg p-4">
      <p className="text-xs text-surface-400 mb-1">{label}</p>
      <p className={clsx(
        'text-xl font-semibold',
        highlight ? 'text-primary-400' : 'text-surface-100'
      )}>
        {value}
      </p>
    </div>
  );
}

export function DetailRow({ label, value }: { label: string; value: React.ReactNode }): React.JSX.Element {
  return (
    <div className="flex items-center justify-between px-4 py-2 bg-surface-800 rounded-lg">
      <span className="text-sm text-surface-400">{label}</span>
      <span className="text-sm text-surface-100">{value}</span>
    </div>
  );
}

export function OutcomeBadge({ outcome }: { outcome: string }): React.JSX.Element {
  return (
    <span className={clsx(
      'badge text-xs',
      outcome === 'success' && 'badge-success',
      outcome === 'partial' && 'badge-warning',
      outcome === 'failed' && 'badge-error',
      outcome === 'abandoned' && 'text-surface-500 bg-surface-700'
    )}>
      {outcome}
    </span>
  );
}
