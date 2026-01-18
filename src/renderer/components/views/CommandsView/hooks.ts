// ============================================================================
// COMMANDS VIEW - CUSTOM HOOKS
// ============================================================================

import { useState, useEffect, useCallback } from 'react';
import type { Command, BuiltInCommand } from './types';
import { createLogger } from '../../../../shared/logger';
import { formatTimestamp } from '../../../../shared/dateUtils';

const logger = createLogger('CommandsView');

export function useCommands() {
  const [commands, setCommands] = useState<Command[]>([]);
  const [loading, setLoading] = useState(true);

  const loadCommands = useCallback(async () => {
    setLoading(true);
    try {
      const result = await window.goodvibes.getSkills();
      // Map API response to Command interface
      const mappedCommands: Command[] = (result || []).map((s: Record<string, unknown>) => ({
        id: s.id as number,
        name: s.name as string,
        description: s.description as string | null,
        content: s.content as string || s.promptTemplate as string || '',
        allowedTools: s.allowedTools as string[] | null,
        scope: (s.scope as 'user' | 'project') || 'user',
        projectPath: s.projectPath as string | null,
        useCount: (s.useCount as number) || 0,
        lastUsed: s.lastUsed as string | null,
        createdAt: s.createdAt as string || formatTimestamp(),
        updatedAt: s.updatedAt as string || formatTimestamp(),
      }));
      setCommands(mappedCommands);
    } catch (error) {
      logger.error('Failed to load commands:', error);
      setCommands([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadCommands();
  }, [loadCommands]);

  const saveCommand = async (commandData: Partial<Command>, projectPath: string | null) => {
    try {
      if (commandData.id) {
        await window.goodvibes.updateSkill(commandData.id, {
          name: commandData.name,
          description: commandData.description,
          promptTemplate: commandData.content,
          allowedTools: commandData.allowedTools,
          scope: commandData.scope,
          projectPath: projectPath || undefined,
        });
      } else {
        await window.goodvibes.createSkill({
          name: commandData.name || '',
          description: commandData.description || undefined,
          promptTemplate: commandData.content || '',
          isBuiltIn: false,
          scope: commandData.scope,
          projectPath: projectPath || undefined,
        });
      }
      await loadCommands();
      return { success: true };
    } catch (error) {
      logger.error('Failed to save command:', error);
      return { success: false, error };
    }
  };

  const deleteCommand = async (id: number) => {
    try {
      await window.goodvibes.deleteSkill(id);
      await loadCommands();
      return { success: true };
    } catch (error) {
      logger.error('Failed to delete command:', error);
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
    commands,
    loading,
    loadCommands,
    saveCommand,
    deleteCommand,
    copyToClipboard,
  };
}

export function useCommandFilters(commands: Command[], builtInCommands: BuiltInCommand[]) {
  const [searchQuery, setSearchQuery] = useState('');
  const [showBuiltIn, setShowBuiltIn] = useState(true);

  const filteredCommands = commands.filter(
    (c) =>
      !searchQuery ||
      c.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
      c.description?.toLowerCase().includes(searchQuery.toLowerCase())
  );

  const filteredBuiltIn = builtInCommands.filter(
    (c) =>
      !searchQuery ||
      c.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
      c.description?.toLowerCase().includes(searchQuery.toLowerCase())
  );

  return {
    searchQuery,
    setSearchQuery,
    showBuiltIn,
    setShowBuiltIn,
    filteredCommands,
    filteredBuiltIn,
  };
}
