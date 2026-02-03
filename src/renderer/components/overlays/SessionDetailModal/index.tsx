// ============================================================================
// SESSION DETAIL MODAL COMPONENT
// Premium cinematic modal for viewing session details
// ============================================================================

import { useState, useEffect } from 'react';
import { useQuery } from '@tanstack/react-query';
import { clsx } from 'clsx';
import { X, Eye, Play, FileText, FileJson, Star, Archive } from 'lucide-react';
import { decodeProjectName, decodeProjectPath } from '../../../../shared/utils';
import { useAppStore } from '../../../stores/appStore';
import { useSettingsStore } from '../../../stores/settingsStore';
import { useTerminalStore } from '../../../stores/terminalStore';
import { ErrorBoundary } from '../../common/ErrorBoundary';
import { OverviewTab } from './OverviewTab';
import { MessagesTab } from './MessagesTab';
import { TokensTab } from './TokensTab';
import { TagsSection } from './TagsSection.js';
import type { SessionDetailModalProps } from './types';

export function SessionDetailModal({ session, onClose }: SessionDetailModalProps): React.JSX.Element {
  const { setCurrentView } = useAppStore();
  const { settings } = useSettingsStore();
  const { createPreviewTerminal, createTerminal } = useTerminalStore();
  const [activeTab, setActiveTab] = useState<'overview' | 'messages' | 'tokens' | 'tags'>('overview');

  // Keyboard shortcut: Cmd/Ctrl+T to focus tag input
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && (e.key === 't' || e.key === 'T')) {
        e.preventDefault();
        setActiveTab('tags');
        // Focus will be handled by TagInput component after tab switch
      }
    };
    
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, []);

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
    <div className="modal-backdrop-premium" onClick={onClose}>
      <ErrorBoundary
        fallback={
          <div className="modal-panel-premium modal-xl">
            <div className="p-8 text-center">
              <p className="text-slate-400">Session Detail Modal encountered an error</p>
              <button onClick={onClose} className="btn btn-secondary mt-4">
                Close
              </button>
            </div>
          </div>
        }
        onReset={onClose}
      >
        <div
          className="modal-panel-premium modal-xl"
          onClick={(e) => e.stopPropagation()}
        >
          {/* Header */}
          <div className="modal-header-premium">
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2">
                <h2 className="truncate">{displayName}</h2>
                {currentSession.favorite && (
                  <Star className="w-4 h-4 text-amber-400 fill-amber-400" />
                )}
                {currentSession.archived && (
                  <span className="px-2 py-0.5 text-[10px] font-medium rounded-md bg-slate-500/20 text-slate-400 border border-slate-500/30 flex items-center gap-1">
                    <Archive className="w-3 h-3" />
                    Archived
                  </span>
                )}
              </div>
              <p className="modal-subtitle">
                Session ID: <span className="font-mono">{session.id}</span>
              </p>
            </div>
            <button onClick={onClose} className="modal-close-premium">
              <X className="w-4 h-4" />
            </button>
          </div>

          {/* Tabs */}
          <div className="flex items-center gap-2 px-6 py-3 border-b border-white/[0.06] bg-white/[0.01]">
            {(['overview', 'messages', 'tokens', 'tags'] as const).map((tab) => (
              <button
                key={tab}
                onClick={() => setActiveTab(tab)}
                className={clsx(
                  'px-4 py-1.5 text-sm rounded-lg transition-all',
                  activeTab === tab
                    ? 'bg-violet-500/20 text-violet-300 border border-violet-500/30'
                    : 'text-slate-400 hover:bg-white/[0.05] hover:text-slate-200 border border-transparent'
                )}
              >
                {tab.charAt(0).toUpperCase() + tab.slice(1)}
              </button>
            ))}
          </div>

          {/* Content */}
          <div className="modal-body-premium">
            {activeTab === 'overview' && (
              <OverviewTab session={currentSession} duration={duration} displayName={displayName} />
            )}
            {activeTab === 'messages' && (
              <MessagesTab messages={messages} loading={messagesLoading} />
            )}
            {activeTab === 'tokens' && (
              <TokensTab session={currentSession} />
            )}
            {activeTab === 'tags' && (
              <TagsSection
                sessionId={session.id}
                onTagsChange={() => {
                  // Optionally refresh session data when tags change
                }}
              />
            )}
          </div>

          {/* Footer */}
          <div className="modal-footer-premium modal-footer-split">
            <div className="flex items-center gap-2">
              <button
                onClick={handleOpenPreview}
                className="btn btn-secondary text-sm"
              >
                <Eye className="w-4 h-4 mr-1.5" />
                Preview
              </button>
              <button
                onClick={async () => {
                  const cwd = decodeProjectPath(session.projectName) || undefined;
                  await createTerminal(cwd, displayName, session.id);
                  setCurrentView('terminal');
                  onClose();
                }}
                className="btn btn-primary text-sm"
              >
                <Play className="w-4 h-4 mr-1.5" />
                Resume
              </button>
              <button
                onClick={() => window.goodvibes.exportSession(session.id, 'markdown')}
                className="btn btn-secondary text-sm"
              >
                <FileText className="w-4 h-4 mr-1.5" />
                Export MD
              </button>
              <button
                onClick={() => window.goodvibes.exportSession(session.id, 'json')}
                className="btn btn-secondary text-sm"
              >
                <FileJson className="w-4 h-4 mr-1.5" />
                Export JSON
              </button>
            </div>
            <button onClick={onClose} className="btn btn-secondary">
              Close
            </button>
          </div>
        </div>
      </ErrorBoundary>
    </div>
  );
}

// Re-export types for convenience
export type { SessionDetailModalProps } from './types';
