// ============================================================================
// SESSION DETAIL MODAL COMPONENT
// Main modal component for viewing session details
// ============================================================================

import React, { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { clsx } from 'clsx';
import type { Session } from '../../../../shared/types';
import { decodeProjectName, decodeProjectPath } from '../../../../shared/utils';
import { useAppStore } from '../../../stores/appStore';
import { useSettingsStore } from '../../../stores/settingsStore';
import { useTerminalStore } from '../../../stores/terminalStore';
import { OverviewTab } from './OverviewTab';
import { MessagesTab } from './MessagesTab';
import { TokensTab } from './TokensTab';
import type { SessionDetailModalProps } from './types';

export function SessionDetailModal({ session, onClose }: SessionDetailModalProps) {
  const { setCurrentView } = useAppStore();
  const { settings } = useSettingsStore();
  const { createPreviewTerminal, createTerminal } = useTerminalStore();
  const [activeTab, setActiveTab] = useState<'overview' | 'messages' | 'tokens'>('overview');

  const { data: messages = [], isLoading: messagesLoading } = useQuery({
    queryKey: ['session-messages', session.id],
    queryFn: () => window.goodvibes.getSessionMessages(session.id),
    enabled: activeTab === 'messages',
  });

  // Fetch fresh session data with token stats immediately on modal open
  const { data: refreshedSession } = useQuery({
    queryKey: ['session-refresh', session.id],
    queryFn: () => window.goodvibes.refreshSession(session.id),
    staleTime: 0, // Always refetch on mount
  });

  // Use refreshed session data when available, fallback to prop session
  const currentSession = refreshedSession ?? session;

  const displayName = currentSession.customTitle || decodeProjectName(currentSession.projectName, settings.projectsRoot);

  const handleOpenPreview = () => {
    const cwd = decodeProjectPath(session.projectName) || undefined;
    createPreviewTerminal(session.id, displayName, cwd);
    setCurrentView('terminal');
    onClose();
  };

  // Calculate session duration
  const duration = currentSession.startTime && currentSession.endTime
    ? Math.floor((new Date(currentSession.endTime).getTime() - new Date(currentSession.startTime).getTime()) / 1000)
    : null;

  return (
    <div
      className="fixed inset-0 z-[9999] flex items-center justify-center bg-surface-950/80 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="w-full max-w-4xl max-h-[85vh] bg-surface-900 border border-surface-700 rounded-xl shadow-elevation-5 overflow-hidden flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-surface-700">
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2">
              <h2 className="text-lg font-semibold text-surface-100 truncate">
                {displayName}
              </h2>
              {currentSession.favorite && (
                <span className="text-warning-400">&#9733;</span>
              )}
              {currentSession.archived && (
                <span className="badge text-surface-500 bg-surface-700 text-xs">Archived</span>
              )}
            </div>
            <p className="text-sm text-surface-400 mt-0.5">
              Session ID: <span className="font-mono text-surface-500">{session.id}</span>
            </p>
          </div>
          <button
            onClick={onClose}
            className="p-1 rounded-lg hover:bg-surface-800 text-surface-400"
          >
            <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* Tabs */}
        <div className="flex items-center gap-2 px-6 py-2 border-b border-surface-700 bg-surface-850">
          {(['overview', 'messages', 'tokens'] as const).map((tab) => (
            <button
              key={tab}
              onClick={() => setActiveTab(tab)}
              className={clsx(
                'px-4 py-1.5 text-sm rounded-lg transition-colors',
                activeTab === tab
                  ? 'bg-primary-500/20 text-primary-400'
                  : 'text-surface-400 hover:bg-surface-800 hover:text-surface-200'
              )}
            >
              {tab.charAt(0).toUpperCase() + tab.slice(1)}
            </button>
          ))}
        </div>

        {/* Content */}
        <div className="flex-1 overflow-auto p-6">
          {activeTab === 'overview' && (
            <OverviewTab session={currentSession} duration={duration} displayName={displayName} />
          )}
          {activeTab === 'messages' && (
            <MessagesTab messages={messages} loading={messagesLoading} />
          )}
          {activeTab === 'tokens' && (
            <TokensTab session={currentSession} />
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between px-6 py-4 border-t border-surface-700">
          <div className="flex items-center gap-2">
            <button
              onClick={handleOpenPreview}
              className="btn btn-secondary text-sm"
            >
              <svg className="w-4 h-4 mr-1.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" />
              </svg>
              Open Preview
            </button>
            <button
              onClick={async () => {
                // Resume session in a new terminal using the store action
                // This ensures the terminal is properly added to the store and displayed
                const cwd = decodeProjectPath(session.projectName) || undefined;
                await createTerminal(cwd, displayName, session.id);
                setCurrentView('terminal');
                onClose();
              }}
              className="btn btn-primary text-sm"
            >
              <svg className="w-4 h-4 mr-1.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M14.752 11.168l-3.197-2.132A1 1 0 0010 9.87v4.263a1 1 0 001.555.832l3.197-2.132a1 1 0 000-1.664z" />
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
              Resume Session
            </button>
            <button
              onClick={() => window.goodvibes.exportSession(session.id, 'markdown')}
              className="btn btn-secondary text-sm"
            >
              Export Markdown
            </button>
            <button
              onClick={() => window.goodvibes.exportSession(session.id, 'json')}
              className="btn btn-secondary text-sm"
            >
              Export JSON
            </button>
          </div>
          <button onClick={onClose} className="btn btn-secondary">
            Close
          </button>
        </div>
      </div>
    </div>
  );
}

// Re-export types for convenience
export type { SessionDetailModalProps } from './types';
