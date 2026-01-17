// ============================================================================
// SKILL CARD COMPONENT - Premium Glass Morphism Design
// ============================================================================

import { useState } from 'react';
import {
  Sparkles,
  Edit2,
  Trash2,
  Copy,
  Check,
  Play,
  Star,
  Clock,
  ChevronRight,
} from 'lucide-react';
import type { SkillCardSkill } from './types';

interface SkillCardProps {
  skill: SkillCardSkill;
  onUse: () => void;
  onEdit?: () => void;
  onDelete?: () => void;
  onCopy: () => void;
}

export function SkillCard({ skill, onUse, onEdit, onDelete, onCopy }: SkillCardProps) {
  const [expanded, setExpanded] = useState(false);
  const [copied, setCopied] = useState(false);
  const isBuiltIn = 'isBuiltIn' in skill;

  const handleCopy = () => {
    onCopy();
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="card-hover group">
      {/* Main Content */}
      <div className="flex items-start justify-between gap-4">
        {/* Left Section: Expand + Icon + Info */}
        <div className="flex items-start gap-3 flex-1 min-w-0">
          {/* Expand Button */}
          <button
            onClick={() => setExpanded(!expanded)}
            className={`card-expand-btn mt-0.5 ${expanded ? 'expanded' : ''}`}
            aria-label={expanded ? 'Collapse' : 'Expand'}
          >
            <ChevronRight className="w-4 h-4" />
          </button>

          {/* Icon */}
          <div className="card-icon">
            <Sparkles className="w-5 h-5" />
          </div>

          {/* Info */}
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <h3 className="card-title-gradient text-base">/{skill.name}</h3>
              {isBuiltIn && (
                <span className="card-badge card-badge-primary">
                  Built-in
                </span>
              )}
              <span className="card-badge">
                {skill.scope}
              </span>
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
          <button
            onClick={onUse}
            className="card-action-primary"
          >
            <Play className="w-3.5 h-3.5" />
            Use
          </button>
          <button
            onClick={handleCopy}
            className={`card-action-btn ${copied ? 'text-success-400' : 'card-action-btn-primary'}`}
            title="Copy"
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

          <div className="card-code-block mt-4">
            {skill.content}
          </div>

          {skill.allowedTools && skill.allowedTools.length > 0 && (
            <div className="mt-4">
              <span className="text-xs text-text-muted uppercase tracking-wider font-medium">
                Allowed Tools
              </span>
              <div className="flex gap-1.5 mt-2 flex-wrap">
                {skill.allowedTools.map((tool) => (
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
