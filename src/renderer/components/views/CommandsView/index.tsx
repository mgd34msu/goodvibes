// ============================================================================
// COMMANDS VIEW - Slash Commands Management
// ============================================================================

import { useState, useCallback } from 'react';
import { Terminal, Plus, Settings } from 'lucide-react';
import { createLogger } from '../../../../shared/logger';

const logger = createLogger('CommandsView');
import { CommandForm } from './CommandForm';
import { CommandList } from './CommandList';
import { CommandFilters } from './CommandFilters';
import { InstallCommandModal } from './InstallCommandModal';
import { useCommands, useCommandFilters } from './hooks';
import { useConfirm } from '../../overlays/ConfirmModal';
import { BUILT_IN_COMMANDS } from './constants';
import type { Command, BuiltInCommand } from './types';

export default function CommandsView() {
  const { commands, loading, saveCommand, deleteCommand } = useCommands();
  const [showForm, setShowForm] = useState(false);
  const [editingCommand, setEditingCommand] = useState<Command | undefined>();
  const [installCommand, setInstallCommand] = useState<BuiltInCommand | null>(null);

  const { confirm: confirmDelete, ConfirmDialog } = useConfirm({
    title: 'Delete Command',
    message: 'Are you sure you want to delete this command?',
    confirmText: 'Delete',
    variant: 'danger',
  });

  const {
    searchQuery,
    setSearchQuery,
    showBuiltIn,
    setShowBuiltIn,
    filteredCommands,
    filteredBuiltIn,
  } = useCommandFilters(commands, BUILT_IN_COMMANDS);

  const handleSave = async (commandData: Partial<Command>, projectPath: string | null) => {
    const result = await saveCommand(commandData, projectPath);
    if (result.success) {
      setShowForm(false);
      setEditingCommand(undefined);
    }
  };

  const handleDelete = useCallback(async (id: number) => {
    const confirmed = await confirmDelete();
    if (confirmed) {
      await deleteCommand(id);
    }
  }, [confirmDelete, deleteCommand]);

  const handleCancel = () => {
    setShowForm(false);
    setEditingCommand(undefined);
  };

  const handleOpenInstallModal = (command: BuiltInCommand & { isBuiltIn: true }) => {
    // Remove isBuiltIn flag when storing in state
    const { isBuiltIn, ...commandData } = command;
    setInstallCommand(commandData);
  };

  const handleInstallCommand = async (
    command: BuiltInCommand,
    scope: 'user' | 'project',
    projectPath: string | null
  ) => {
    try {
      // Install command to .claude/commands/ directory
      await window.goodvibes.installCommand({
        name: command.name,
        content: command.content,
        scope,
        projectPath: projectPath || undefined,
      });

      // Also save to database for UI display
      const commandData: Partial<Command> = {
        name: command.name,
        description: command.description || '',
        content: command.content,
        allowedTools: command.allowedTools,
        scope,
        projectPath,
      };
      await saveCommand(commandData, projectPath);
    } catch (error) {
      logger.error('Failed to install command:', error);
    }
    setInstallCommand(null);
  };

  return (
    <>
    <ConfirmDialog />
    {installCommand && (
      <InstallCommandModal
        command={installCommand}
        isOpen={installCommand !== null}
        onClose={() => setInstallCommand(null)}
        onInstall={handleInstallCommand}
      />
    )}
    <div className="h-full flex flex-col">
      {/* Header */}
      <div className="flex-shrink-0 px-6 py-4 border-b border-surface-800">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <Terminal className="w-6 h-6 text-accent-purple" />
            <div>
              <h1 className="text-xl font-semibold text-surface-100">Commands</h1>
              <p className="text-sm text-surface-400">
                Slash commands for Claude Code
              </p>
            </div>
          </div>

          <button
            onClick={() => {
              setEditingCommand(undefined);
              setShowForm(true);
            }}
            className="px-4 py-2 bg-accent-purple text-white rounded-lg hover:bg-accent-purple/80 transition-colors flex items-center gap-2"
          >
            <Plus className="w-4 h-4" />
            New Command
          </button>
        </div>

        <CommandFilters
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
            <CommandForm
              command={editingCommand}
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
          <CommandList
            customCommands={filteredCommands}
            builtInCommands={filteredBuiltIn.map((c) => ({ ...c, isBuiltIn: true as const }))}
            showBuiltIn={showBuiltIn}
            onInstallCommand={handleOpenInstallModal}
            onDeleteCommand={handleDelete}
            onCreateNew={() => setShowForm(true)}
            searchQuery={searchQuery}
          />
        )}

        {/* Info section */}
        <div className="mt-8 p-4 bg-surface-900 rounded-lg border border-surface-700">
          <div className="flex items-start gap-3">
            <Settings className="w-5 h-5 text-surface-400 mt-0.5" />
            <div className="text-sm text-surface-400">
              <p className="font-medium text-surface-300 mb-1">About Commands</p>
              <p>
                Commands are reusable instruction sets that can be invoked with slash commands
                (e.g., /commit, /review-pr). They help maintain consistency across sessions
                and automate common workflows.
              </p>
              <p className="mt-2">
                Use the Skill tool in Claude Code: <code className="bg-surface-800 px-1 rounded">Skill skill: "my-command"</code>
              </p>
            </div>
          </div>
        </div>
      </div>
    </div>
    </>
  );
}

// Re-export types for convenience
export type { Command } from './types';
