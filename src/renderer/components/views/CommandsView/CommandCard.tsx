// ============================================================================
// COMMAND CARD COMPONENT - Premium Glass Morphism Design
// ============================================================================

import { useState } from 'react';
import {
  Terminal,
  Download,
  Star,
  Clock,
  ChevronRight,
} from 'lucide-react';
import type { CommandCardCommand } from './types';

interface CommandCardProps {
  command: CommandCardCommand;
  onInstall?: () => void;
  onDelete?: () => void;
}

export function CommandCard({ command, onInstall, onDelete }: CommandCardProps): React.JSX.Element {
  const [expanded, setExpanded] = useState(false);
  const isBuiltIn = 'isBuiltIn' in command;

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
            <Terminal className="w-5 h-5" />
          </div>

          {/* Info */}
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <h3 className="card-title-gradient text-base">/{command.name}</h3>
              {isBuiltIn && (
                <span className="card-badge card-badge-primary">
                  Built-in
                </span>
              )}
              <span className="card-badge">
                {command.scope}
              </span>
            </div>
            {command.description && (
              <p className="card-description line-clamp-2">{command.description}</p>
            )}
            {!isBuiltIn && 'useCount' in command && command.useCount > 0 && (
              <div className="card-meta mt-3">
                <span className="card-meta-item">
                  <Star className="w-3 h-3" />
                  Used {command.useCount} times
                </span>
                {command.lastUsed && (
                  <span className="card-meta-item">
                    <Clock className="w-3 h-3" />
                    Last: {new Date(command.lastUsed).toLocaleDateString()}
                  </span>
                )}
              </div>
            )}
          </div>
        </div>

        {/* Right Section: Actions */}
        <div className="card-actions">
          {isBuiltIn ? (
            <button
              onClick={onInstall}
              className="card-action-primary"
            >
              <Download className="w-3.5 h-3.5" />
              Install
            </button>
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
        <div className="card-expandable-content mt-4 pt-4">
          <div className="card-divider -mx-5" />

          <div className="card-code-block mt-4">
            {command.content}
          </div>

          {command.allowedTools && command.allowedTools.length > 0 && (
            <div className="mt-4">
              <span className="text-xs text-text-muted uppercase tracking-wider font-medium">
                Allowed Tools
              </span>
              <div className="flex gap-1.5 mt-2 flex-wrap">
                {command.allowedTools.map((tool) => (
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
        </div>
      )}
    </div>
  );
}
