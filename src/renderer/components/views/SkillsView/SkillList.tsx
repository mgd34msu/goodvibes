// ============================================================================
// AGENT SKILL LIST COMPONENT
// ============================================================================

import { Sparkles } from 'lucide-react';
import { SkillCard } from './SkillCard';
import type { AgentSkill, BuiltInAgentSkill } from './types';

interface SkillListProps {
  customSkills: AgentSkill[];
  builtInSkills: (BuiltInAgentSkill & { isBuiltIn: true })[];
  showBuiltIn: boolean;
  onInstallSkill?: (skill: BuiltInAgentSkill & { isBuiltIn: true }) => void;
  onDeleteSkill: (id: number) => void;
  onCreateNew: () => void;
  searchQuery: string;
}

export function SkillList({
  customSkills,
  builtInSkills,
  showBuiltIn,
  onInstallSkill,
  onDeleteSkill,
  onCreateNew,
  searchQuery,
}: SkillListProps) {
  const hasCustomSkills = customSkills.length > 0;
  const hasBuiltInSkills = builtInSkills.length > 0;
  const isEmpty = !hasCustomSkills && (!showBuiltIn || !hasBuiltInSkills);

  if (isEmpty) {
    return (
      <div className="text-center py-12">
        <Sparkles className="w-12 h-12 text-surface-600 mx-auto mb-4" />
        <h3 className="text-lg font-medium text-surface-300">
          {searchQuery ? 'No skills match your search' : 'No custom agent skills yet'}
        </h3>
        <p className="text-surface-500 mt-2">
          {searchQuery
            ? 'Try a different search term'
            : 'Create agent skills for programmatic invocation by AI agents'}
        </p>
        {!searchQuery && (
          <button
            onClick={onCreateNew}
            className="mt-4 px-4 py-2 bg-surface-700 text-surface-200 rounded-lg hover:bg-surface-600 transition-colors"
          >
            Create your first agent skill
          </button>
        )}
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Custom Skills */}
      {hasCustomSkills && (
        <div>
          <h2 className="text-sm font-medium text-surface-400 mb-3">
            Custom Agent Skills ({customSkills.length})
          </h2>
          <div className="space-y-3">
            {customSkills.map((skill) => (
              <SkillCard
                key={skill.id}
                skill={skill}
                onDelete={() => onDeleteSkill(skill.id)}
              />
            ))}
          </div>
        </div>
      )}

      {/* Built-in Skills */}
      {showBuiltIn && hasBuiltInSkills && (
        <div>
          <h2 className="text-sm font-medium text-surface-400 mb-3">
            Built-in Agent Skills ({builtInSkills.length})
          </h2>
          <div className="space-y-3">
            {builtInSkills.map((skill) => (
              <SkillCard
                key={skill.name}
                skill={skill}
                onInstall={() => onInstallSkill?.(skill)}
                isInstalled={customSkills.some((s) => s.name === skill.name)}
              />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
