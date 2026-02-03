// ============================================================================
// INSTALL COMMAND MODAL
// Modal for selecting scope and project when installing built-in commands
// ============================================================================

import { Download, Zap, Wrench } from 'lucide-react';
import { InstallItemModal } from '../../common/InstallItemModal';
import type { BuiltInCommand } from './types';

// ============================================================================
// TYPES
// ============================================================================

interface InstallCommandModalProps {
  command: BuiltInCommand;
  isOpen: boolean;
  onClose: () => void;
  onInstall: (command: BuiltInCommand, scope: 'user' | 'project', projectPath: string | null) => void;
}

// ============================================================================
// COMPONENT
// ============================================================================

export function InstallCommandModal({
  command,
  isOpen,
  onClose,
  onInstall,
}: InstallCommandModalProps) {
  // Format command name with / prefix if not already present
  const displayName = command.name.startsWith('/') ? command.name : `/${command.name}`;

  return (
    <InstallItemModal<BuiltInCommand>
      item={command}
      isOpen={isOpen}
      onClose={onClose}
      onInstall={onInstall}
      modalTitle="Install Command"
      itemDisplayName={displayName}
      installButtonText="Install Command"
      headerIcon={<Download className="w-5 h-5 text-accent-purple" />}
      previewTitle="Command Preview"
      itemKey={command.name}
      renderPreview={(command) => (
        <>
          {/* Name with / prefix */}
          <div className="flex items-center gap-2">
            <Zap className="w-4 h-4 text-accent-yellow" />
            <span className="font-medium text-surface-200 font-mono">{displayName}</span>
          </div>

          {/* Description */}
          {command.description && (
            <p className="text-sm text-surface-400">{command.description}</p>
          )}

          {/* Content Preview */}
          {command.content && (
            <div className="pt-2">
              <span className="text-xs text-surface-500 block mb-2">Content Preview</span>
              <div className="bg-surface-900/50 rounded p-3 max-h-32 overflow-y-auto">
                <pre className="text-xs text-surface-400 whitespace-pre-wrap font-mono">
                  {command.content.length > 300
                    ? `${command.content.slice(0, 300)}...`
                    : command.content}
                </pre>
              </div>
            </div>
          )}

          {/* Allowed Tools */}
          {command.allowedTools && command.allowedTools.length > 0 && (
            <div className="pt-2">
              <div className="flex items-center gap-2 mb-2">
                <Wrench className="w-3.5 h-3.5 text-surface-500" />
                <span className="text-xs text-surface-500">Allowed Tools</span>
              </div>
              <div className="flex items-center gap-2 flex-wrap">
                {command.allowedTools.slice(0, 4).map((tool) => (
                  <span
                    key={tool}
                    className="inline-flex items-center px-2 py-0.5 bg-surface-900 text-surface-400 rounded text-xs font-mono"
                  >
                    {tool}
                  </span>
                ))}
                {command.allowedTools.length > 4 && (
                  <span className="text-xs text-surface-600">
                    +{command.allowedTools.length - 4} more
                  </span>
                )}
              </div>
            </div>
          )}
        </>
      )}
    />
  );
}
