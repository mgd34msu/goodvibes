// ============================================================================
// AGENT LIST COMPONENT
// ============================================================================

import { Users } from 'lucide-react';
import { AgentCard } from './AgentCard';
import type { AgentTemplate, BuiltInAgent } from './types';

interface AgentListProps {
  customAgents: AgentTemplate[];
  builtInAgents: (BuiltInAgent & { isBuiltIn: true })[];
  showBuiltIn: boolean;
  onUseAgent: (name: string) => void;
  onInstallAgent?: (agent: BuiltInAgent & { isBuiltIn: true }) => void;
  onEditAgent: (agent: AgentTemplate) => void;
  onDeleteAgent: (id: string) => void;
  onCopyPrompt: (content: string) => void;
  onCreateNew: () => void;
  searchQuery: string;
}

export function AgentList({
  customAgents,
  builtInAgents,
  showBuiltIn,
  onUseAgent,
  onInstallAgent,
  onEditAgent,
  onDeleteAgent,
  onCopyPrompt,
  onCreateNew,
  searchQuery,
}: AgentListProps) {
  const hasNoResults = customAgents.length === 0 && (!showBuiltIn || builtInAgents.length === 0);

  return (
    <div className="space-y-6">
      {/* Custom Agents */}
      {customAgents.length > 0 && (
        <div>
          <h2 className="text-sm font-medium text-surface-400 mb-3">
            Custom Agents ({customAgents.length})
          </h2>
          <div className="space-y-3">
            {customAgents.map((agent) => (
              <AgentCard
                key={agent.id}
                agent={agent}
                onUse={() => onUseAgent(agent.name)}
                onEdit={() => onEditAgent(agent)}
                onDelete={() => onDeleteAgent(agent.id)}
                onCopy={() => onCopyPrompt(agent.initialPrompt || '')}
              />
            ))}
          </div>
        </div>
      )}

      {/* Built-in Agents */}
      {showBuiltIn && builtInAgents.length > 0 && (
        <div>
          <h2 className="text-sm font-medium text-surface-400 mb-3">
            Built-in Agents ({builtInAgents.length})
          </h2>
          <div className="space-y-3">
            {builtInAgents.map((agent) => (
              <AgentCard
                key={agent.name}
                agent={agent}
                onInstall={() => onInstallAgent?.(agent)}
                onCopy={() => onCopyPrompt(agent.initialPrompt || '')}
              />
            ))}
          </div>
        </div>
      )}

      {/* Empty state */}
      {hasNoResults && (
        <div className="text-center py-12">
          <Users className="w-12 h-12 text-surface-600 mx-auto mb-4" />
          <h3 className="text-lg font-medium text-surface-300">
            {searchQuery ? 'No agents match your search' : 'No custom agents yet'}
          </h3>
          <p className="text-surface-500 mt-2">
            {searchQuery
              ? 'Try a different search term'
              : 'Create agent templates for specialized tasks'}
          </p>
          {!searchQuery && (
            <button
              onClick={onCreateNew}
              className="mt-4 px-4 py-2 bg-surface-700 text-surface-200 rounded-lg hover:bg-surface-600 transition-colors"
            >
              Create your first agent
            </button>
          )}
        </div>
      )}
    </div>
  );
}
