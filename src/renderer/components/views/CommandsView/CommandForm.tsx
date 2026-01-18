// ============================================================================
// COMMAND FORM COMPONENT
// ============================================================================

import React, { useState } from 'react';
import { Save } from 'lucide-react';
import ProjectSelector from '../../shared/ProjectSelector';
import type { Command } from './types';

interface CommandFormProps {
  command?: Command;
  onSave: (command: Partial<Command>, projectPath: string | null) => void;
  onCancel: () => void;
}

export function CommandForm({ command, onSave, onCancel }: CommandFormProps) {
  const [name, setName] = useState(command?.name || '');
  const [description, setDescription] = useState(command?.description || '');
  const [content, setContent] = useState(command?.content || '');
  const [allowedToolsString, setAllowedToolsString] = useState(
    command?.allowedTools?.join(', ') || ''
  );
  const [scope, setScope] = useState<'user' | 'project'>(command?.scope || 'user');
  const [selectedProjectId, setSelectedProjectId] = useState<number | null>(null);
  const [selectedProjectPath, setSelectedProjectPath] = useState<string | null>(command?.projectPath || null);

  const handleProjectChange = (projectId: number | null, projectPath: string | null) => {
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

    onSave({
      id: command?.id,
      name,
      description: description || null,
      content,
      allowedTools: allowedTools.length > 0 ? allowedTools : null,
      scope,
      projectPath,
    }, projectPath);
  };

  return (
    <form
      onSubmit={handleSubmit}
      className="space-y-4 bg-surface-900 rounded-lg p-4 border border-surface-700"
    >
      <div className="grid grid-cols-3 gap-4">
        <div>
          <label className="block text-sm font-medium text-surface-300 mb-1">
            Command Name
          </label>
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="my-command"
            pattern="[a-z0-9-]+"
            className="w-full px-3 py-2 bg-surface-800 border border-surface-600 rounded-md text-surface-100 focus:ring-2 focus:ring-accent-purple focus:border-transparent"
            required
          />
          <p className="text-xs text-surface-500 mt-1">
            Lowercase letters, numbers, and hyphens only
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
          placeholder="What this command does..."
          className="w-full px-3 py-2 bg-surface-800 border border-surface-600 rounded-md text-surface-100 focus:ring-2 focus:ring-accent-purple focus:border-transparent"
        />
      </div>

      <div>
        <label className="block text-sm font-medium text-surface-300 mb-1">
          Command Content (SKILL.md)
        </label>
        <textarea
          value={content}
          onChange={(e) => setContent(e.target.value)}
          placeholder="# Command Instructions&#10;&#10;Provide detailed instructions for this command..."
          rows={12}
          className="w-full px-3 py-2 bg-surface-800 border border-surface-600 rounded-md text-surface-100 font-mono text-sm focus:ring-2 focus:ring-accent-purple focus:border-transparent"
          required
        />
      </div>

      <div>
        <label className="block text-sm font-medium text-surface-300 mb-1">
          Allowed Tools (comma-separated)
        </label>
        <input
          type="text"
          value={allowedToolsString}
          onChange={(e) => setAllowedToolsString(e.target.value)}
          placeholder="Bash, Read, Edit, Grep"
          className="w-full px-3 py-2 bg-surface-800 border border-surface-600 rounded-md text-surface-100 focus:ring-2 focus:ring-accent-purple focus:border-transparent"
        />
        <p className="text-xs text-surface-500 mt-1">
          Leave empty to allow all tools
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
          {command ? 'Update Command' : 'Create Command'}
        </button>
      </div>
    </form>
  );
}
