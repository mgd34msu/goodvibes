// ============================================================================
// PROJECT CARD COMPONENT - Premium Glass Morphism Design
// ============================================================================

import { useState } from 'react';
import { clsx } from 'clsx';
import {
  Plus,
  History,
  MoreHorizontal,
  Settings,
  FileText,
  Trash2,
  FolderOpen,
  Hash,
  Coins,
  Calendar,
} from 'lucide-react';
import type { RegisteredProject, ProjectTemplate, ProjectAnalytics } from './types';

interface ProjectCardProps {
  project: RegisteredProject;
  analytics?: ProjectAnalytics;
  templates: ProjectTemplate[];
  isSelected: boolean;
  onSelect: () => void;
  onNewSession: () => void;
  onOpenPreviousSession: () => void;
  onRemove: () => void;
  onOpenSettings: () => void;
  onApplyTemplate: (templateId: number) => void;
  onCreateTemplate: () => void;
  formatDate: (date: string) => string;
  formatCurrency: (value: number) => string;
}

export function ProjectCard({
  project,
  analytics,
  templates,
  isSelected,
  onSelect,
  onNewSession,
  onOpenPreviousSession,
  onRemove,
  onOpenSettings,
  onApplyTemplate,
  onCreateTemplate,
  formatDate,
  formatCurrency,
}: ProjectCardProps) {
  const [showMenu, setShowMenu] = useState(false);
  const [showTemplateMenu, setShowTemplateMenu] = useState(false);

  return (
    <div
      className={clsx(
        'card-hover cursor-pointer',
        isSelected && 'card-selected'
      )}
      onClick={onSelect}
    >
      {/* Main Content */}
      <div className="flex items-start gap-4">
        {/* Left Section: Icon + Info */}
        <div className="flex items-start gap-3 flex-1 min-w-0">
          {/* Icon */}
          <div className="card-icon">
            <FolderOpen className="w-5 h-5" />
          </div>

          {/* Info */}
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <h3 className="card-title-gradient text-base">{project.name}</h3>
              {project.settings.tags?.map((tag, i) => (
                <span key={i} className="card-badge">
                  {tag}
                </span>
              ))}
            </div>
            <p className="text-xs text-text-muted truncate mt-1 font-mono">{project.path}</p>
            {project.description && (
              <p className="card-description line-clamp-2 mt-2">{project.description}</p>
            )}

            {/* Quick Stats */}
            <div className="card-meta mt-3">
              <span className="card-meta-item">
                <Calendar className="w-3 h-3" />
                {formatDate(project.lastOpened)}
              </span>
              {analytics && (
                <>
                  <span className="card-meta-item">
                    <Hash className="w-3 h-3" />
                    {(analytics.totalSessions ?? 0).toLocaleString()} sessions
                  </span>
                  <span className="card-meta-item">
                    <Coins className="w-3 h-3" />
                    {formatCurrency(analytics.totalCostUsd ?? 0)}
                  </span>
                  <span
                    className="card-meta-item"
                    title={`Input: ${(analytics.inputTokens ?? 0).toLocaleString()} | Output: ${(analytics.outputTokens ?? 0).toLocaleString()} | Cache Read: ${(analytics.cacheReadTokens ?? 0).toLocaleString()} | Cache Write: ${(analytics.cacheWriteTokens ?? 0).toLocaleString()}`}
                  >
                    {(analytics.totalTokens ?? 0).toLocaleString()} tokens
                  </span>
                </>
              )}
            </div>
          </div>
        </div>

        {/* Right Section: Actions */}
        <div className="card-actions" onClick={e => e.stopPropagation()}>
          <button
            onClick={onNewSession}
            className="card-action-primary"
            title="Start a new Claude session for this project"
          >
            <Plus className="w-3.5 h-3.5" />
            New Session
          </button>
          <button
            onClick={onOpenPreviousSession}
            className="card-action-btn card-action-btn-primary"
            title="Open a previous session"
          >
            <History className="w-4 h-4" />
          </button>
          <div className="relative">
            <button
              onClick={() => setShowMenu(!showMenu)}
              className="card-action-btn"
              title="More options"
            >
              <MoreHorizontal className="w-4 h-4" />
            </button>
            {showMenu && (
              <div
                className="absolute right-0 top-full mt-1 w-48 card p-1 z-[9959]"
                onClick={e => e.stopPropagation()}
              >
                <button
                  onClick={() => { onOpenSettings(); setShowMenu(false); }}
                  className="w-full px-3 py-2 text-left text-sm rounded-lg hover:bg-white/5 text-text-secondary flex items-center gap-2 transition-colors"
                >
                  <Settings className="w-4 h-4" />
                  Settings
                </button>
                <button
                  onClick={() => { onCreateTemplate(); setShowMenu(false); }}
                  className="w-full px-3 py-2 text-left text-sm rounded-lg hover:bg-white/5 text-text-secondary flex items-center gap-2 transition-colors"
                >
                  <FileText className="w-4 h-4" />
                  Create Template
                </button>
                {templates.length > 0 && (
                  <div className="relative">
                    <button
                      onClick={() => setShowTemplateMenu(!showTemplateMenu)}
                      className="w-full px-3 py-2 text-left text-sm rounded-lg hover:bg-white/5 text-text-secondary flex items-center justify-between transition-colors"
                    >
                      <span className="flex items-center gap-2">
                        <FileText className="w-4 h-4" />
                        Apply Template
                      </span>
                      <span className="text-text-muted">&#8250;</span>
                    </button>
                    {showTemplateMenu && (
                      <div className="absolute left-full top-0 w-48 card p-1">
                        {templates.map(template => (
                          <button
                            key={template.id}
                            onClick={() => {
                              onApplyTemplate(template.id);
                              setShowTemplateMenu(false);
                              setShowMenu(false);
                            }}
                            className="w-full px-3 py-2 text-left text-sm rounded-lg hover:bg-white/5 text-text-secondary transition-colors"
                          >
                            {template.name}
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                )}
                <div className="card-divider my-1" />
                <button
                  onClick={() => { onRemove(); setShowMenu(false); }}
                  className="w-full px-3 py-2 text-left text-sm rounded-lg hover:bg-error-500/10 text-error-400 flex items-center gap-2 transition-colors"
                >
                  <Trash2 className="w-4 h-4" />
                  Remove
                </button>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
