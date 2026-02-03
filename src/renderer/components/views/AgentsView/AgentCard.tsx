// ============================================================================
// AGENT CARD COMPONENT - Premium Glass Morphism Design
// ============================================================================

import { useState } from 'react';
import {
  ChevronRight,
  Zap,
  Download,
  Check,
} from 'lucide-react';
import type { AgentCardAgent } from './types';
import { AGENT_ICONS } from './constants';

interface AgentCardProps {
  agent: AgentCardAgent;
  onInstall?: () => void;
  onDelete?: () => void;
  isInstalled?: boolean;
}

export function AgentCard({ agent, onInstall, onDelete, isInstalled = false }: AgentCardProps): React.JSX.Element {
  const [expanded, setExpanded] = useState(false);
  const isBuiltIn = 'isBuiltIn' in agent;

  const icon = AGENT_ICONS[agent.name] || <Zap className="w-5 h-5" />;

  return (
    <div className="card-hover group">
      {/* Main Content */}
      <div className="flex items-start justify-between gap-4">
        {/* Left Section: Expand + Icon + Info (clickable to expand/collapse) */}
        <div
          className="flex items-start gap-3 flex-1 min-w-0 cursor-pointer"
          onClick={() => setExpanded(!expanded)}
        >
          {/* Expand Indicator */}
          <div
            className={`card-expand-btn mt-0.5 ${expanded ? 'expanded' : ''}`}
            aria-hidden="true"
          >
            <ChevronRight className="w-4 h-4" />
          </div>

          {/* Icon */}
          <div className="card-icon">
            {icon}
          </div>

          {/* Info */}
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <h3 className="card-title-gradient text-base">{agent.name}</h3>
              {isBuiltIn && (
                <span className="card-badge card-badge-primary">
                  Built-in
                </span>
              )}
              <span className="card-badge">
                {agent.cwd ? 'project' : 'user'}
              </span>
              {agent.model && (
                <span className="card-badge">
                  {agent.model.replace('claude-', '').replace(/-\d+$/, '')}
                </span>
              )}
            </div>
            {agent.description && (
              <p className="card-description line-clamp-2">{agent.description}</p>
            )}
            {!isBuiltIn && 'createdAt' in agent && (
              <div className="card-meta mt-3">
                <span>Created: {new Date(agent.createdAt).toLocaleDateString()}</span>
              </div>
            )}
          </div>
        </div>

        {/* Right Section: Actions */}
        <div className="card-actions">
          {isBuiltIn ? (
            isInstalled ? (
              <span className="px-3 py-1.5 text-sm font-medium rounded-lg bg-success-500/20 text-success-400 flex items-center gap-1.5">
                <Check className="w-3.5 h-3.5" />
                Installed
              </span>
            ) : (
              <button
                onClick={onInstall}
                className="card-action-primary"
              >
                <Download className="w-3.5 h-3.5" />
                Install
              </button>
            )
          ) : (
            <button
              onClick={onDelete}
              className="px-3 py-1.5 text-sm font-medium rounded-lg bg-error-500/20 text-error-400 hover:bg-error-500/30 transition-colors"
            >
              Delete
            </button>
          )}
        </div>
      </div>

      {/* Expanded Content */}
      {expanded && (
        <div className="card-expandable-content mt-4 pt-4 space-y-4">
          <div className="card-divider -mx-5" />

          {agent.initialPrompt && (
            <div>
              <span className="text-xs text-text-muted uppercase tracking-wider font-medium">
                Initial Prompt
              </span>
              <div className="card-code-block mt-2">
                {agent.initialPrompt}
              </div>
            </div>
          )}

          {agent.claudeMdContent && (
            <div>
              <span className="text-xs text-text-muted uppercase tracking-wider font-medium">
                CLAUDE.md Content
              </span>
              <div className="card-code-block mt-2">
                {agent.claudeMdContent}
              </div>
            </div>
          )}

          <div className="flex flex-wrap gap-4">
            {agent.permissionMode && agent.permissionMode !== 'default' && (
              <div>
                <span className="text-xs text-text-muted">Permission Mode:</span>
                <span className="ml-2 card-badge card-badge-warning">
                  {agent.permissionMode}
                </span>
              </div>
            )}

            {agent.allowedTools && agent.allowedTools.length > 0 && (
              <div>
                <span className="text-xs text-text-muted">Allowed Tools:</span>
                <div className="flex gap-1.5 mt-1.5 flex-wrap">
                  {agent.allowedTools.map((tool) => (
                    <span
                      key={tool}
                      className="card-badge"
                    >
                      {tool}
                    </span>
                  ))}
                </div>
              </div>
            )}

            {agent.flags && agent.flags.length > 0 && (
              <div>
                <span className="text-xs text-text-muted">CLI Flags:</span>
                <div className="flex gap-1.5 mt-1.5 flex-wrap">
                  {agent.flags.map((flag) => (
                    <span
                      key={flag}
                      className="card-badge font-mono"
                    >
                      {flag}
                    </span>
                  ))}
                </div>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
