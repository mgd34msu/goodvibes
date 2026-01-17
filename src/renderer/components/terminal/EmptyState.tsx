// ============================================================================
// EMPTY STATE - Premium welcome screen when no sessions are open
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

      <div className="text-center max-w-xl mx-auto px-8 relative z-10">
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
          Start a new Claude Code session to begin working on your project, or open a plain terminal.
        </p>

        {/* Action Cards */}
        <div className="flex flex-col sm:flex-row gap-4 justify-center">
          {/* Claude Session Card */}
          <button
            onClick={onNewSession}
            className="group relative flex items-center gap-4 px-6 py-5 rounded-2xl text-left transition-all duration-300 hover:-translate-y-1 focus:outline-none focus:ring-2 focus:ring-primary-500/50 focus:ring-offset-2 focus:ring-offset-surface-900"
            aria-label="Start new Claude Code session"
          >
            {/* Card Background */}
            <div className="absolute inset-0 rounded-2xl bg-gradient-to-br from-surface-800/80 to-surface-900/80 border border-surface-700/50 group-hover:border-primary-500/30 transition-colors" />
            <div className="absolute inset-0 rounded-2xl opacity-0 group-hover:opacity-100 transition-opacity bg-gradient-to-br from-primary-500/5 to-transparent" />

            {/* Icon */}
            <div className="relative flex-shrink-0 w-14 h-14 rounded-xl bg-gradient-to-br from-primary-500/20 to-primary-600/10 flex items-center justify-center border border-primary-500/20 group-hover:border-primary-500/40 group-hover:shadow-lg group-hover:shadow-primary-500/10 transition-all">
              <svg className="w-7 h-7 text-primary-400 group-hover:scale-110 transition-transform" fill="none" viewBox="0 0 24 24" stroke="currentColor" aria-hidden="true">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9.75 17L9 20l-1 1h8l-1-1-.75-3M3 13h18M5 17h14a2 2 0 002-2V5a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" />
              </svg>
            </div>

            {/* Text */}
            <div className="relative">
              <div className="font-semibold text-surface-100 group-hover:text-white transition-colors">Claude Code Session</div>
              <div className="text-sm text-surface-500 group-hover:text-surface-400 transition-colors">Start a new Claude CLI session</div>
            </div>

            {/* Arrow indicator */}
            <svg className="relative w-5 h-5 text-surface-600 group-hover:text-primary-400 group-hover:translate-x-1 transition-all ml-auto" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
            </svg>
          </button>

          {/* Terminal Card */}
          <button
            onClick={onNewTerminal}
            className="group relative flex items-center gap-4 px-6 py-5 rounded-2xl text-left transition-all duration-300 hover:-translate-y-1 focus:outline-none focus:ring-2 focus:ring-success-500/50 focus:ring-offset-2 focus:ring-offset-surface-900"
            aria-label="Open new terminal"
          >
            {/* Card Background */}
            <div className="absolute inset-0 rounded-2xl bg-gradient-to-br from-surface-800/80 to-surface-900/80 border border-surface-700/50 group-hover:border-success-500/30 transition-colors" />
            <div className="absolute inset-0 rounded-2xl opacity-0 group-hover:opacity-100 transition-opacity bg-gradient-to-br from-success-500/5 to-transparent" />

            {/* Icon */}
            <div className="relative flex-shrink-0 w-14 h-14 rounded-xl bg-gradient-to-br from-success-500/20 to-success-600/10 flex items-center justify-center border border-success-500/20 group-hover:border-success-500/40 group-hover:shadow-lg group-hover:shadow-success-500/10 transition-all">
              <svg className="w-7 h-7 text-success-400 group-hover:scale-110 transition-transform" fill="none" viewBox="0 0 24 24" stroke="currentColor" aria-hidden="true">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M8 9l3 3-3 3m5 0h3M5 20h14a2 2 0 002-2V6a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" />
              </svg>
            </div>

            {/* Text */}
            <div className="relative">
              <div className="font-semibold text-surface-100 group-hover:text-white transition-colors">Terminal Window</div>
              <div className="text-sm text-surface-500 group-hover:text-surface-400 transition-colors">Open a plain shell terminal</div>
            </div>

            {/* Arrow indicator */}
            <svg className="relative w-5 h-5 text-surface-600 group-hover:text-success-400 group-hover:translate-x-1 transition-all ml-auto" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
            </svg>
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
