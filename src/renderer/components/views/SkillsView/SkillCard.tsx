// ============================================================================
// AGENT SKILL CARD COMPONENT - Premium Glass Morphism Design
// ============================================================================

import { useState } from 'react';
import {
  Sparkles,
  Download,
  Star,
  Clock,
  ChevronRight,
  Wrench,
  Tag,
} from 'lucide-react';
import type { SkillCardSkill } from './types';

interface SkillCardProps {
  skill: SkillCardSkill;
  onInstall?: () => void;
  onDelete?: () => void;
}

export function SkillCard({
  skill,
  onInstall,
  onDelete,
}: SkillCardProps) {
  const [expanded, setExpanded] = useState(false);
  const isBuiltIn = 'isBuiltIn' in skill;

  // Format skill invocation for display
  const invocationText = `Skill skill: "${skill.name}"`;

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
            <Sparkles className="w-5 h-5" />
          </div>

          {/* Info */}
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <h3 className="card-title-gradient text-base">{skill.name}</h3>
              {isBuiltIn && (
                <span className="card-badge card-badge-primary">Built-in</span>
              )}
              <span className="card-badge">{skill.scope}</span>
              {skill.version && (
                <span className="card-badge">
                  <Tag className="w-3 h-3 mr-1" />
                  v{skill.version}
                </span>
              )}
            </div>
            {skill.description && (
              <p className="card-description line-clamp-2">{skill.description}</p>
            )}
            {!isBuiltIn && 'useCount' in skill && skill.useCount > 0 && (
              <div className="card-meta mt-3">
                <span className="card-meta-item">
                  <Star className="w-3 h-3" />
                  Used {skill.useCount} times
                </span>
                {skill.lastUsed && (
                  <span className="card-meta-item">
                    <Clock className="w-3 h-3" />
                    Last: {new Date(skill.lastUsed).toLocaleDateString()}
                  </span>
                )}
              </div>
            )}
          </div>
        </div>

        {/* Right Section: Actions */}
        <div className="card-actions">
          {isBuiltIn ? (
            <button onClick={onInstall} className="card-action-primary">
              <Download className="w-3.5 h-3.5" />
              Install
            </button>
          ) : (
            <button onClick={onUse} className="card-action-primary">
              <Play className="w-3.5 h-3.5" />
              Use
            </button>
          )}
          <button
            onClick={handleCopy}
            className={`card-action-btn ${copied ? 'text-success-400' : 'card-action-btn-primary'}`}
            title="Copy skill invocation"
          >
            {copied ? (
              <Check className="w-4 h-4" />
            ) : (
              <Copy className="w-4 h-4" />
            )}
          </button>
          {!isBuiltIn && onEdit && (
            <button
              onClick={onEdit}
              className="card-action-btn card-action-btn-primary"
              title="Edit"
            >
              <Edit2 className="w-4 h-4" />
            </button>
          )}
          {!isBuiltIn && onDelete && (
            <button
              onClick={onDelete}
              className="card-action-btn card-action-btn-danger"
              title="Delete"
            >
              <Trash2 className="w-4 h-4" />
            </button>
          )}
        </div>
      </div>

      {/* Expanded Content */}
      {expanded && (
        <div className="card-expandable-content mt-4 pt-4">
          <div className="card-divider -mx-5" />

          {/* Invocation Example */}
          <div className="mt-4 mb-4">
            <span className="text-xs text-text-muted uppercase tracking-wider font-medium">
              Agent Invocation
            </span>
            <div className="mt-2 bg-surface-900/50 rounded-lg p-3 font-mono text-sm text-accent-purple">
              {invocationText}
            </div>
          </div>

          {/* Skill Content */}
          <div>
            <span className="text-xs text-text-muted uppercase tracking-wider font-medium">
              Skill Content (SKILL.md)
            </span>
            <div className="card-code-block mt-2">{skill.content}</div>
          </div>

          {skill.allowedTools && skill.allowedTools.length > 0 && (
            <div className="mt-4">
              <div className="flex items-center gap-2 mb-2">
                <Wrench className="w-3.5 h-3.5 text-surface-500" />
                <span className="text-xs text-text-muted uppercase tracking-wider font-medium">
                  Allowed Tools
                </span>
              </div>
              <div className="flex gap-1.5 flex-wrap">
                {skill.allowedTools.map((tool) => (
                  <span key={tool} className="card-badge">
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
