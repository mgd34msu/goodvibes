// ============================================================================
// SKILL LIST COMPONENT
// ============================================================================

import { Sparkles } from 'lucide-react';
import { SkillCard } from './SkillCard';
import type { Skill, BuiltInSkill } from './types';

interface SkillListProps {
  customSkills: Skill[];
  builtInSkills: (BuiltInSkill & { isBuiltIn: true })[];
  showBuiltIn: boolean;
  onUseSkill: (name: string) => void;
  onInstallSkill?: (skill: BuiltInSkill & { isBuiltIn: true }) => void;
  onEditSkill: (skill: Skill) => void;
  onDeleteSkill: (id: number) => void;
  onCopyContent: (content: string) => void;
  onCreateNew: () => void;
  searchQuery: string;
}

export function SkillList({
  customSkills,
  builtInSkills,
  showBuiltIn,
  onUseSkill,
  onInstallSkill,
  onEditSkill,
  onDeleteSkill,
  onCopyContent,
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
          {searchQuery ? 'No skills match your search' : 'No custom skills yet'}
        </h3>
        <p className="text-surface-500 mt-2">
          {searchQuery
            ? 'Try a different search term'
            : 'Create skills to automate common workflows'}
        </p>
        {!searchQuery && (
          <button
            onClick={onCreateNew}
            className="mt-4 px-4 py-2 bg-surface-700 text-surface-200 rounded-lg hover:bg-surface-600 transition-colors"
          >
            Create your first skill
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
            Custom Skills ({customSkills.length})
          </h2>
          <div className="space-y-3">
            {customSkills.map((skill) => (
              <SkillCard
                key={skill.id}
                skill={skill}
                onUse={() => onUseSkill(skill.name)}
                onEdit={() => onEditSkill(skill)}
                onDelete={() => onDeleteSkill(skill.id)}
                onCopy={() => onCopyContent(skill.content)}
              />
            ))}
          </div>
        </div>
      )}

      {/* Built-in Skills */}
      {showBuiltIn && hasBuiltInSkills && (
        <div>
          <h2 className="text-sm font-medium text-surface-400 mb-3">
            Built-in Skills ({builtInSkills.length})
          </h2>
          <div className="space-y-3">
            {builtInSkills.map((skill) => (
              <SkillCard
                key={skill.name}
                skill={skill}
                onInstall={() => onInstallSkill?.(skill)}
                onCopy={() => onCopyContent(skill.content)}
              />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
