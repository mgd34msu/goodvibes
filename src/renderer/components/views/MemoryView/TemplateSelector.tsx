// ============================================================================
// TEMPLATE SELECTOR COMPONENT
// ============================================================================

import { useState } from 'react';
import { clsx } from 'clsx';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { DEFAULT_TEMPLATES, type MemoryTemplate } from './types';

interface TemplateSelectorProps {
  onSelect: (template: MemoryTemplate) => void;
}

export function TemplateSelector({ onSelect }: TemplateSelectorProps): React.JSX.Element {
  const [expanded, setExpanded] = useState(false);

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
        <div className="p-4 space-y-3 bg-surface-900">
          {DEFAULT_TEMPLATES.map((template) => (
            <button
              key={template.id}
              onClick={() => {
                onSelect(template);
                setExpanded(false);
              }}
              className="w-full text-left p-3 bg-surface-800 rounded-lg hover:bg-surface-700 transition-colors"
            >
              <div className="font-medium text-surface-200">{template.name}</div>
              <div className="text-sm text-surface-400 mt-1">{template.description}</div>
              {template.variables.length > 0 && (
                <div className="flex gap-2 mt-2">
                  {template.variables.map((v) => (
                    <span
                      key={v}
                      className="text-xs px-2 py-0.5 bg-accent-purple/20 text-accent-purple rounded"
                    >
                      {`{{${v}}}`}
                    </span>
                  ))}
                </div>
              )}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
