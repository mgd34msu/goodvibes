// ============================================================================
// INSTALL AGENT MODAL
// Modal for selecting scope and project when installing built-in agents
// ============================================================================

import { Download, Bot, Wrench, Shield } from 'lucide-react';
import { InstallItemModal } from '../../common/InstallItemModal';
import type { BuiltInAgent } from './types';

// ============================================================================
// TYPES
// ============================================================================

interface InstallAgentModalProps {
  agent: BuiltInAgent;
  isOpen: boolean;
  onClose: () => void;
  onInstall: (agent: BuiltInAgent, scope: 'user' | 'project', projectPath: string | null) => void;
}

// ============================================================================
// HELPERS
// ============================================================================

const PERMISSION_MODE_LABELS: Record<string, { label: string; color: string }> = {
  default: { label: 'Default', color: 'text-surface-400' },
  plan: { label: 'Plan Mode', color: 'text-accent-blue' },
  bypassPermissions: { label: 'Bypass Permissions', color: 'text-status-warning' },
};

// ============================================================================
// COMPONENT
// ============================================================================

export function InstallAgentModal({
  agent,
  isOpen,
  onClose,
  onInstall,
}: InstallAgentModalProps) {
  const permissionInfo = (agent.permissionMode && agent.permissionMode in PERMISSION_MODE_LABELS
    ? PERMISSION_MODE_LABELS[agent.permissionMode as keyof typeof PERMISSION_MODE_LABELS]
    : PERMISSION_MODE_LABELS.default) as { label: string; color: string };

  return (
    <InstallItemModal<BuiltInAgent>
      item={agent}
      isOpen={isOpen}
      onClose={onClose}
      onInstall={onInstall}
      modalTitle="Install Agent"
      itemDisplayName={agent.name}
      installButtonText="Install Agent"
      headerIcon={<Download className="w-5 h-5 text-accent-purple" />}
      previewTitle="Agent Preview"
      itemKey={agent.name}
      renderPreview={(agent) => (
        <>
          {/* Name */}
          <div className="flex items-center gap-2">
            <Bot className="w-4 h-4 text-accent-purple" />
            <span className="font-medium text-surface-200">{agent.name}</span>
          </div>

          {/* Description */}
          {agent.description && (
            <p className="text-sm text-surface-400">{agent.description}</p>
          )}

          {/* Details Grid */}
          <div className="grid grid-cols-2 gap-3 pt-2">
            {/* Model */}
            <div className="bg-surface-900/50 rounded p-2">
              <span className="text-xs text-surface-500 block">Model</span>
              <span className="text-sm text-surface-300 font-mono">
                {agent.model || 'Default'}
              </span>
            </div>

            {/* Permission Mode */}
            <div className="bg-surface-900/50 rounded p-2">
              <span className="text-xs text-surface-500 block">Permission Mode</span>
              <span className={`text-sm font-mono ${permissionInfo.color}`}>
                {permissionInfo.label}
              </span>
            </div>
          </div>

          {/* Allowed Tools */}
          {agent.allowedTools && agent.allowedTools.length > 0 && (
            <div className="pt-2">
              <div className="flex items-center gap-2 mb-2">
                <Wrench className="w-3.5 h-3.5 text-surface-500" />
                <span className="text-xs text-surface-500">Allowed Tools</span>
              </div>
              <div className="flex items-center gap-2 flex-wrap">
                {agent.allowedTools.slice(0, 4).map((tool) => (
                  <span
                    key={tool}
                    className="inline-flex items-center px-2 py-0.5 bg-surface-900 text-surface-400 rounded text-xs font-mono"
                  >
                    {tool}
                  </span>
                ))}
                {agent.allowedTools.length > 4 && (
                  <span className="text-xs text-surface-600">
                    +{agent.allowedTools.length - 4} more
                  </span>
                )}
              </div>
            </div>
          )}

          {/* Denied Tools */}
          {agent.deniedTools && agent.deniedTools.length > 0 && (
            <div className="pt-2">
              <div className="flex items-center gap-2 mb-2">
                <Shield className="w-3.5 h-3.5 text-status-error" />
                <span className="text-xs text-surface-500">Denied Tools</span>
              </div>
              <div className="flex items-center gap-2 flex-wrap">
                {agent.deniedTools.slice(0, 4).map((tool) => (
                  <span
                    key={tool}
                    className="inline-flex items-center px-2 py-0.5 bg-status-error/10 text-status-error rounded text-xs font-mono"
                  >
                    {tool}
                  </span>
                ))}
                {agent.deniedTools.length > 4 && (
                  <span className="text-xs text-surface-600">
                    +{agent.deniedTools.length - 4} more
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
