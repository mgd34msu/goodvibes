// ============================================================================
// SKILLS VIEW - Skills Library Management
// ============================================================================

import { useState, useCallback } from 'react';
import { Sparkles, Plus, Settings } from 'lucide-react';
import { SkillForm } from './SkillForm';
import { SkillList } from './SkillList';
import { SkillFilters } from './SkillFilters';
import { InstallSkillModal } from './InstallSkillModal';
import { useSkills, useSkillFilters } from './hooks';
import { useConfirm } from '../../overlays/ConfirmModal';
import { BUILT_IN_SKILLS } from './constants';
import type { Skill, BuiltInSkill } from './types';

export default function SkillsView() {
  const { skills, loading, saveSkill, deleteSkill, copyToClipboard } = useSkills();
  const [showForm, setShowForm] = useState(false);
  const [editingSkill, setEditingSkill] = useState<Skill | undefined>();
  const [installSkill, setInstallSkill] = useState<BuiltInSkill | null>(null);

  const { confirm: confirmDelete, ConfirmDialog } = useConfirm({
    title: 'Delete Skill',
    message: 'Are you sure you want to delete this skill?',
    confirmText: 'Delete',
    variant: 'danger',
  });

  const {
    searchQuery,
    setSearchQuery,
    showBuiltIn,
    setShowBuiltIn,
    filteredSkills,
    filteredBuiltIn,
  } = useSkillFilters(skills, BUILT_IN_SKILLS);

  const handleSave = async (skillData: Partial<Skill>, projectPath: string | null) => {
    const result = await saveSkill(skillData, projectPath);
    if (result.success) {
      setShowForm(false);
      setEditingSkill(undefined);
    }
  };

  const handleUse = async (skillName: string) => {
    await copyToClipboard(`/${skillName}`);
  };

  const handleCopy = async (content: string) => {
    await copyToClipboard(content);
  };

  const handleDelete = useCallback(async (id: number) => {
    const confirmed = await confirmDelete();
    if (confirmed) {
      await deleteSkill(id);
    }
  }, [confirmDelete, deleteSkill]);

  const handleEdit = (skill: Skill) => {
    setEditingSkill(skill);
    setShowForm(true);
  };

  const handleCancel = () => {
    setShowForm(false);
    setEditingSkill(undefined);
  };

  const handleOpenInstallModal = (skill: BuiltInSkill & { isBuiltIn: true }) => {
    // Remove isBuiltIn flag when storing in state
    const { isBuiltIn, ...skillData } = skill;
    setInstallSkill(skillData);
  };

  const handleInstallSkill = async (
    skill: BuiltInSkill,
    scope: 'user' | 'project',
    projectPath: string | null
  ) => {
    const skillData: Partial<Skill> = {
      name: skill.name,
      description: skill.description,
      content: skill.content,
      allowedTools: skill.allowedTools,
      scope,
    };

    await saveSkill(skillData, projectPath);
    setInstallSkill(null);
  };

  return (
    <>
    <ConfirmDialog />
    {installSkill && (
      <InstallSkillModal
        skill={installSkill}
        isOpen={installSkill !== null}
        onClose={() => setInstallSkill(null)}
        onInstall={handleInstallSkill}
      />
    )}
    <div className="h-full flex flex-col">
      {/* Header */}
      <div className="flex-shrink-0 px-6 py-4 border-b border-surface-800">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <Sparkles className="w-6 h-6 text-accent-purple" />
            <div>
              <h1 className="text-xl font-semibold text-surface-100">Skills</h1>
              <p className="text-sm text-surface-400">
                Custom skill library for Claude Code
              </p>
            </div>
          </div>

          <button
            onClick={() => {
              setEditingSkill(undefined);
              setShowForm(true);
            }}
            className="px-4 py-2 bg-accent-purple text-white rounded-lg hover:bg-accent-purple/80 transition-colors flex items-center gap-2"
          >
            <Plus className="w-4 h-4" />
            New Skill
          </button>
        </div>

        <SkillFilters
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
            <SkillForm
              skill={editingSkill}
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
          <SkillList
            customSkills={filteredSkills}
            builtInSkills={filteredBuiltIn.map((s) => ({ ...s, isBuiltIn: true as const }))}
            showBuiltIn={showBuiltIn}
            onUseSkill={handleUse}
            onInstallSkill={handleOpenInstallModal}
            onEditSkill={handleEdit}
            onDeleteSkill={handleDelete}
            onCopyContent={handleCopy}
            onCreateNew={() => setShowForm(true)}
            searchQuery={searchQuery}
          />
        )}

        {/* Info section */}
        <div className="mt-8 p-4 bg-surface-900 rounded-lg border border-surface-700">
          <div className="flex items-start gap-3">
            <Settings className="w-5 h-5 text-surface-400 mt-0.5" />
            <div className="text-sm text-surface-400">
              <p className="font-medium text-surface-300 mb-1">About Skills</p>
              <p>
                Skills are reusable instruction sets that can be invoked with slash commands
                (e.g., /commit, /review-pr). They help maintain consistency across sessions
                and automate common workflows.
              </p>
              <p className="mt-2">
                Use the Skill tool in Claude Code: <code className="bg-surface-800 px-1 rounded">Skill skill: "my-skill"</code>
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
export type { Skill } from './types';
