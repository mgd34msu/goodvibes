// ============================================================================
// COMPLETION STEP
// Setup complete confirmation
// ============================================================================

import { PartyPopper, Terminal, FolderKanban, Bot, Settings, Keyboard, Rocket } from 'lucide-react';

// ============================================================================
// Component
// ============================================================================

export function CompletionStep(): React.JSX.Element {
  return (
    <div className="space-y-8">
      {/* Success Message */}
      <div className="text-center">
        <div className="inline-flex items-center justify-center w-20 h-20 rounded-full bg-gradient-to-br from-success-500/20 to-primary-500/20 mb-6 relative">
          <PartyPopper className="w-10 h-10 text-success-400" />
          <div className="absolute inset-0 rounded-full animate-ping bg-success-500/10" />
        </div>
        <h3 className="text-xl font-medium text-surface-100 mb-2">
          You&apos;re All Set!
        </h3>
        <p className="text-surface-400 max-w-md mx-auto">
          GoodVibes is ready to supercharge your Claude CLI experience.
          Here are some things you can do next.
        </p>
      </div>

      {/* Quick Actions */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <QuickAction
          icon={<Terminal className="w-5 h-5" />}
          title="Start a Session"
          description="Open a new terminal and start chatting with Claude"
          shortcut="Ctrl+N"
        />
        <QuickAction
          icon={<FolderKanban className="w-5 h-5" />}
          title="Browse Sessions"
          description="View your past conversations and their details"
          shortcut="Ctrl+2"
        />
        <QuickAction
          icon={<Bot className="w-5 h-5" />}
          title="View Agents"
          description="Monitor sub-agents and their hierarchies"
          shortcut="Ctrl+8"
        />
        <QuickAction
          icon={<Settings className="w-5 h-5" />}
          title="Customize Settings"
          description="Fine-tune GoodVibes to your preferences"
          shortcut="Ctrl+,"
        />
      </div>

      {/* Keyboard Shortcuts Tip */}
      <div className="bg-surface-800/50 rounded-lg p-4 border border-surface-700">
        <div className="flex items-start gap-3">
          <div className="flex-shrink-0 w-10 h-10 rounded-lg bg-primary-500/10 flex items-center justify-center text-primary-400">
            <Keyboard className="w-5 h-5" />
          </div>
          <div>
            <h4 className="text-sm font-medium text-surface-200 mb-1">
              Pro Tip: Keyboard Shortcuts
            </h4>
            <p className="text-sm text-surface-400 mb-2">
              Press <kbd className="px-1.5 py-0.5 rounded bg-surface-700 text-xs font-mono">Ctrl+?</kbd> at any time to see all available keyboard shortcuts.
            </p>
            <p className="text-xs text-surface-500">
              Quick switcher: <kbd className="px-1 py-0.5 rounded bg-surface-700 text-xs font-mono">Ctrl+K</kbd> &bull;
              Command palette: <kbd className="px-1 py-0.5 rounded bg-surface-700 text-xs font-mono">Ctrl+Shift+P</kbd>
            </p>
          </div>
        </div>
      </div>

      {/* Ready Message */}
      <div className="text-center">
        <div className="inline-flex items-center gap-2 px-4 py-2 rounded-full bg-primary-500/10 text-primary-400">
          <Rocket className="w-4 h-4" />
          <span className="text-sm font-medium">Click &quot;Complete Setup&quot; to get started</span>
        </div>
      </div>
    </div>
  );
}

// ============================================================================
// Quick Action Card
// ============================================================================

interface QuickActionProps {
  icon: React.ReactNode;
  title: string;
  description: string;
  shortcut?: string;
}

function QuickAction({ icon, title, description, shortcut }: QuickActionProps) {
  return (
    <div className="flex gap-3 p-4 rounded-lg bg-surface-800/30 border border-surface-800 hover:border-surface-700 transition-colors">
      <div className="flex-shrink-0 w-10 h-10 rounded-lg bg-primary-500/10 flex items-center justify-center text-primary-400">
        {icon}
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-center justify-between gap-2 mb-1">
          <h4 className="text-sm font-medium text-surface-200">{title}</h4>
          {shortcut && (
            <kbd className="px-1.5 py-0.5 rounded bg-surface-700 text-xs font-mono text-surface-400">
              {shortcut}
            </kbd>
          )}
        </div>
        <p className="text-xs text-surface-500">{description}</p>
      </div>
    </div>
  );
}
