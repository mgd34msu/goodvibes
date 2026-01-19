// ============================================================================
// TEMPLATE SELECTOR COMPONENT
// ============================================================================

import { useState } from 'react';
import { clsx } from 'clsx';
import { ChevronDown, ChevronRight, User, FolderGit2, FileCode } from 'lucide-react';
import { DEFAULT_TEMPLATES, type MemoryTemplate } from './types';

interface TemplateSelectorProps {
  onSelect: (template: MemoryTemplate) => void;
  /** Filter templates by scope (optional) */
  filterScope?: 'user' | 'project' | 'local';
}

const SCOPE_CONFIG = {
  user: {
    label: 'User',
    description: '~/.claude/CLAUDE.md',
    icon: User,
    color: 'bg-accent-purple/20 text-accent-purple border-accent-purple/30',
  },
  project: {
    label: 'Project',
    description: './CLAUDE.md',
    icon: FolderGit2,
    color: 'bg-primary-500/20 text-primary-400 border-primary-500/30',
  },
  local: {
    label: 'Local',
    description: './CLAUDE.local.md',
    icon: FileCode,
    color: 'bg-warning-500/20 text-warning-400 border-warning-500/30',
  },
} as const;

function ScopeBadge({ scope }: { scope: 'user' | 'project' | 'local' }) {
  const config = SCOPE_CONFIG[scope];
  const Icon = config.icon;

  return (
    <span
      className={clsx(
        'inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs font-medium border',
        config.color
      )}
      title={config.description}
    >
      <Icon className="w-3 h-3" />
      {config.label}
    </span>
  );
}

export function TemplateSelector({ onSelect, filterScope }: TemplateSelectorProps): React.JSX.Element {
  const [expanded, setExpanded] = useState(false);

  // Filter templates by scope if specified
  const templates = filterScope
    ? DEFAULT_TEMPLATES.filter((t) => t.scope === filterScope)
    : DEFAULT_TEMPLATES;

  // Group templates by scope for better organization
  const groupedTemplates = {
    user: templates.filter((t) => t.scope === 'user'),
    project: templates.filter((t) => t.scope === 'project'),
    local: templates.filter((t) => t.scope === 'local'),
  };

  const hasMultipleScopes = !filterScope && (
    groupedTemplates.user.length > 0 &&
    groupedTemplates.project.length > 0 ||
    groupedTemplates.project.length > 0 &&
    groupedTemplates.local.length > 0 ||
    groupedTemplates.user.length > 0 &&
    groupedTemplates.local.length > 0
  );

  return (
    <div className="border border-surface-700 rounded-lg">
      <button
        onClick={() => setExpanded(!expanded)}
        aria-expanded={expanded}
        className={clsx(
          'w-full flex items-center justify-between px-4 py-3 text-surface-200 transition-all duration-200',
          'rounded-t-lg',
          expanded
            ? 'bg-gradient-to-b from-primary-500/10 to-primary-600/5 border-b border-surface-700'
            : 'bg-surface-800 hover:bg-surface-700 rounded-b-lg'
        )}
      >
        <span className="font-medium leading-normal">Insert Template</span>
        {expanded ? (
          <ChevronDown className="w-4 h-4 text-primary-400" />
        ) : (
          <ChevronRight className="w-4 h-4" />
        )}
      </button>

      {expanded && (
        <div className="p-4 space-y-4 bg-surface-900 max-h-96 overflow-y-auto">
          {hasMultipleScopes ? (
            // Grouped view when showing multiple scopes
            <>
              {groupedTemplates.user.length > 0 && (
                <TemplateGroup
                  scope="user"
                  templates={groupedTemplates.user}
                  onSelect={(template) => {
                    onSelect(template);
                    setExpanded(false);
                  }}
                />
              )}
              {groupedTemplates.project.length > 0 && (
                <TemplateGroup
                  scope="project"
                  templates={groupedTemplates.project}
                  onSelect={(template) => {
                    onSelect(template);
                    setExpanded(false);
                  }}
                />
              )}
              {groupedTemplates.local.length > 0 && (
                <TemplateGroup
                  scope="local"
                  templates={groupedTemplates.local}
                  onSelect={(template) => {
                    onSelect(template);
                    setExpanded(false);
                  }}
                />
              )}
            </>
          ) : (
            // Flat view when showing single scope or few templates
            <div className="space-y-2">
              {templates.map((template) => (
                <TemplateButton
                  key={template.id}
                  template={template}
                  showBadge={!filterScope}
                  onClick={() => {
                    onSelect(template);
                    setExpanded(false);
                  }}
                />
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function TemplateGroup({
  scope,
  templates,
  onSelect,
}: {
  scope: 'user' | 'project' | 'local';
  templates: MemoryTemplate[];
  onSelect: (template: MemoryTemplate) => void;
}) {
  const config = SCOPE_CONFIG[scope];

  return (
    <div>
      <div className="flex items-center gap-2 mb-2">
        <ScopeBadge scope={scope} />
        <span className="text-xs text-surface-500">{config.description}</span>
      </div>
      <div className="space-y-2">
        {templates.map((template) => (
          <TemplateButton
            key={template.id}
            template={template}
            showBadge={false}
            onClick={() => onSelect(template)}
          />
        ))}
      </div>
    </div>
  );
}

function TemplateButton({
  template,
  showBadge,
  onClick,
}: {
  template: MemoryTemplate;
  showBadge: boolean;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className="w-full text-left p-3 bg-surface-800 rounded-lg hover:bg-surface-700 transition-colors"
    >
      <div className="flex items-start justify-between gap-2">
        <div className="font-medium text-surface-200">{template.name}</div>
        {showBadge && <ScopeBadge scope={template.scope} />}
      </div>
      <div className="text-sm text-surface-400 mt-1">{template.description}</div>
      {template.variables.length > 0 && (
        <div className="flex flex-wrap gap-1.5 mt-2">
          {template.variables.slice(0, 4).map((v) => (
            <span
              key={v}
              className="text-xs px-1.5 py-0.5 bg-surface-700 text-surface-400 rounded"
            >
              {`{{${v}}}`}
            </span>
          ))}
          {template.variables.length > 4 && (
            <span className="text-xs text-surface-500">
              +{template.variables.length - 4} more
            </span>
          )}
        </div>
      )}
    </button>
  );
}
