// ============================================================================
// SESSION CARD COMPONENT - Premium Glass Morphism Design
// ============================================================================

import React, { useCallback } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { clsx } from 'clsx';
import {
  Eye,
  Terminal,
  Star,
  Archive,
  MessageSquare,
  Coins,
  Hash,
} from 'lucide-react';
import type { SessionCardProps } from './types';
import {
  formatCost,
  formatNumber,
  formatRelativeTime,
  decodeProjectName,
  decodeProjectPath,
} from '../../../../shared/utils';
import { useTerminalStore } from '../../../stores/terminalStore';
import { useAppStore } from '../../../stores/appStore';

export function SessionCard({ session, projectsRoot, isLive, onClick }: SessionCardProps) {
  const { createPreviewTerminal, createTerminal } = useTerminalStore();
  const { setCurrentView } = useAppStore();
  const queryClient = useQueryClient();

  const handleToggleFavorite = useCallback(
    async (e: React.MouseEvent) => {
      e.stopPropagation();
      await window.goodvibes.toggleFavorite(session.id);
      await queryClient.invalidateQueries({ queryKey: ['sessions'] });
    },
    [session.id, queryClient]
  );

  const handleToggleArchive = useCallback(
    async (e: React.MouseEvent) => {
      e.stopPropagation();
      await window.goodvibes.toggleArchive(session.id);
      await queryClient.invalidateQueries({ queryKey: ['sessions'] });
    },
    [session.id, queryClient]
  );

  const displayName = session.customTitle || decodeProjectName(session.projectName, projectsRoot);

  const handleOpenPreview = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      const cwd = decodeProjectPath(session.projectName) || undefined;
      createPreviewTerminal(session.id, displayName, cwd);
      setCurrentView('terminal');
    },
    [session.id, session.projectName, displayName, createPreviewTerminal, setCurrentView]
  );

  const handleOpenCLI = useCallback(
    async (e: React.MouseEvent) => {
      e.stopPropagation();
      const cwd = decodeProjectPath(session.projectName) || undefined;
      await createTerminal(cwd, displayName, session.id);
      setCurrentView('terminal');
    },
    [session.id, session.projectName, displayName, createTerminal, setCurrentView]
  );

  return (
    <div
      className="card-hover cursor-pointer h-full"
      onClick={onClick}
    >
      {/* Main Content */}
      <div className="flex items-start justify-between gap-4">
        {/* Left Section: Info */}
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            {/* Live indicator */}
            {isLive && (
              <span className="card-status card-status-connected" title="Session is live" />
            )}
            <h3 className="card-title-gradient text-sm truncate">{displayName}</h3>
            {session.favorite && (
              <Star className="w-4 h-4 text-warning-400 fill-warning-400 flex-shrink-0" />
            )}
            {/* Agent badge */}
            {session.id.startsWith('agent-') && (
              <span className="card-badge card-badge-primary">
                agent
              </span>
            )}
            {/* Outcome badge */}
            {session.outcome && (
              <span
                className={clsx(
                  'card-badge',
                  session.outcome === 'success' && 'card-badge-success',
                  session.outcome === 'partial' && 'card-badge-warning',
                  session.outcome === 'failed' && 'card-badge-error',
                  session.outcome === 'abandoned' && ''
                )}
              >
                {session.outcome}
              </span>
            )}
            {session.rating && (
              <span className="card-badge card-badge-primary">
                {'*'.repeat(session.rating)}
              </span>
            )}
          </div>

          <div className="card-meta mt-2">
            <span className="card-meta-item">
              {formatRelativeTime(session.endTime)}
            </span>
            <span className="card-meta-item">
              <MessageSquare className="w-3 h-3" />
              {session.messageCount}
            </span>
            <span className="card-meta-item">
              <Hash className="w-3 h-3" />
              {formatNumber(session.tokenCount)}
            </span>
            <span className="card-meta-item">
              <Coins className="w-3 h-3" />
              {formatCost(session.cost)}
            </span>
          </div>
          {session.summary && (
            <p className="card-description line-clamp-1 mt-1" title={session.summary}>
              {session.summary}
            </p>
          )}
        </div>

        {/* Right Section: Actions */}
        <div className="card-actions">
          <button
            onClick={handleOpenPreview}
            className="card-action-btn card-action-btn-primary"
            title="Open Preview"
          >
            <Eye className="w-4 h-4" />
          </button>
          <button
            onClick={handleOpenCLI}
            className="card-action-btn card-action-btn-success"
            title="Open in CLI"
          >
            <Terminal className="w-4 h-4" />
          </button>
          <button
            onClick={handleToggleFavorite}
            className={clsx(
              'card-action-btn',
              session.favorite ? 'text-warning-400' : ''
            )}
            title={session.favorite ? 'Remove from favorites' : 'Add to favorites'}
          >
            <Star className={clsx('w-4 h-4', session.favorite && 'fill-current')} />
          </button>
          <button
            onClick={handleToggleArchive}
            className="card-action-btn"
            title={session.archived ? 'Unarchive' : 'Archive'}
          >
            <Archive className="w-4 h-4" />
          </button>
        </div>
      </div>
    </div>
  );
}
