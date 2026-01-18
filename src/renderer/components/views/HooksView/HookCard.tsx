// ============================================================================
// HOOK CARD COMPONENT - Premium Glass Morphism Design
// ============================================================================

import { useState } from 'react';
import {
  Play,
  Pause,
  Edit2,
  Trash2,
  CheckCircle,
  XCircle,
  Clock,
  ChevronRight,
  Terminal,
  MessageSquare,
} from 'lucide-react';
import { EVENT_TYPES, EVENT_TYPE_ICONS, type Hook } from './types';

interface HookCardProps {
  hook: Hook;
  onToggle: (id: number, enabled: boolean) => void;
  onEdit: (hook: Hook) => void;
  onDelete: (id: number) => void;
  onTest: (id: number) => void;
}

export function HookCard({ hook, onToggle, onEdit, onDelete, onTest }: HookCardProps) {
  const [expanded, setExpanded] = useState(false);

  const getResultBadge = () => {
    switch (hook.lastResult) {
      case 'success':
        return (
          <span className="card-badge card-badge-success">
            <CheckCircle className="w-3 h-3" />
            Success
          </span>
        );
      case 'failure':
        return (
          <span className="card-badge card-badge-error">
            <XCircle className="w-3 h-3" />
            Failed
          </span>
        );
      case 'timeout':
        return (
          <span className="card-badge card-badge-warning">
            <Clock className="w-3 h-3" />
            Timeout
          </span>
        );
      default:
        return null;
    }
  };

  return (
    <div className={`card-hover group ${!hook.enabled ? 'card-disabled' : ''}`}>
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
          <div className={`card-icon ${hook.enabled ? '' : 'opacity-50'}`}>
            {EVENT_TYPE_ICONS[hook.eventType]}
          </div>

          {/* Info */}
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <h3 className="card-title-gradient text-base">{hook.name}</h3>
              <span className="card-badge">
                {hook.scope}
              </span>
              <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs ${
                hook.hookType === 'prompt'
                  ? 'bg-blue-500/10 text-blue-400'
                  : 'bg-green-500/10 text-green-400'
              }`}>
                {hook.hookType === 'prompt' ? (
                  <><MessageSquare className="w-3 h-3" /> Prompt</>
                ) : (
                  <><Terminal className="w-3 h-3" /> Command</>
                )}
              </span>
              {hook.executionCount > 0 && getResultBadge()}
            </div>
            <p className="card-description">
              {EVENT_TYPES.find((t) => t.value === hook.eventType)?.label}
              {hook.matcher && hook.matcher !== '*' && (
                <span className="ml-2 font-mono text-xs text-text-muted">
                  ({hook.matcher})
                </span>
              )}
            </p>
            {hook.hookType === 'prompt' ? (
              <p className="text-xs text-surface-500 font-mono truncate mt-1">
                {hook.prompt && hook.prompt.length > 80 ? `${hook.prompt.slice(0, 80)}...` : hook.prompt}
              </p>
            ) : (
              <p className="text-xs text-surface-500 font-mono truncate mt-1">
                {hook.command}
              </p>
            )}
            {hook.executionCount > 0 && (
              <div className="card-meta mt-3">
                <span className="card-meta-item">
                  {hook.executionCount} executions
                </span>
              </div>
            )}
          </div>
        </div>

        {/* Right Section: Actions */}
        <div className="card-actions">
          <button
            onClick={() => onToggle(hook.id, !hook.enabled)}
            className={`card-action-btn ${
              hook.enabled
                ? 'card-action-btn-success text-success-400'
                : ''
            }`}
            title={hook.enabled ? 'Disable' : 'Enable'}
          >
            {hook.enabled ? (
              <Play className="w-4 h-4" />
            ) : (
              <Pause className="w-4 h-4" />
            )}
          </button>
          <button
            onClick={() => onEdit(hook)}
            className="card-action-btn card-action-btn-primary"
            title="Edit"
          >
            <Edit2 className="w-4 h-4" />
          </button>
          <button
            onClick={() => onDelete(hook.id)}
            className="card-action-btn card-action-btn-danger"
            title="Delete"
          >
            <Trash2 className="w-4 h-4" />
          </button>
        </div>
      </div>

      {/* Expanded Content */}
      {expanded && (
        <div className="card-expandable-content mt-4 pt-4 space-y-4">
          <div className="card-divider -mx-5" />

          <div>
            <span className="text-xs text-text-muted uppercase tracking-wider font-medium">
              {hook.hookType === 'prompt' ? 'Prompt' : 'Command'}
            </span>
            <div className="card-code-block mt-2 flex items-start gap-2">
              {hook.hookType === 'prompt' ? (
                <MessageSquare className="w-4 h-4 text-text-muted flex-shrink-0 mt-0.5" />
              ) : (
                <Terminal className="w-4 h-4 text-text-muted flex-shrink-0 mt-0.5" />
              )}
              <span className="whitespace-pre-wrap break-words">
                {hook.hookType === 'prompt' ? hook.prompt : hook.command}
              </span>
            </div>
          </div>

          <div className="grid grid-cols-3 gap-4">
            <div className="card p-3">
              <span className="text-xs text-text-muted uppercase tracking-wider">Timeout</span>
              <p className="text-sm text-text-primary font-medium mt-1">{hook.timeout}ms</p>
            </div>
            <div className="card p-3">
              <span className="text-xs text-text-muted uppercase tracking-wider">Executions</span>
              <p className="text-sm text-text-primary font-medium mt-1">{hook.executionCount}</p>
            </div>
            <div className="card p-3">
              <span className="text-xs text-text-muted uppercase tracking-wider">Last Run</span>
              <p className="text-sm text-text-primary font-medium mt-1">
                {hook.lastExecuted
                  ? new Date(hook.lastExecuted).toLocaleString()
                  : 'Never'}
              </p>
            </div>
          </div>

          <div className="flex justify-end">
            <button
              onClick={() => onTest(hook.id)}
              className="card-action-primary"
            >
              <Play className="w-3.5 h-3.5" />
              Test Hook
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
