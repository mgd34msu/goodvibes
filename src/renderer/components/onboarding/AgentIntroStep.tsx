// ============================================================================
// AGENT INTRO STEP
// Explain the agent system
// ============================================================================

import { Bot, GitBranch, Network, Eye, Users } from 'lucide-react';
import { clsx } from 'clsx';

// ============================================================================
// Component
// ============================================================================

export function AgentIntroStep() {
  return (
    <div className="space-y-6">
      {/* Introduction */}
      <div className="text-center mb-8">
        <div className="inline-flex items-center justify-center w-16 h-16 rounded-2xl bg-accent-500/20 mb-4">
          <Bot className="w-8 h-8 text-accent-400" />
        </div>
        <p className="text-surface-400 max-w-lg mx-auto">
          Claude CLI can spawn autonomous sub-agents to handle complex tasks.
          GoodVibes helps you track and manage these agents.
        </p>
      </div>

      {/* Agent Types */}
      <div className="space-y-3">
        <h4 className="text-sm font-medium text-surface-300">Understanding Agents</h4>

        <AgentTypeCard
          icon={<Users className="w-5 h-5" />}
          title="User Sessions"
          description="Sessions you start directly through the terminal. These are your main interactions with Claude."
          color="primary"
        />

        <AgentTypeCard
          icon={<Bot className="w-5 h-5" />}
          title="Sub-agents"
          description="Autonomous agents spawned by Claude to handle specific tasks. They work independently and report back."
          color="accent"
        />

        <AgentTypeCard
          icon={<GitBranch className="w-5 h-5" />}
          title="Agent Hierarchy"
          description="Agents can spawn their own sub-agents, creating a tree of workers tackling different parts of a problem."
          color="warning"
        />
      </div>

      {/* Features */}
      <div className="bg-surface-800/50 rounded-lg p-4 border border-surface-700">
        <h4 className="text-sm font-medium text-surface-200 mb-3">
          What GoodVibes Tracks
        </h4>
        <div className="grid grid-cols-2 gap-3">
          <FeatureItem
            icon={<Network className="w-4 h-4" />}
            text="Agent relationships"
          />
          <FeatureItem
            icon={<Eye className="w-4 h-4" />}
            text="Real-time status"
          />
          <FeatureItem
            icon={<GitBranch className="w-4 h-4" />}
            text="Session lineage"
          />
          <FeatureItem
            icon={<Bot className="w-4 h-4" />}
            text="Token usage"
          />
        </div>
      </div>

      {/* Visibility Setting */}
      <div className="bg-surface-800/30 rounded-lg p-4 border border-surface-700/50">
        <div className="flex items-start gap-3">
          <div className="mt-1">
            <InfoIcon />
          </div>
          <div>
            <h5 className="text-sm font-medium text-surface-200 mb-1">
              Agent Session Visibility
            </h5>
            <p className="text-sm text-surface-400 mb-3">
              By default, sub-agent sessions are hidden in the sessions list to reduce clutter.
              You can view them in the Agents tab or change this in Settings.
            </p>
            <div className="flex items-center gap-2 text-xs text-surface-500">
              <span className="px-2 py-0.5 rounded bg-surface-700">
                Settings &rarr; Hide Agent Sessions
              </span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

// ============================================================================
// Agent Type Card
// ============================================================================

interface AgentTypeCardProps {
  icon: React.ReactNode;
  title: string;
  description: string;
  color: 'primary' | 'accent' | 'warning';
}

function AgentTypeCard({ icon, title, description, color }: AgentTypeCardProps) {
  const colorClasses = {
    primary: 'bg-primary-500/10 text-primary-400 border-primary-500/20',
    accent: 'bg-accent-500/10 text-accent-400 border-accent-500/20',
    warning: 'bg-warning-500/10 text-warning-400 border-warning-500/20',
  };

  return (
    <div className={clsx(
      'flex gap-3 p-4 rounded-lg border',
      colorClasses[color]
    )}>
      <div className="flex-shrink-0 mt-0.5">{icon}</div>
      <div>
        <h5 className="text-sm font-medium text-surface-200 mb-1">{title}</h5>
        <p className="text-xs text-surface-500">{description}</p>
      </div>
    </div>
  );
}

// ============================================================================
// Feature Item
// ============================================================================

interface FeatureItemProps {
  icon: React.ReactNode;
  text: string;
}

function FeatureItem({ icon, text }: FeatureItemProps) {
  return (
    <div className="flex items-center gap-2 text-sm text-surface-400">
      <span className="text-primary-400">{icon}</span>
      {text}
    </div>
  );
}

// ============================================================================
// Info Icon
// ============================================================================

function InfoIcon() {
  return (
    <div className="w-5 h-5 rounded-full bg-primary-500/20 flex items-center justify-center">
      <span className="text-xs font-medium text-primary-400">i</span>
    </div>
  );
}
