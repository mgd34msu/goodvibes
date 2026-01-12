// ============================================================================
// WELCOME STEP
// First step of onboarding - welcome and overview
// ============================================================================

import { Sparkles, Terminal, FolderOpen, Settings, Zap } from 'lucide-react';

// ============================================================================
// Component
// ============================================================================

export function WelcomeStep() {
  return (
    <div className="space-y-8">
      {/* Hero */}
      <div className="text-center">
        <div className="inline-flex items-center justify-center w-20 h-20 rounded-2xl bg-gradient-to-br from-primary-500 to-accent-500 mb-6">
          <Sparkles className="w-10 h-10 text-white" />
        </div>
        <h3 className="text-xl font-medium text-surface-100 mb-2">
          Welcome to GoodVibes
        </h3>
        <p className="text-surface-400 max-w-md mx-auto">
          Your enhanced Claude CLI experience. Let&apos;s get you set up in just a few steps.
        </p>
      </div>

      {/* Features Overview */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <FeatureCard
          icon={<Terminal className="w-5 h-5" />}
          title="Terminal Integration"
          description="Run Claude CLI directly within GoodVibes with full terminal support."
        />
        <FeatureCard
          icon={<FolderOpen className="w-5 h-5" />}
          title="Session Management"
          description="Browse, search, and analyze all your Claude sessions in one place."
        />
        <FeatureCard
          icon={<Zap className="w-5 h-5" />}
          title="Agents & Skills"
          description="Extend Claude with custom agents and reusable skill commands."
        />
        <FeatureCard
          icon={<Settings className="w-5 h-5" />}
          title="Hooks & Automation"
          description="Automate workflows with pre and post execution hooks."
        />
      </div>

      {/* Quick Start Info */}
      <div className="bg-surface-800/50 rounded-lg p-4 border border-surface-700">
        <h4 className="text-sm font-medium text-surface-200 mb-2">
          What you&apos;ll set up:
        </h4>
        <ul className="space-y-2 text-sm text-surface-400">
          <li className="flex items-center gap-2">
            <span className="w-1.5 h-1.5 rounded-full bg-primary-500" />
            Configure your projects directory
          </li>
          <li className="flex items-center gap-2">
            <span className="w-1.5 h-1.5 rounded-full bg-primary-500" />
            Learn about agents and subagents
          </li>
          <li className="flex items-center gap-2">
            <span className="w-1.5 h-1.5 rounded-full bg-primary-500" />
            Set up optional automation hooks
          </li>
        </ul>
      </div>
    </div>
  );
}

// ============================================================================
// Feature Card
// ============================================================================

interface FeatureCardProps {
  icon: React.ReactNode;
  title: string;
  description: string;
}

function FeatureCard({ icon, title, description }: FeatureCardProps) {
  return (
    <div className="flex gap-3 p-4 rounded-lg bg-surface-800/30 border border-surface-800">
      <div className="flex-shrink-0 w-10 h-10 rounded-lg bg-primary-500/10 flex items-center justify-center text-primary-400">
        {icon}
      </div>
      <div>
        <h4 className="text-sm font-medium text-surface-200 mb-1">{title}</h4>
        <p className="text-xs text-surface-500">{description}</p>
      </div>
    </div>
  );
}
