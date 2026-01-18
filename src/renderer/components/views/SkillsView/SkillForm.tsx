// ============================================================================
// AGENT SKILL FORM COMPONENT
// ============================================================================

import React, { useState } from 'react';
import { Save } from 'lucide-react';
import ProjectSelector from '../../shared/ProjectSelector';
import type { AgentSkill } from './types';

interface SkillFormProps {
  skill?: AgentSkill;
  onSave: (skill: Partial<AgentSkill>, projectPath: string | null) => void;
  onCancel: () => void;
}

export function SkillForm({ skill, onSave, onCancel }: SkillFormProps): React.JSX.Element {
  const [name, setName] = useState(skill?.name || '');
  const [description, setDescription] = useState(skill?.description || '');
  const [content, setContent] = useState(
    skill?.content ||
      `---
name: ${name || 'my-skill'}
description: Describe what this skill does
allowed-tools: Read, Edit, Bash, Grep, Glob
---

# Skill Name

Detailed instructions for the agent when this skill is invoked.

## Process

1. First step
2. Second step
3. Third step

## Output Format

Describe expected output format.
`
  );
  const [allowedToolsString, setAllowedToolsString] = useState(
    skill?.allowedTools?.join(', ') || ''
  );
  const [scope, setScope] = useState<'user' | 'project'>(skill?.scope || 'user');
  const [selectedProjectId, setSelectedProjectId] = useState<number | null>(null);
  const [selectedProjectPath, setSelectedProjectPath] = useState<string | null>(
    skill?.projectPath || null
  );

  const handleProjectChange = (
    projectId: number | null,
    projectPath: string | null
  ) => {
    setSelectedProjectId(projectId);
    setSelectedProjectPath(projectPath);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    const allowedTools = allowedToolsString
      .split(',')
      .map((t) => t.trim())
      .filter(Boolean);

    let projectPath: string | null = null;

    if (scope === 'project') {
      if (selectedProjectPath) {
        projectPath = selectedProjectPath;
      } else {
        // No project selected, prompt for folder
        const folderPath = await window.goodvibes?.selectFolder?.();
        if (!folderPath) {
          return; // User cancelled
        }
        projectPath = folderPath;
      }
    }

    onSave(
      {
        id: skill?.id,
        name,
        description: description || '',
        content,
        allowedTools: allowedTools.length > 0 ? allowedTools : null,
        scope,
        projectPath,
      },
      projectPath
    );
  };

  // Update frontmatter when name changes
  const handleNameChange = (newName: string) => {
    setName(newName);
    // Update frontmatter in content if it exists
    if (content.startsWith('---')) {
      const updatedContent = content.replace(
        /^---\nname:\s*.*/m,
        `---\nname: ${newName || 'my-skill'}`
      );
      setContent(updatedContent);
    }
  };

  return (
    <form
      onSubmit={handleSubmit}
      className="space-y-4 bg-surface-900 rounded-lg p-4 border border-surface-700"
    >
      <div className="grid grid-cols-3 gap-4">
        <div>
          <label className="block text-sm font-medium text-surface-300 mb-1">
            Skill Name
          </label>
          <input
            type="text"
            value={name}
            onChange={(e) => handleNameChange(e.target.value)}
            placeholder="code-review"
            pattern="[a-z0-9-]+"
            maxLength={64}
            className="w-full px-3 py-2 bg-surface-800 border border-surface-600 rounded-md text-surface-100 focus:ring-2 focus:ring-accent-purple focus:border-transparent"
            required
          />
          <p className="text-xs text-surface-500 mt-1">
            Lowercase letters, numbers, and hyphens only (max 64 chars)
          </p>
        </div>

        <div>
          <label className="block text-sm font-medium text-surface-300 mb-1">
            Scope
          </label>
          <select
            value={scope}
            onChange={(e) => {
              const newScope = e.target.value as 'user' | 'project';
              setScope(newScope);
              if (newScope === 'user') {
                setSelectedProjectId(null);
                setSelectedProjectPath(null);
              }
            }}
            className="w-full px-3 py-2 bg-surface-800 border border-surface-600 rounded-md text-surface-100 focus:ring-2 focus:ring-accent-purple focus:border-transparent"
          >
            <option value="user">User (Global)</option>
            <option value="project">Project</option>
          </select>
        </div>

        <ProjectSelector
          scope={scope}
          selectedProjectId={selectedProjectId}
          onProjectChange={handleProjectChange}
        />
      </div>

      <div>
        <label className="block text-sm font-medium text-surface-300 mb-1">
          Description
        </label>
        <input
          type="text"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="Performs thorough code review with security analysis..."
          className="w-full px-3 py-2 bg-surface-800 border border-surface-600 rounded-md text-surface-100 focus:ring-2 focus:ring-accent-purple focus:border-transparent"
        />
        <p className="text-xs text-surface-500 mt-1">
          Brief description of what this skill does (shown in listings)
        </p>
      </div>

      <div>
        <label className="block text-sm font-medium text-surface-300 mb-1">
          Skill Content (SKILL.md with Frontmatter)
        </label>
        <textarea
          value={content}
          onChange={(e) => setContent(e.target.value)}
          placeholder="---&#10;name: skill-name&#10;description: What the skill does&#10;allowed-tools: Tool1, Tool2&#10;---&#10;&#10;# Skill Instructions..."
          rows={16}
          className="w-full px-3 py-2 bg-surface-800 border border-surface-600 rounded-md text-surface-100 font-mono text-sm focus:ring-2 focus:ring-accent-purple focus:border-transparent"
          required
        />
        <p className="text-xs text-surface-500 mt-1">
          Include YAML frontmatter with name, description, and allowed-tools
        </p>
      </div>

      <div>
        <label className="block text-sm font-medium text-surface-300 mb-1">
          Allowed Tools (comma-separated)
        </label>
        <input
          type="text"
          value={allowedToolsString}
          onChange={(e) => setAllowedToolsString(e.target.value)}
          placeholder="Read, Edit, Bash, Grep, Glob"
          className="w-full px-3 py-2 bg-surface-800 border border-surface-600 rounded-md text-surface-100 focus:ring-2 focus:ring-accent-purple focus:border-transparent"
        />
        <p className="text-xs text-surface-500 mt-1">
          Leave empty to allow all tools. This overrides frontmatter if set.
        </p>
      </div>

      <div className="flex justify-end gap-2 pt-2">
        <button
          type="button"
          onClick={onCancel}
          className="px-4 py-2 text-surface-300 hover:text-surface-100 hover:bg-surface-700 rounded-md transition-colors"
        >
          Cancel
        </button>
        <button
          type="submit"
          className="px-4 py-2 bg-accent-purple text-white rounded-md hover:bg-accent-purple/80 transition-colors flex items-center gap-2"
        >
          <Save className="w-4 h-4" />
          {skill ? 'Update Skill' : 'Create Skill'}
        </button>
      </div>
    </form>
  );
}
