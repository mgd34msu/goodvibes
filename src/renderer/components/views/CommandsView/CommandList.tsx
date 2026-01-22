// ============================================================================
// COMMAND LIST COMPONENT
// ============================================================================

import { Terminal } from 'lucide-react';
import { CommandCard } from './CommandCard';
import type { Command, BuiltInCommand } from './types';

interface CommandListProps {
  customCommands: Command[];
  builtInCommands: (BuiltInCommand & { isBuiltIn: true })[];
  showBuiltIn: boolean;
  onInstallCommand?: (command: BuiltInCommand & { isBuiltIn: true }) => void;
  onDeleteCommand: (id: number) => void;
  onCreateNew: () => void;
  searchQuery: string;
}

export function CommandList({
  customCommands,
  builtInCommands,
  showBuiltIn,
  onInstallCommand,
  onDeleteCommand,
  onCreateNew,
  searchQuery,
}: CommandListProps) {
  const hasCustomCommands = customCommands.length > 0;
  const hasBuiltInCommands = builtInCommands.length > 0;
  const isEmpty = !hasCustomCommands && (!showBuiltIn || !hasBuiltInCommands);

  if (isEmpty) {
    return (
      <div className="text-center py-12">
        <Terminal className="w-12 h-12 text-surface-600 mx-auto mb-4" />
        <h3 className="text-lg font-medium text-surface-300">
          {searchQuery ? 'No commands match your search' : 'No custom commands yet'}
        </h3>
        <p className="text-surface-500 mt-2">
          {searchQuery
            ? 'Try a different search term'
            : 'Create commands to automate common workflows'}
        </p>
        {!searchQuery && (
          <button
            onClick={onCreateNew}
            className="mt-4 px-4 py-2 bg-surface-700 text-surface-200 rounded-lg hover:bg-surface-600 transition-colors"
          >
            Create your first command
          </button>
        )}
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Custom Commands */}
      {hasCustomCommands && (
        <div>
          <h2 className="text-sm font-medium text-surface-400 mb-3">
            Custom Commands ({customCommands.length})
          </h2>
          <div className="space-y-3">
            {customCommands.map((command) => (
              <CommandCard
                key={command.id}
                command={command}
                onDelete={() => onDeleteCommand(command.id)}
              />
            ))}
          </div>
        </div>
      )}

      {/* Built-in Commands */}
      {showBuiltIn && hasBuiltInCommands && (
        <div>
          <h2 className="text-sm font-medium text-surface-400 mb-3">
            Built-in Commands ({builtInCommands.length})
          </h2>
          <div className="space-y-3">
            {builtInCommands.map((command) => (
              <CommandCard
                key={command.name}
                command={command}
                onInstall={() => onInstallCommand?.(command)}
              />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
