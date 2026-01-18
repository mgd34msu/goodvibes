// ============================================================================
// BUILT-IN HOOK CARD COMPONENT
// ============================================================================

import { useState } from 'react';
import {
  Download,
  ChevronRight,
  Terminal,
  Tag,
} from 'lucide-react';
import { EVENT_TYPE_ICONS } from './types';
import { CATEGORY_COLORS, CATEGORY_LABELS, type BuiltinHook } from './builtinHooks';

interface BuiltinHookCardProps {
  hook: BuiltinHook;
  onInstall: (hook: BuiltinHook) => void;
}

export function BuiltinHookCard({ hook, onInstall }: BuiltinHookCardProps) {
  const [expanded, setExpanded] = useState(false);

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
            {EVENT_TYPE_ICONS[hook.eventType]}
          </div>

          {/* Info */}
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <h3 className="card-title-gradient text-base">{hook.name}</h3>
              <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs border ${CATEGORY_COLORS[hook.category]}`}>
                {CATEGORY_LABELS[hook.category]}
              </span>
              <span className="card-badge">
                built-in
              </span>
            </div>
            <p className="card-description mt-1">
              {hook.description}
            </p>
            <div className="flex items-center gap-2 mt-2 flex-wrap">
              <span className="text-xs text-surface-500">
                {hook.eventType}
                {hook.matcher && (
                  <span className="ml-1 font-mono text-surface-400">
                    ({hook.matcher})
                  </span>
                )}
              </span>
              {hook.tags.slice(0, 3).map((tag) => (
                <span
                  key={tag}
                  className="inline-flex items-center gap-1 px-1.5 py-0.5 bg-surface-800 text-surface-400 rounded text-xs"
                >
                  <Tag className="w-2.5 h-2.5" />
                  {tag}
                </span>
              ))}
              {hook.tags.length > 3 && (
                <span className="text-xs text-surface-500">
                  +{hook.tags.length - 3} more
                </span>
              )}
            </div>
          </div>
        </div>

        {/* Right Section: Install Button */}
        <div className="card-actions">
          <button
            onClick={() => onInstall(hook)}
            className="card-action-primary"
            title="Install hook"
          >
            <Download className="w-3.5 h-3.5" />
            Install
          </button>
        </div>
      </div>

      {/* Expanded Content */}
      {expanded && (
        <div className="card-expandable-content mt-4 pt-4 space-y-4">
          <div className="card-divider -mx-5" />

          {/* Command Preview */}
          <div>
            <span className="text-xs text-text-muted uppercase tracking-wider font-medium">
              Command Script
            </span>
            <div className="card-code-block mt-2 max-h-64 overflow-y-auto">
              <div className="flex items-start gap-2">
                <Terminal className="w-4 h-4 text-text-muted flex-shrink-0 mt-0.5" />
                <pre className="whitespace-pre-wrap break-words text-xs font-mono text-surface-300">
                  {hook.command}
                </pre>
              </div>
            </div>
          </div>

          {/* Hook Details */}
          <div className="grid grid-cols-3 gap-4">
            <div className="card p-3">
              <span className="text-xs text-text-muted uppercase tracking-wider">Event Type</span>
              <p className="text-sm text-text-primary font-medium mt-1">{hook.eventType}</p>
            </div>
            <div className="card p-3">
              <span className="text-xs text-text-muted uppercase tracking-wider">Timeout</span>
              <p className="text-sm text-text-primary font-medium mt-1">{hook.timeout}ms</p>
            </div>
            <div className="card p-3">
              <span className="text-xs text-text-muted uppercase tracking-wider">Matcher</span>
              <p className="text-sm text-text-primary font-medium mt-1 font-mono">
                {hook.matcher || 'None'}
              </p>
            </div>
          </div>

          {/* Tags */}
          <div>
            <span className="text-xs text-text-muted uppercase tracking-wider font-medium">
              Tags
            </span>
            <div className="flex flex-wrap gap-2 mt-2">
              {hook.tags.map((tag) => (
                <span
                  key={tag}
                  className="inline-flex items-center gap-1 px-2 py-1 bg-surface-800 text-surface-300 rounded text-xs"
                >
                  <Tag className="w-3 h-3" />
                  {tag}
                </span>
              ))}
            </div>
          </div>

          {/* Install Button */}
          <div className="flex justify-end pt-2">
            <button
              onClick={() => onInstall(hook)}
              className="card-action-primary"
            >
              <Download className="w-3.5 h-3.5" />
              Install to My Hooks
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
