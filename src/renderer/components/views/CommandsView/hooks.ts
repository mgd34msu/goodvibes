// ============================================================================
// COMMANDS VIEW - CUSTOM HOOKS
// ============================================================================

import { useState, useEffect, useCallback } from 'react';
import type { Command, BuiltInCommand } from './types';
import { createLogger } from '../../../../shared/logger';
import { formatTimestamp } from '../../../../shared/dateUtils';
import { toast } from '../../../stores/toastStore';

const logger = createLogger('CommandsView');

export interface UseCommandsReturn {
  commands: Command[];
  loading: boolean;
  loadCommands: () => Promise<void>;
  saveCommand: (commandData: Partial<Command>, projectPath: string | null) => Promise<{ success: boolean; error?: unknown }>;
  deleteCommand: (id: number) => Promise<{ success: boolean; error?: unknown }>;
  copyToClipboard: (content: string) => Promise<{ success: boolean; error?: unknown }>;
}

export function useCommands(): UseCommandsReturn {
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
      toast.error('Failed to load commands');
      setCommands([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadCommands();
  }, [loadCommands]);

  const saveCommand = async (commandData: Partial<Command>, projectPath: string | null) => {
    const isUpdate = Boolean(commandData.id);
    const commandName = commandData.name || 'command';
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
      toast.success(isUpdate ? `Updated ${commandName}` : `Created ${commandName}`);
      return { success: true };
    } catch (error) {
      logger.error('Failed to save command:', error);
      toast.error(isUpdate ? 'Failed to update command' : 'Failed to create command');
      return { success: false, error };
    }
  };

  const deleteCommand = async (id: number) => {
    try {
      // Find the command to determine scope
      const command = commands.find((c) => c.id === id);
      if (!command) {
        throw new Error('Command not found');
      }

      // Delete from database
      await window.goodvibes.deleteSkill(id);

      // Uninstall from .claude/commands/ directory
      try {
        await window.goodvibes.uninstallCommand({
          name: command.name,
          scope: command.scope,
          projectPath: command.projectPath || undefined,
        });
      } catch (uninstallError) {
        // Log error but don't fail the entire operation if file doesn't exist
        logger.warn('Failed to uninstall command file (may not exist)', { error: uninstallError });
      }

      await loadCommands();
      toast.success('Command deleted');
      return { success: true };
    } catch (error) {
      logger.error('Failed to delete command:', error);
      toast.error('Failed to delete command');
      return { success: false, error };
    }
  };

  const copyToClipboard = async (content: string) => {
    try {
      await navigator.clipboard.writeText(content);
      toast.success('Copied to clipboard');
      return { success: true };
    } catch (error) {
      logger.error('Failed to copy to clipboard:', error);
      toast.error('Failed to copy to clipboard');
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

export interface UseCommandFiltersReturn {
  filteredCommands: Command[];
  filteredBuiltIn: BuiltInCommand[];
  searchQuery: string;
  setSearchQuery: (query: string) => void;
  showBuiltIn: boolean;
  setShowBuiltIn: (show: boolean) => void;
}

export function useCommandFilters(commands: Command[], builtInCommands: BuiltInCommand[]): UseCommandFiltersReturn {
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
