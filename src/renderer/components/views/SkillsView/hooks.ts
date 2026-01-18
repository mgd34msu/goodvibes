// ============================================================================
// AGENT SKILLS VIEW - CUSTOM HOOKS
// ============================================================================

import { useState, useEffect, useCallback } from 'react';
import type { AgentSkill, BuiltInAgentSkill } from './types';
import { createLogger } from '../../../../shared/logger';
import { formatTimestamp } from '../../../../shared/dateUtils';

const logger = createLogger('AgentSkillsView');

export interface UseAgentSkillsReturn {
  skills: AgentSkill[];
  loading: boolean;
  loadSkills: () => Promise<void>;
  saveSkill: (skillData: Partial<AgentSkill>, projectPath: string | null) => Promise<{ success: boolean; error?: unknown }>;
  deleteSkill: (id: number) => Promise<{ success: boolean; error?: unknown }>;
  copyToClipboard: (content: string) => Promise<{ success: boolean; error?: unknown }>;
}

/**
 * Hook for managing agent skills CRUD operations
 */
export function useAgentSkills(): UseAgentSkillsReturn {
  const [skills, setSkills] = useState<AgentSkill[]>([]);
  const [loading, setLoading] = useState(true);

  const loadSkills = useCallback(async () => {
    setLoading(true);
    try {
      const result = await window.goodvibes.getSkills();
      // Map API response to AgentSkill interface
      const mappedSkills: AgentSkill[] = (result || []).map(
        (s: Record<string, unknown>) => ({
          id: s.id as number,
          name: s.name as string,
          description: (s.description as string) || '',
          content: (s.content as string) || (s.promptTemplate as string) || '',
          allowedTools: s.allowedTools as string[] | null,
          scope: (s.scope as 'user' | 'project') || 'user',
          projectPath: s.projectPath as string | null,
          version: (s.version as string) || null,
          useCount: (s.useCount as number) || 0,
          lastUsed: s.lastUsed as string | null,
          createdAt: (s.createdAt as string) || formatTimestamp(),
          updatedAt: (s.updatedAt as string) || formatTimestamp(),
        })
      );
      setSkills(mappedSkills);
    } catch (error) {
      logger.error('Failed to load agent skills:', error);
      setSkills([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadSkills();
  }, [loadSkills]);

  const saveSkill = async (
    skillData: Partial<AgentSkill>,
    projectPath: string | null
  ) => {
    try {
      if (skillData.id) {
        await window.goodvibes.updateSkill(skillData.id, {
          name: skillData.name,
          description: skillData.description,
          promptTemplate: skillData.content,
          allowedTools: skillData.allowedTools,
          scope: skillData.scope,
          projectPath: projectPath || undefined,
        });
      } else {
        await window.goodvibes.createSkill({
          name: skillData.name || '',
          description: skillData.description || undefined,
          promptTemplate: skillData.content || '',
          isBuiltIn: false,
          scope: skillData.scope,
          projectPath: projectPath || undefined,
          allowedTools: skillData.allowedTools || undefined,
        });
      }
      await loadSkills();
      return { success: true };
    } catch (error) {
      logger.error('Failed to save agent skill:', error);
      return { success: false, error };
    }
  };

  const deleteSkill = async (id: number) => {
    try {
      await window.goodvibes.deleteSkill(id);
      await loadSkills();
      return { success: true };
    } catch (error) {
      logger.error('Failed to delete agent skill:', error);
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
    skills,
    loading,
    loadSkills,
    saveSkill,
    deleteSkill,
    copyToClipboard,
  };
}

/**
 * Hook for filtering agent skills by search query and built-in toggle
 */
export function useAgentSkillFilters(
  skills: AgentSkill[],
  builtInSkills: BuiltInAgentSkill[]
) {
  const [searchQuery, setSearchQuery] = useState('');
  const [showBuiltIn, setShowBuiltIn] = useState(true);

  const filteredSkills = skills.filter(
    (s) =>
      !searchQuery ||
      s.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
      s.description?.toLowerCase().includes(searchQuery.toLowerCase())
  );

  const filteredBuiltIn = builtInSkills.filter(
    (s) =>
      !searchQuery ||
      s.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
      s.description?.toLowerCase().includes(searchQuery.toLowerCase())
  );

  return {
    searchQuery,
    setSearchQuery,
    showBuiltIn,
    setShowBuiltIn,
    filteredSkills,
    filteredBuiltIn,
  };
}
