// ============================================================================
// AGENTS VIEW - CUSTOM HOOKS
// ============================================================================

import { useState, useEffect, useCallback } from 'react';
import type { AgentTemplate } from './types';
import { createLogger } from '../../../../shared/logger';

const logger = createLogger('AgentsView');

export interface UseAgentsReturn {
  agents: AgentTemplate[];
  loading: boolean;
  loadAgents: () => Promise<void>;
  saveAgent: (agentData: Partial<AgentTemplate>, projectPath: string | null) => Promise<{ success: boolean; error?: unknown }>;
  deleteAgent: (id: string) => Promise<{ success: boolean; error?: unknown }>;
  copyToClipboard: (content: string) => Promise<{ success: boolean; error?: unknown }>;
}

export function useAgents(): UseAgentsReturn {
  const [agents, setAgents] = useState<AgentTemplate[]>([]);
  const [loading, setLoading] = useState(true);

  const loadAgents = useCallback(async () => {
    setLoading(true);
    try {
      const result = await window.goodvibes.getAgentTemplates();
      setAgents(result || []);
    } catch (error) {
      logger.error('Failed to load agent templates:', error);
      setAgents([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadAgents();
  }, [loadAgents]);

  const saveAgent = async (agentData: Partial<AgentTemplate>, projectPath: string | null) => {
    try {
      if (agentData.id) {
        await window.goodvibes.updateAgentTemplate(agentData.id, {
          ...agentData,
          cwd: projectPath || undefined,
        });
      } else {
        await window.goodvibes.createAgentTemplate({
          name: agentData.name || '',
          description: agentData.description || undefined,
          initialPrompt: agentData.initialPrompt || undefined,
          claudeMdContent: agentData.claudeMdContent || undefined,
          model: agentData.model || undefined,
          permissionMode: agentData.permissionMode || undefined,
          flags: agentData.flags || undefined,
          cwd: projectPath || undefined,
        });
      }
      await loadAgents();
      return { success: true };
    } catch (error) {
      logger.error('Failed to save agent template:', error);
      return { success: false, error };
    }
  };

  const deleteAgent = async (id: string) => {
    try {
      await window.goodvibes.deleteAgentTemplate(id);
      await loadAgents();
      return { success: true };
    } catch (error) {
      logger.error('Failed to delete agent template:', error);
      return { success: false, error };
    }
  };

  const copyToClipboard = async (content: string) => {
    try {
      await navigator.clipboard.writeText(content);
      return { success: true };
    } catch (error) {
      logger.error('Failed to copy to clipboard:', error);
      return { success: false, error };
    }
  };

  return {
    agents,
    loading,
    loadAgents,
    saveAgent,
    deleteAgent,
    copyToClipboard,
  };
}

export function useAgentFilters(agents: AgentTemplate[], builtInAgents: typeof import('./constants').BUILT_IN_AGENTS) {
  const [searchQuery, setSearchQuery] = useState('');
  const [showBuiltIn, setShowBuiltIn] = useState(true);

  const filteredAgents = agents.filter(
    (a) =>
      !searchQuery ||
      a.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
      a.description?.toLowerCase().includes(searchQuery.toLowerCase())
  );

  const filteredBuiltIn = builtInAgents.filter(
    (a) =>
      !searchQuery ||
      a.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
      a.description?.toLowerCase().includes(searchQuery.toLowerCase())
  );

  return {
    searchQuery,
    setSearchQuery,
    showBuiltIn,
    setShowBuiltIn,
    filteredAgents,
    filteredBuiltIn,
  };
}
