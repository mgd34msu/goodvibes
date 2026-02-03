// ============================================================================
// INSTALL AGENT SKILL MODAL
// Modal for selecting scope and project when installing built-in agent skills
// ============================================================================

import { Download, Sparkles, Wrench, Tag } from 'lucide-react';
import { InstallItemModal } from '../../common/InstallItemModal';
import type { BuiltInAgentSkill } from './types';

// ============================================================================
// TYPES
// ============================================================================

interface InstallSkillModalProps {
  skill: BuiltInAgentSkill;
  isOpen: boolean;
  onClose: () => void;
  onInstall: (
    skill: BuiltInAgentSkill,
    scope: 'user' | 'project',
    projectPath: string | null
  ) => void;
}

// ============================================================================
// COMPONENT
// ============================================================================

export function InstallSkillModal({
  skill,
  isOpen,
  onClose,
  onInstall,
}: InstallSkillModalProps) {
  // Format skill invocation for display
  const invocationText = `Skill skill: "${skill.name}"`;

  return (
    <InstallItemModal<BuiltInAgentSkill>
      item={skill}
      isOpen={isOpen}
      onClose={onClose}
      onInstall={onInstall}
      modalTitle="Install Agent Skill"
      itemDisplayName={skill.name}
      installButtonText="Install Skill"
      headerIcon={<Download className="w-5 h-5 text-accent-purple" />}
      previewTitle="Skill Preview"
      itemKey={skill.name}
      renderPreview={(skill) => (
        <>
          {/* Name with icon */}
          <div className="flex items-center gap-2">
            <Sparkles className="w-4 h-4 text-accent-purple" />
            <span className="font-medium text-surface-200">{skill.name}</span>
            {skill.version && (
              <span className="inline-flex items-center px-2 py-0.5 bg-surface-900 text-surface-400 rounded text-xs">
                <Tag className="w-3 h-3 mr-1" />
                v{skill.version}
              </span>
            )}
          </div>

          {/* Description */}
          {skill.description && (
            <p className="text-sm text-surface-400">{skill.description}</p>
          )}

          {/* Agent Invocation */}
          <div className="pt-2">
            <span className="text-xs text-surface-500 block mb-2">
              Agent Invocation
            </span>
            <div className="bg-surface-900/50 rounded p-3">
              <code className="text-sm text-accent-purple font-mono">
                {invocationText}
              </code>
            </div>
          </div>

          {/* Content Preview */}
          {skill.content && (
            <div className="pt-2">
              <span className="text-xs text-surface-500 block mb-2">
                Content Preview
              </span>
              <div className="bg-surface-900/50 rounded p-3 max-h-32 overflow-y-auto">
                <pre className="text-xs text-surface-400 whitespace-pre-wrap font-mono">
                  {skill.content.length > 300
                    ? `${skill.content.slice(0, 300)}...`
                    : skill.content}
                </pre>
              </div>
            </div>
          )}

          {/* Allowed Tools */}
          {skill.allowedTools && skill.allowedTools.length > 0 && (
            <div className="pt-2">
              <div className="flex items-center gap-2 mb-2">
                <Wrench className="w-3.5 h-3.5 text-surface-500" />
                <span className="text-xs text-surface-500">Allowed Tools</span>
              </div>
              <div className="flex items-center gap-2 flex-wrap">
                {skill.allowedTools.slice(0, 5).map((tool) => (
                  <span
                    key={tool}
                    className="inline-flex items-center px-2 py-0.5 bg-surface-900 text-surface-400 rounded text-xs font-mono"
                  >
                    {tool}
                  </span>
                ))}
                {skill.allowedTools.length > 5 && (
                  <span className="text-xs text-surface-600">
                    +{skill.allowedTools.length - 5} more
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
