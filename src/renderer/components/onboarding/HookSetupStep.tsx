// ============================================================================
// HOOK SETUP STEP
// Guide for setting up hooks
// ============================================================================

import { useState } from 'react';
import { Play, CheckCircle, Terminal, FileCode, Zap, Copy, Check } from 'lucide-react';
import { clsx } from 'clsx';
import { createLogger } from '../../../shared/logger';

const logger = createLogger('HookSetupStep');

// ============================================================================
// Component
// ============================================================================

export function HookSetupStep(): React.JSX.Element {
  return (
    <div className="space-y-6">
      {/* Introduction */}
      <div className="text-center mb-6">
        <div className="inline-flex items-center justify-center w-16 h-16 rounded-2xl bg-success-500/20 mb-4">
          <Zap className="w-8 h-8 text-success-400" />
        </div>
        <p className="text-surface-400 max-w-lg mx-auto">
          Hooks let you run custom scripts before or after Claude executes commands.
          This is optional but powerful for automation.
        </p>
      </div>

      {/* Hook Types */}
      <div className="space-y-3">
        <h4 className="text-sm font-medium text-surface-300">Available Hooks</h4>

        <HookTypeCard
          icon={<Play className="w-4 h-4" />}
          title="PreToolUse"
          description="Runs before Claude uses a tool (like Read, Write, Bash). Can approve, deny, or modify the action."
          example="Prevent writes to protected files"
        />

        <HookTypeCard
          icon={<CheckCircle className="w-4 h-4" />}
          title="PostToolUse"
          description="Runs after a tool completes. Useful for logging, notifications, or follow-up actions."
          example="Log all file changes to a journal"
        />

        <HookTypeCard
          icon={<Terminal className="w-4 h-4" />}
          title="Stop"
          description="Called when Claude's main loop is about to stop. Perfect for cleanup or final actions."
          example="Auto-commit changes when done"
        />
      </div>

      {/* Example Hook */}
      <div className="space-y-3">
        <h4 className="text-sm font-medium text-surface-300">Example: Notify on Completion</h4>
        <CodeBlock
          code={`// hooks/notify-complete.js
export default {
  event: 'Stop',
  handler: async (context) => {
    // Show system notification when Claude finishes
    new Notification('Claude Complete', {
      body: 'Your task has finished!'
    });
    return { continue: true };
  }
}`}
        />
      </div>

      {/* Setup Instructions */}
      <div className="bg-surface-800/50 rounded-lg p-4 border border-surface-700">
        <h4 className="text-sm font-medium text-surface-200 mb-3 flex items-center gap-2">
          <FileCode className="w-4 h-4" />
          Quick Setup
        </h4>
        <ol className="space-y-2 text-sm text-surface-400">
          <li className="flex gap-2">
            <span className="text-primary-400 font-medium">1.</span>
            Create a <code className="px-1 py-0.5 bg-surface-700 rounded text-xs">.claude/hooks/</code> directory in your project
          </li>
          <li className="flex gap-2">
            <span className="text-primary-400 font-medium">2.</span>
            Add JavaScript or TypeScript hook files
          </li>
          <li className="flex gap-2">
            <span className="text-primary-400 font-medium">3.</span>
            Configure hooks in <code className="px-1 py-0.5 bg-surface-700 rounded text-xs">.claude/settings.json</code>
          </li>
          <li className="flex gap-2">
            <span className="text-primary-400 font-medium">4.</span>
            View and manage hooks in the Hooks tab
          </li>
        </ol>
      </div>

      {/* Skip Note */}
      <div className="text-center text-sm text-surface-500">
        You can set up hooks later from the Hooks tab. This step is optional.
      </div>
    </div>
  );
}

// ============================================================================
// Hook Type Card
// ============================================================================

interface HookTypeCardProps {
  icon: React.ReactNode;
  title: string;
  description: string;
  example: string;
}

function HookTypeCard({ icon, title, description, example }: HookTypeCardProps) {
  return (
    <div className="flex gap-3 p-3 rounded-lg bg-surface-800/30 border border-surface-800">
      <div className="flex-shrink-0 w-8 h-8 rounded-lg bg-surface-700 flex items-center justify-center text-surface-400">
        {icon}
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 mb-1">
          <h5 className="text-sm font-medium text-surface-200">{title}</h5>
        </div>
        <p className="text-xs text-surface-500 mb-1">{description}</p>
        <p className="text-xs text-primary-400/80">
          <span className="text-surface-600">Example:</span> {example}
        </p>
      </div>
    </div>
  );
}

// ============================================================================
// Code Block
// ============================================================================

interface CodeBlockProps {
  code: string;
  language?: string;
}

function CodeBlock({ code }: CodeBlockProps) {
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (err) {
      logger.error('Failed to copy:', err);
    }
  };

  return (
    <div className="relative group">
      <pre className="p-4 rounded-lg bg-surface-900 border border-surface-800 text-xs overflow-x-auto">
        <code className="text-surface-300">{code}</code>
      </pre>
      <button
        onClick={handleCopy}
        className={clsx(
          'absolute top-2 right-2 p-1.5 rounded-md transition-all',
          'opacity-0 group-hover:opacity-100',
          copied
            ? 'bg-success-500/20 text-success-400'
            : 'bg-surface-700 text-surface-400 hover:text-surface-200'
        )}
        aria-label={copied ? 'Copied' : 'Copy code'}
      >
        {copied ? <Check className="w-4 h-4" /> : <Copy className="w-4 h-4" />}
      </button>
    </div>
  );
}
