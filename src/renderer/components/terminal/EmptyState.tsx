// ============================================================================
// EMPTY STATE - Shown when no terminal sessions are open
// ============================================================================

import appIcon from '../../assets/icon.png';

// ============================================================================
// TYPES
// ============================================================================

interface EmptyStateProps {
  onNewSession: () => void;
  onNewTerminal: () => void;
}

// ============================================================================
// COMPONENT
// ============================================================================

export function EmptyState({ onNewSession, onNewTerminal }: EmptyStateProps) {
  return (
    <div className="flex-1 flex items-center justify-center bg-surface-900">
      <div className="text-center max-w-lg mx-auto px-6">
        <img
          src={appIcon}
          alt="Clausitron"
          className="w-24 h-24 mx-auto mb-8"
        />
        <h2 className="text-3xl font-bold text-surface-100 mb-4">
          Welcome to Clausitron
        </h2>
        <p className="text-surface-400 text-base mb-10 leading-relaxed">
          Start a new Claude Code session to begin working on your project, or open a plain terminal.
        </p>
        <div className="flex flex-col sm:flex-row gap-4 justify-center">
          <button
            onClick={onNewSession}
            className="flex items-center gap-4 px-6 py-4 bg-surface-800 border border-surface-700 rounded-xl hover:bg-surface-700 hover:border-surface-600 transition-colors text-left"
            aria-label="Start new Claude Code session"
          >
            <div className="flex-shrink-0 w-12 h-12 rounded-lg bg-primary-500/20 flex items-center justify-center">
              <svg className="w-6 h-6 text-primary-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" aria-hidden="true">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9.75 17L9 20l-1 1h8l-1-1-.75-3M3 13h18M5 17h14a2 2 0 002-2V5a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" />
              </svg>
            </div>
            <div>
              <div className="font-semibold text-surface-100">Claude Code Session</div>
              <div className="text-sm text-surface-400">Start a new Claude CLI session</div>
            </div>
          </button>
          <button
            onClick={onNewTerminal}
            className="flex items-center gap-4 px-6 py-4 bg-surface-800 border border-surface-700 rounded-xl hover:bg-surface-700 hover:border-surface-600 transition-colors text-left"
            aria-label="Open new terminal"
          >
            <div className="flex-shrink-0 w-12 h-12 rounded-lg bg-success-500/20 flex items-center justify-center">
              <svg className="w-6 h-6 text-success-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" aria-hidden="true">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 9l3 3-3 3m5 0h3M5 20h14a2 2 0 002-2V6a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" />
              </svg>
            </div>
            <div>
              <div className="font-semibold text-surface-100">Terminal Window</div>
              <div className="text-sm text-surface-400">Open a plain shell terminal</div>
            </div>
          </button>
        </div>
      </div>
    </div>
  );
}

export default EmptyState;
