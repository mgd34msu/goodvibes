// ============================================================================
// PREVIOUS SESSIONS MODAL - Select from recent sessions for a project
// ============================================================================

import { useState, useEffect } from 'react';
import { X, MessageSquare, Clock, DollarSign, Loader2, Eye, Terminal } from 'lucide-react';
import { useAppStore } from '../../../stores/appStore';
import { useTerminalStore } from '../../../stores/terminalStore';
import type { RegisteredProject } from './types';

interface SessionSummary {
  sessionId: string;
  cwd: string;
  messageCount: number;
  totalCostUsd: number;
  startTime: string;
  lastActivity: string;
  firstPrompt?: string;
}

interface PreviousSessionsModalProps {
  project: RegisteredProject;
  onClose: () => void;
  formatCurrency: (value: number) => string;
}

export function PreviousSessionsModal({
  project,
  onClose,
  formatCurrency,
}: PreviousSessionsModalProps) {
  const { setCurrentView } = useAppStore();
  const { createPreviewTerminal, createTerminal } = useTerminalStore();
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [selectedSession, setSelectedSession] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    loadSessions();
  }, [project.path]);

  const loadSessions = async () => {
    setIsLoading(true);
    setError(null);
    try {
      const result = await window.goodvibes?.getProjectSessions?.(project.path, 5);
      if (result && Array.isArray(result)) {
        // Map SessionSummary to our component's format
        const mapped: SessionSummary[] = result.map((s: {
          sessionId: string;
          cwd?: string;
          messageCount?: number;
          costUsd?: number;
          startedAt?: string;
          lastActive?: string;
          firstPrompt?: string;
        }) => ({
          sessionId: s.sessionId,
          cwd: s.cwd || project.path,
          messageCount: s.messageCount || 0,
          totalCostUsd: s.costUsd || 0,
          startTime: s.startedAt || new Date().toISOString(),
          lastActivity: s.lastActive || new Date().toISOString(),
          firstPrompt: s.firstPrompt,
        }));
        setSessions(mapped);
        if (mapped.length > 0 && mapped[0]) {
          setSelectedSession(mapped[0].sessionId);
        }
      } else {
        setSessions([]);
      }
    } catch (err) {
      setError('Failed to load sessions');
      console.error('Failed to load sessions:', err);
    } finally {
      setIsLoading(false);
    }
  };

  const formatDate = (dateString: string) => {
    const date = new Date(dateString);
    return date.toLocaleDateString(undefined, {
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
    });
  };

  const formatDuration = (start: string, end: string) => {
    const startDate = new Date(start);
    const endDate = new Date(end);
    const diffMs = endDate.getTime() - startDate.getTime();
    const diffMins = Math.floor(diffMs / 60000);
    if (diffMins < 60) {
      return `${diffMins}m`;
    }
    const hours = Math.floor(diffMins / 60);
    const mins = diffMins % 60;
    return `${hours}h ${mins}m`;
  };

  const handleLoadPreview = () => {
    if (selectedSession) {
      createPreviewTerminal(selectedSession, project.name, project.path);
      setCurrentView('terminal');
      onClose();
    }
  };

  const handleLoadInCLI = async () => {
    if (selectedSession) {
      await createTerminal(project.path, project.name, selectedSession);
      setCurrentView('terminal');
      onClose();
    }
  };

  return (
    <div className="fixed inset-0 z-[9999] flex items-center justify-center">
      {/* Backdrop */}
      <div
        className="absolute inset-0 bg-black/50 backdrop-blur-sm"
        onClick={onClose}
      />

      {/* Modal */}
      <div className="relative bg-surface-900 border border-surface-700 rounded-xl shadow-2xl w-full max-w-lg mx-4">
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-surface-700">
          <div>
            <h2 className="text-lg font-semibold text-surface-100">Previous Sessions</h2>
            <p className="text-sm text-surface-400 mt-0.5">{project.name}</p>
          </div>
          <button
            onClick={onClose}
            className="p-1.5 rounded-lg hover:bg-surface-800 text-surface-400 hover:text-surface-200 transition-colors"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Content */}
        <div className="p-5">
          {isLoading ? (
            <div className="flex items-center justify-center py-12">
              <Loader2 className="w-6 h-6 animate-spin text-primary-400" />
              <span className="ml-2 text-surface-400">Loading sessions...</span>
            </div>
          ) : error ? (
            <div className="text-center py-12">
              <p className="text-red-400">{error}</p>
              <button
                onClick={loadSessions}
                className="mt-3 btn btn-sm btn-secondary"
              >
                Retry
              </button>
            </div>
          ) : sessions.length === 0 ? (
            <div className="text-center py-12">
              <p className="text-surface-400">No previous sessions found for this project.</p>
              <p className="text-sm text-surface-500 mt-1">Start a new session to get going!</p>
            </div>
          ) : (
            <div className="space-y-2">
              {sessions.map((session) => (
                <button
                  key={session.sessionId}
                  onClick={() => setSelectedSession(session.sessionId)}
                  className={`w-full text-left p-4 rounded-lg border transition-all ${
                    selectedSession === session.sessionId
                      ? 'bg-primary-500/10 border-primary-500/50'
                      : 'bg-surface-800/50 border-surface-700 hover:bg-surface-800 hover:border-surface-600'
                  }`}
                >
                  {/* First prompt preview */}
                  {session.firstPrompt && (
                    <p className="text-sm text-surface-200 font-medium truncate mb-2">
                      {session.firstPrompt}
                    </p>
                  )}

                  {/* Stats row */}
                  <div className="flex items-center gap-4 text-xs text-surface-400">
                    <div className="flex items-center gap-1" title="Messages">
                      <MessageSquare className="w-3.5 h-3.5" />
                      <span>{session.messageCount} messages</span>
                    </div>
                    <div className="flex items-center gap-1" title="Cost">
                      <DollarSign className="w-3.5 h-3.5" />
                      <span>{formatCurrency(session.totalCostUsd)}</span>
                    </div>
                    <div className="flex items-center gap-1" title="Duration">
                      <Clock className="w-3.5 h-3.5" />
                      <span>{formatDuration(session.startTime, session.lastActivity)}</span>
                    </div>
                  </div>

                  {/* Date */}
                  <div className="text-xs text-surface-500 mt-2">
                    {formatDate(session.startTime)}
                  </div>
                </button>
              ))}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-end gap-3 px-5 py-4 border-t border-surface-700">
          <button onClick={onClose} className="btn btn-secondary">
            Cancel
          </button>
          <button
            onClick={handleLoadPreview}
            disabled={!selectedSession || isLoading}
            className="btn btn-secondary flex items-center gap-1.5"
          >
            <Eye className="w-4 h-4" />
            Load Preview
          </button>
          <button
            onClick={handleLoadInCLI}
            disabled={!selectedSession || isLoading}
            className="btn btn-primary flex items-center gap-1.5"
          >
            <Terminal className="w-4 h-4" />
            Load in CLI
          </button>
        </div>
      </div>
    </div>
  );
}
