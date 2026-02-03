// ============================================================================
// TEMPLATE LIST COMPONENT
// ============================================================================

import type { ProjectTemplate } from './types';

interface TemplateListProps {
  templates: ProjectTemplate[];
  onDeleteTemplate: (templateId: number) => void;
  formatDate: (date: string) => string;
}

export function TemplateList({
  templates,
  onDeleteTemplate,
  formatDate,
}: TemplateListProps) {
  if (templates.length === 0) {
    return (
      <div className="card p-12 text-center">
        <div className="text-4xl mb-4">&lt; /&gt;</div>
        <div className="text-surface-400 mb-2">No templates created</div>
        <p className="text-sm text-surface-500">
          Create templates from existing projects to quickly configure new ones.
        </p>
      </div>
    );
  }

  return (
    <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
      {templates.map(template => (
        <div key={template.id} className="card p-4 space-y-3">
          <div className="flex items-start justify-between">
            <div>
              <h3 className="font-medium text-surface-100">{template.name}</h3>
              {template.description && (
                <p className="text-sm text-surface-400 mt-1">{template.description}</p>
              )}
            </div>
            <button
              onClick={() => onDeleteTemplate(template.id)}
              className="text-surface-500 hover:text-red-400 transition-colors"
              title="Delete template"
            >
              x
            </button>
          </div>

          <div className="text-xs text-surface-500 space-y-1">
            <div>Agents: {template.agents.length}</div>
            <div>Created: {formatDate(template.createdAt)}</div>
          </div>

          {template.settings.tags && template.settings.tags.length > 0 && (
            <div className="flex flex-wrap gap-1">
              {template.settings.tags.map((tag, i) => (
                <span
                  key={i}
                  className="px-2 py-0.5 bg-surface-700 rounded text-xs text-surface-300"
                >
                  {tag}
                </span>
              ))}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}
