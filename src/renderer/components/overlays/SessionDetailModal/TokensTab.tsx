// ============================================================================
// TOKENS TAB COMPONENT
// ============================================================================

import React from 'react';
import { clsx } from 'clsx';
import type { Session } from '../../../../shared/types';
import { formatCost, formatNumber } from '../../../../shared/utils';
import { StatCard, DetailRow } from './HelperComponents';

interface TokensTabProps {
  session: Session;
}

export function TokensTab({ session }: TokensTabProps) {
  const tokenBreakdown = [
    { label: 'Input Tokens', value: session.inputTokens, color: 'bg-primary-500' },
    { label: 'Output Tokens', value: session.outputTokens, color: 'bg-success-500' },
    { label: 'Cache Write', value: session.cacheWriteTokens, color: 'bg-warning-500' },
    { label: 'Cache Read', value: session.cacheReadTokens, color: 'bg-accent-500' },
  ];

  const total = tokenBreakdown.reduce((sum, t) => sum + t.value, 0);

  return (
    <div className="space-y-6">
      {/* Token Breakdown */}
      <div>
        <h3 className="text-sm font-medium text-surface-300 mb-4">Token Breakdown</h3>
        <div className="space-y-3">
          {tokenBreakdown.map(({ label, value, color }) => (
            <div key={label}>
              <div className="flex items-center justify-between text-sm mb-1">
                <span className="text-surface-300">{label}</span>
                <span className="text-surface-100 font-mono">{formatNumber(value)}</span>
              </div>
              <div className="h-2 bg-surface-800 rounded-full overflow-hidden">
                <div
                  className={clsx('h-full rounded-full', color)}
                  style={{ width: `${total > 0 ? (value / total) * 100 : 0}%` }}
                />
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Token Stats */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <StatCard label="Total Tokens" value={formatNumber(session.tokenCount)} />
        <StatCard label="Input" value={formatNumber(session.inputTokens)} />
        <StatCard label="Output" value={formatNumber(session.outputTokens)} />
        <StatCard label="Cached" value={formatNumber(session.cacheReadTokens + session.cacheWriteTokens)} />
      </div>

      {/* Cost Analysis */}
      <div>
        <h3 className="text-sm font-medium text-surface-300 mb-4">Cost Analysis</h3>
        <div className="grid grid-cols-2 gap-4">
          <DetailRow label="Total Cost" value={formatCost(session.cost)} />
          <DetailRow
            label="Cost per Message"
            value={session.messageCount > 0 ? formatCost(session.cost / session.messageCount) : 'N/A'}
          />
          <DetailRow
            label="Cost per 1K Tokens"
            value={session.tokenCount > 0 ? formatCost((session.cost / session.tokenCount) * 1000) : 'N/A'}
          />
          <DetailRow
            label="Tokens per Message"
            value={session.messageCount > 0 ? formatNumber(Math.round(session.tokenCount / session.messageCount)) : 'N/A'}
          />
        </div>
      </div>
    </div>
  );
}
