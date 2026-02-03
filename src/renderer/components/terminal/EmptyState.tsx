// ============================================================================
// EMPTY STATE - Premium welcome screen when no sessions are open
// ============================================================================

import { useEffect, useState } from 'react';
import appIcon from '../../assets/icon.png';

// ============================================================================
// TYPES
// ============================================================================

interface EmptyStateProps {
  onNewSession: () => void;
  onNewTerminal: () => void;
  onOpenTextEditor: () => void;
  onQuickRestart: () => void;
}

interface RecentSession {
  sessionId: string;
  firstPrompt?: string;
}

// ============================================================================
// COMPONENT
// ============================================================================

export function EmptyState({ onNewSession, onNewTerminal, onOpenTextEditor, onQuickRestart }: EmptyStateProps): React.JSX.Element {
  const [recentSession, setRecentSession] = useState<RecentSession | null>(null);

  useEffect(() => {
    // Load most recent session for quick restart
    window.goodvibes.getMostRecentSession().then(session => {
      if (session) {
        setRecentSession({
          sessionId: session.sessionId,
          firstPrompt: session.firstPrompt,
        });
      }
    }).catch(() => {
      // Ignore errors
    });
  }, []);

  return (
    <div className="flex-1 flex items-center justify-center bg-surface-900 relative overflow-hidden">
      {/* Background Effects */}
      <div className="absolute inset-0 pointer-events-none">
        {/* Radial gradient glow behind logo */}
        <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[600px] h-[600px]">
          <div className="absolute inset-0 bg-gradient-radial from-primary-500/5 via-transparent to-transparent" />
        </div>
        {/* Subtle grid pattern */}
        <div
          className="absolute inset-0 opacity-[0.02]"
          style={{
            backgroundImage: `
              linear-gradient(rgba(255,255,255,0.05) 1px, transparent 1px),
              linear-gradient(90deg, rgba(255,255,255,0.05) 1px, transparent 1px)
            `,
            backgroundSize: '64px 64px',
          }}
        />
      </div>

      <div className="text-center max-w-2xl mx-auto px-8 relative z-10">
        {/* Logo with Glow Effect */}
        <div className="relative inline-block mb-8">
          <div className="absolute inset-0 blur-2xl bg-primary-500/20 rounded-full scale-150" />
          <img
            src={appIcon}
            alt="GoodVibes"
            className="w-28 h-28 mx-auto relative animate-float drop-shadow-2xl"
          />
        </div>

        {/* Title with Gradient */}
        <h2 className="text-4xl font-bold mb-4 bg-gradient-to-r from-surface-100 via-surface-100 to-surface-300 bg-clip-text text-transparent">
          Welcome to GoodVibes
        </h2>

        <p className="text-surface-400 text-base mb-12 leading-relaxed max-w-md mx-auto">
          Start a new Claude Code session, open a text editor, or resume your most recent session.
        </p>

        {/* Action Cards - 2x2 Grid */}
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 max-w-xl mx-auto">
          {/* Claude Session Card */}
          <button
            onClick={onNewSession}
            className="group relative flex items-center gap-4 px-5 py-4 rounded-2xl text-left transition-all duration-300 hover:-translate-y-1 focus:outline-none focus:ring-2 focus:ring-primary-500/50 focus:ring-offset-2 focus:ring-offset-surface-900"
            aria-label="Start new Claude Code session"
          >
            {/* Card Background */}
            <div className="absolute inset-0 rounded-2xl bg-gradient-to-br from-surface-800/80 to-surface-900/80 border border-surface-700/50 group-hover:border-primary-500/30 transition-colors" />
            <div className="absolute inset-0 rounded-2xl opacity-0 group-hover:opacity-100 transition-opacity bg-gradient-to-br from-primary-500/5 to-transparent" />

            {/* Icon */}
            <div className="relative flex-shrink-0 w-12 h-12 rounded-xl bg-gradient-to-br from-primary-500/20 to-primary-600/10 flex items-center justify-center border border-primary-500/20 group-hover:border-primary-500/40 group-hover:shadow-lg group-hover:shadow-primary-500/10 transition-all">
              <svg className="w-6 h-6 text-primary-400 group-hover:scale-110 transition-transform" fill="none" viewBox="0 0 24 24" stroke="currentColor" aria-hidden="true">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9.75 17L9 20l-1 1h8l-1-1-.75-3M3 13h18M5 17h14a2 2 0 002-2V5a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" />
              </svg>
            </div>

            {/* Text */}
            <div className="relative flex-1 min-w-0">
              <div className="font-semibold text-surface-100 group-hover:text-white transition-colors">Claude Session</div>
              <div className="text-xs text-surface-500 group-hover:text-surface-400 transition-colors truncate">Start new Claude CLI</div>
            </div>
          </button>

          {/* Quick Restart Card */}
          <button
            onClick={onQuickRestart}
            disabled={!recentSession}
            className="group relative flex items-center gap-4 px-5 py-4 rounded-2xl text-left transition-all duration-300 hover:-translate-y-1 focus:outline-none focus:ring-2 focus:ring-accent-500/50 focus:ring-offset-2 focus:ring-offset-surface-900 disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:translate-y-0"
            aria-label="Resume most recent session"
          >
            {/* Card Background */}
            <div className="absolute inset-0 rounded-2xl bg-gradient-to-br from-surface-800/80 to-surface-900/80 border border-surface-700/50 group-hover:border-accent-500/30 group-disabled:group-hover:border-surface-700/50 transition-colors" />
            <div className="absolute inset-0 rounded-2xl opacity-0 group-hover:opacity-100 group-disabled:group-hover:opacity-0 transition-opacity bg-gradient-to-br from-accent-500/5 to-transparent" />

            {/* Icon */}
            <div className="relative flex-shrink-0 w-12 h-12 rounded-xl bg-gradient-to-br from-accent-500/20 to-accent-600/10 flex items-center justify-center border border-accent-500/20 group-hover:border-accent-500/40 group-hover:shadow-lg group-hover:shadow-accent-500/10 transition-all">
              <svg className="w-6 h-6 text-accent-400 group-hover:scale-110 transition-transform" fill="none" viewBox="0 0 24 24" stroke="currentColor" aria-hidden="true">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
              </svg>
            </div>

            {/* Text */}
            <div className="relative flex-1 min-w-0">
              <div className="font-semibold text-surface-100 group-hover:text-white transition-colors">Quick Restart</div>
              <div className="text-xs text-surface-500 group-hover:text-surface-400 transition-colors truncate">
                {recentSession?.firstPrompt ? recentSession.firstPrompt.slice(0, 30) + (recentSession.firstPrompt.length > 30 ? '...' : '') : 'No recent session'}
              </div>
            </div>
          </button>

          {/* Text Editor Card */}
          <button
            onClick={onOpenTextEditor}
            className="group relative flex items-center gap-4 px-5 py-4 rounded-2xl text-left transition-all duration-300 hover:-translate-y-1 focus:outline-none focus:ring-2 focus:ring-warning-500/50 focus:ring-offset-2 focus:ring-offset-surface-900"
            aria-label="Open text editor"
          >
            {/* Card Background */}
            <div className="absolute inset-0 rounded-2xl bg-gradient-to-br from-surface-800/80 to-surface-900/80 border border-surface-700/50 group-hover:border-warning-500/30 transition-colors" />
            <div className="absolute inset-0 rounded-2xl opacity-0 group-hover:opacity-100 transition-opacity bg-gradient-to-br from-warning-500/5 to-transparent" />

            {/* Icon */}
            <div className="relative flex-shrink-0 w-12 h-12 rounded-xl bg-gradient-to-br from-warning-500/20 to-warning-600/10 flex items-center justify-center border border-warning-500/20 group-hover:border-warning-500/40 group-hover:shadow-lg group-hover:shadow-warning-500/10 transition-all">
              <svg className="w-6 h-6 text-warning-400 group-hover:scale-110 transition-transform" fill="none" viewBox="0 0 24 24" stroke="currentColor" aria-hidden="true">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
              </svg>
            </div>

            {/* Text */}
            <div className="relative flex-1 min-w-0">
              <div className="font-semibold text-surface-100 group-hover:text-white transition-colors">Text Editor</div>
              <div className="text-xs text-surface-500 group-hover:text-surface-400 transition-colors truncate">Open nvim/vim/editor</div>
            </div>
          </button>

          {/* Terminal Card */}
          <button
            onClick={onNewTerminal}
            className="group relative flex items-center gap-4 px-5 py-4 rounded-2xl text-left transition-all duration-300 hover:-translate-y-1 focus:outline-none focus:ring-2 focus:ring-success-500/50 focus:ring-offset-2 focus:ring-offset-surface-900"
            aria-label="Open new terminal"
          >
            {/* Card Background */}
            <div className="absolute inset-0 rounded-2xl bg-gradient-to-br from-surface-800/80 to-surface-900/80 border border-surface-700/50 group-hover:border-success-500/30 transition-colors" />
            <div className="absolute inset-0 rounded-2xl opacity-0 group-hover:opacity-100 transition-opacity bg-gradient-to-br from-success-500/5 to-transparent" />

            {/* Icon */}
            <div className="relative flex-shrink-0 w-12 h-12 rounded-xl bg-gradient-to-br from-success-500/20 to-success-600/10 flex items-center justify-center border border-success-500/20 group-hover:border-success-500/40 group-hover:shadow-lg group-hover:shadow-success-500/10 transition-all">
              <svg className="w-6 h-6 text-success-400 group-hover:scale-110 transition-transform" fill="none" viewBox="0 0 24 24" stroke="currentColor" aria-hidden="true">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M8 9l3 3-3 3m5 0h3M5 20h14a2 2 0 002-2V6a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" />
              </svg>
            </div>

            {/* Text */}
            <div className="relative flex-1 min-w-0">
              <div className="font-semibold text-surface-100 group-hover:text-white transition-colors">Terminal</div>
              <div className="text-xs text-surface-500 group-hover:text-surface-400 transition-colors truncate">Open plain shell</div>
            </div>
          </button>
        </div>

        {/* Keyboard Shortcut Hint */}
        <div className="mt-10 flex items-center justify-center gap-4 text-surface-600 text-xs">
          <div className="flex items-center gap-1.5">
            <kbd className="px-1.5 py-0.5 bg-surface-800/50 border border-surface-700/50 rounded text-surface-500 font-mono">Ctrl</kbd>
            <span>+</span>
            <kbd className="px-1.5 py-0.5 bg-surface-800/50 border border-surface-700/50 rounded text-surface-500 font-mono">N</kbd>
            <span className="ml-1">New session</span>
          </div>
        </div>
      </div>
    </div>
  );
}

export default EmptyState;
