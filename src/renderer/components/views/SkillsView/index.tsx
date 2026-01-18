// ============================================================================
// AGENT SKILLS VIEW - Agent Skills Library Management
// ============================================================================
//
// This view manages agent-callable skills that are invoked programmatically
// by agents via the Skill tool (e.g., Skill skill: "code-review").
//
// Unlike slash commands (/commit, /pr) which users invoke directly, agent
// skills are designed for agent-to-agent communication and automated workflows.
// ============================================================================

import { useState, useCallback } from 'react';
import { Sparkles, Plus, Settings } from 'lucide-react';
import { SkillForm } from './SkillForm';
import { SkillList } from './SkillList';
import { SkillFilters } from './SkillFilters';
import { InstallSkillModal } from './InstallSkillModal';
import { useAgentSkills, useAgentSkillFilters } from './hooks';
import { useConfirm } from '../../overlays/ConfirmModal';
import { BUILT_IN_AGENT_SKILLS } from './constants';
import type { AgentSkill, BuiltInAgentSkill } from './types';

export default function AgentSkillsView() {
  const { skills, loading, saveSkill, deleteSkill, copyToClipboard } =
    useAgentSkills();
  const [showForm, setShowForm] = useState(false);
  const [editingSkill, setEditingSkill] = useState<AgentSkill | undefined>();
  const [installSkill, setInstallSkill] = useState<BuiltInAgentSkill | null>(null);

  const { confirm: confirmDelete, ConfirmDialog } = useConfirm({
    title: 'Delete Agent Skill',
    message: 'Are you sure you want to delete this agent skill?',
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
  } = useAgentSkillFilters(skills, BUILT_IN_AGENT_SKILLS);

  const handleSave = async (
    skillData: Partial<AgentSkill>,
    projectPath: string | null
  ) => {
    const result = await saveSkill(skillData, projectPath);
    if (result.success) {
      setShowForm(false);
      setEditingSkill(undefined);
    }
  };

  const handleUse = async (skillName: string) => {
    await copyToClipboard(`Skill skill: "${skillName}"`);
  };

  const handleCopy = async (content: string) => {
    await copyToClipboard(content);
  };

  const handleDelete = useCallback(
    async (id: number) => {
      const confirmed = await confirmDelete();
      if (confirmed) {
        await deleteSkill(id);
      }
    },
    [confirmDelete, deleteSkill]
  );

  const handleEdit = (skill: AgentSkill) => {
    setEditingSkill(skill);
    setShowForm(true);
  };

  const handleCancel = () => {
    setShowForm(false);
    setEditingSkill(undefined);
  };

  const handleOpenInstallModal = (
    skill: BuiltInAgentSkill & { isBuiltIn: true }
  ) => {
    // Remove isBuiltIn flag when storing in state
    const { isBuiltIn, ...skillData } = skill;
    setInstallSkill(skillData);
  };

  const handleInstallSkill = async (
    skill: BuiltInAgentSkill,
    scope: 'user' | 'project',
    projectPath: string | null
  ) => {
    const skillData: Partial<AgentSkill> = {
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
                <p className="text-sm text-surface-400">Agent skills library</p>
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
              builtInSkills={filteredBuiltIn.map((s) => ({
                ...s,
                isBuiltIn: true as const,
              }))}
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
                <p className="font-medium text-surface-300 mb-1">
                  About Agent Skills
                </p>
                <p>
                  Agent skills are reusable instruction sets that agents can invoke
                  programmatically. Unlike slash commands which users invoke directly,
                  agent skills are designed for agent-to-agent communication and
                  automated workflows.
                </p>
                <p className="mt-2">
                  Agents invoke skills using the Skill tool:
                </p>
                <code className="block mt-2 bg-surface-800 px-3 py-2 rounded font-mono text-accent-purple">
                  Skill skill: "code-review"
                </code>
                <p className="mt-3">
                  Each skill includes YAML frontmatter with name, description, and
                  allowed-tools to control agent behavior.
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
export type { AgentSkill } from './types';
