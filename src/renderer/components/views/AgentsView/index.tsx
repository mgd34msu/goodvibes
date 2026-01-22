// ============================================================================
// AGENTS VIEW - Agent Template Library Management
// ============================================================================

import { useState, useCallback } from 'react';
import { Users, Plus, Settings } from 'lucide-react';
import { AgentForm } from './AgentForm';
import { AgentList } from './AgentList';
import { AgentFilters } from './AgentFilters';
import { InstallAgentModal } from './InstallAgentModal';
import { useAgents, useAgentFilters } from './hooks';
import { useConfirm } from '../../overlays/ConfirmModal';
import { BUILT_IN_AGENTS } from './constants';
import type { AgentTemplate, BuiltInAgent } from './types';

export default function AgentsView() {
  const { agents, loading, saveAgent, deleteAgent, copyToClipboard } = useAgents();
  const [showForm, setShowForm] = useState(false);
  const [editingAgent, setEditingAgent] = useState<AgentTemplate | undefined>();
  const [installAgent, setInstallAgent] = useState<BuiltInAgent | null>(null);

  const { confirm: confirmDelete, ConfirmDialog } = useConfirm({
    title: 'Delete Agent Template',
    message: 'Are you sure you want to delete this agent template?',
    confirmText: 'Delete',
    cancelText: 'Cancel',
    variant: 'danger',
  });

  const {
    searchQuery,
    setSearchQuery,
    showBuiltIn,
    setShowBuiltIn,
    filteredAgents,
    filteredBuiltIn,
  } = useAgentFilters(agents, BUILT_IN_AGENTS);

  const handleSave = async (agentData: Partial<AgentTemplate>, projectPath: string | null) => {
    const result = await saveAgent(agentData, projectPath);
    if (result.success) {
      setShowForm(false);
      setEditingAgent(undefined);
    }
  };

  const handleUse = async (agentName: string) => {
    await copyToClipboard(agentName);
  };

  const handleCopy = async (content: string) => {
    await copyToClipboard(content);
  };

  const handleDelete = useCallback(async (id: string) => {
    const confirmed = await confirmDelete();
    if (confirmed) {
      await deleteAgent(id);
    }
  }, [confirmDelete, deleteAgent]);

  const handleEdit = (agent: AgentTemplate) => {
    setEditingAgent(agent);
    setShowForm(true);
  };

  const handleCancel = () => {
    setShowForm(false);
    setEditingAgent(undefined);
  };

  const handleInstallAgent = useCallback(
    async (agent: BuiltInAgent, scope: 'user' | 'project', projectPath: string | null) => {
      // Install agent to .claude/agents/ directory
      const content = agent.initialPrompt || agent.claudeMdContent || '';

      try {
        await window.goodvibes.installAgent({
          name: agent.name,
          content,
          scope,
          projectPath: projectPath || undefined,
        });

        // Also save to database for UI display
        const agentData: Partial<AgentTemplate> = {
          name: agent.name,
          description: agent.description,
          initialPrompt: agent.initialPrompt,
          claudeMdContent: agent.claudeMdContent,
          flags: agent.flags,
          model: agent.model,
          permissionMode: agent.permissionMode,
          allowedTools: agent.allowedTools,
          deniedTools: agent.deniedTools,
          cwd: scope === 'project' ? projectPath : null,
        };
        await saveAgent(agentData, scope === 'project' ? projectPath : null);
      } catch (error) {
        console.error('Failed to install agent:', error);
      }
    },
    [saveAgent]
  );

  return (
    <>
    <ConfirmDialog />
    <div className="h-full flex flex-col">
      {/* Header */}
      <div className="flex-shrink-0 px-6 py-4 border-b border-surface-800">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <Users className="w-6 h-6 text-accent-purple" />
            <div>
              <h1 className="text-xl font-semibold text-surface-100">Agents</h1>
              <p className="text-sm text-surface-400">
                Agent template library for Claude Code
              </p>
            </div>
          </div>

          <button
            onClick={() => {
              setEditingAgent(undefined);
              setShowForm(true);
            }}
            className="px-4 py-2 bg-accent-purple text-white rounded-lg hover:bg-accent-purple/80 transition-colors flex items-center gap-2"
          >
            <Plus className="w-4 h-4" />
            New Agent
          </button>
        </div>

        <AgentFilters
          searchQuery={searchQuery}
          onSearchChange={setSearchQuery}
          showBuiltIn={showBuiltIn}
          onToggleBuiltIn={() => setShowBuiltIn(!showBuiltIn)}
        />
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto p-6">
        {showForm && (
          <div className="mb-6">
            <AgentForm
              agent={editingAgent}
              onSave={handleSave}
              onCancel={handleCancel}
            />
          </div>
        )}

        {loading ? (
          <div className="flex items-center justify-center h-64">
            <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-accent-purple" />
          </div>
        ) : (
          <AgentList
            customAgents={filteredAgents}
            builtInAgents={filteredBuiltIn.map((a) => ({ ...a, isBuiltIn: true as const }))}
            showBuiltIn={showBuiltIn}
            onUseAgent={handleUse}
            onInstallAgent={(agent) => setInstallAgent(agent)}
            onEditAgent={handleEdit}
            onDeleteAgent={handleDelete}
            onCopyPrompt={handleCopy}
            onCreateNew={() => setShowForm(true)}
            searchQuery={searchQuery}
          />
        )}

        {/* Info section */}
        <div className="mt-8 p-4 bg-surface-900 rounded-lg border border-surface-700">
          <div className="flex items-start gap-3">
            <Settings className="w-5 h-5 text-surface-400 mt-0.5" />
            <div className="text-sm text-surface-400">
              <p className="font-medium text-surface-300 mb-1">About Agents</p>
              <p>
                Agent templates define specialized configurations for Claude Code sessions.
                Each template includes an initial prompt, model selection, permission settings,
                and tool restrictions to create focused, task-specific agents.
              </p>
              <p className="mt-2">
                Use the "Use" button to copy the agent name, or expand an agent to view
                and copy its full configuration.
              </p>
            </div>
          </div>
        </div>
      </div>
    </div>

    {/* Install Agent Modal */}
    {installAgent && (
      <InstallAgentModal
        agent={installAgent}
        isOpen={!!installAgent}
        onClose={() => setInstallAgent(null)}
        onInstall={handleInstallAgent}
      />
    )}
    </>
  );
}

// Re-export types for convenience
export type { AgentTemplate } from './types';
