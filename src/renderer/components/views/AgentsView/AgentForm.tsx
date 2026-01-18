// ============================================================================
// AGENT FORM COMPONENT
// ============================================================================

import React, { useState } from 'react';
import { Save } from 'lucide-react';
import ProjectSelector from '../../shared/ProjectSelector';
import type { AgentTemplate } from './types';

interface AgentFormProps {
  agent?: AgentTemplate;
  onSave: (agent: Partial<AgentTemplate>, projectPath: string | null) => void;
  onCancel: () => void;
}

export function AgentForm({ agent, onSave, onCancel }: AgentFormProps): React.JSX.Element {
  const [name, setName] = useState(agent?.name || '');
  const [description, setDescription] = useState(agent?.description || '');
  const [scope, setScope] = useState<'user' | 'project'>(agent?.cwd ? 'project' : 'user');
  const [selectedProjectId, setSelectedProjectId] = useState<number | null>(null);
  const [selectedProjectPath, setSelectedProjectPath] = useState<string | null>(agent?.cwd || null);
  const [initialPrompt, setInitialPrompt] = useState(agent?.initialPrompt || '');
  const [claudeMdContent, setClaudeMdContent] = useState(agent?.claudeMdContent || '');
  const [model, setModel] = useState(agent?.model || '');
  const [permissionMode, setPermissionMode] = useState<'default' | 'plan' | 'bypassPermissions'>(
    agent?.permissionMode || 'default'
  );
  const [allowedToolsString, setAllowedToolsString] = useState(
    agent?.allowedTools?.join(', ') || ''
  );
  const [flagsString, setFlagsString] = useState(agent?.flags?.join(', ') || '');

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

    const flags = flagsString
      .split(',')
      .map((f) => f.trim())
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
      id: agent?.id,
      name,
      description: description || null,
      initialPrompt: initialPrompt || null,
      claudeMdContent: claudeMdContent || null,
      model: model || null,
      permissionMode,
      allowedTools: allowedTools.length > 0 ? allowedTools : null,
      flags,
      cwd: projectPath,
      deniedTools: null,
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
            Agent Name
          </label>
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="my-agent"
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

      <div className="grid grid-cols-2 gap-4">
        <div>
          <label className="block text-sm font-medium text-surface-300 mb-1">
            Model
          </label>
          <select
            value={model}
            onChange={(e) => setModel(e.target.value)}
            className="w-full px-3 py-2 bg-surface-800 border border-surface-600 rounded-md text-surface-100 focus:ring-2 focus:ring-accent-purple focus:border-transparent"
          >
            <option value="">Default</option>
            <option value="claude-sonnet-4-20250514">Claude Sonnet 4</option>
            <option value="claude-opus-4-5-20251101">Claude Opus 4.5</option>
            <option value="claude-3-5-haiku-20241022">Claude 3.5 Haiku</option>
          </select>
        </div>

        <div>
          <label className="block text-sm font-medium text-surface-300 mb-1">
            Permission Mode
          </label>
          <select
            value={permissionMode}
            onChange={(e) => setPermissionMode(e.target.value as typeof permissionMode)}
            className="w-full px-3 py-2 bg-surface-800 border border-surface-600 rounded-md text-surface-100 focus:ring-2 focus:ring-accent-purple focus:border-transparent"
          >
            <option value="default">Default</option>
            <option value="plan">Plan Mode</option>
            <option value="bypassPermissions">Bypass Permissions</option>
          </select>
        </div>
      </div>

      <div>
        <label className="block text-sm font-medium text-surface-300 mb-1">
          Description
        </label>
        <input
          type="text"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="What this agent does..."
          className="w-full px-3 py-2 bg-surface-800 border border-surface-600 rounded-md text-surface-100 focus:ring-2 focus:ring-accent-purple focus:border-transparent"
        />
      </div>

      <div>
        <label className="block text-sm font-medium text-surface-300 mb-1">
          Initial Prompt (System Instructions)
        </label>
        <textarea
          value={initialPrompt}
          onChange={(e) => setInitialPrompt(e.target.value)}
          placeholder="# Agent Instructions&#10;&#10;You are a specialized agent that..."
          rows={10}
          className="w-full px-3 py-2 bg-surface-800 border border-surface-600 rounded-md text-surface-100 font-mono text-sm focus:ring-2 focus:ring-accent-purple focus:border-transparent"
        />
      </div>

      <div>
        <label className="block text-sm font-medium text-surface-300 mb-1">
          CLAUDE.md Content (Optional)
        </label>
        <textarea
          value={claudeMdContent}
          onChange={(e) => setClaudeMdContent(e.target.value)}
          placeholder="Additional context to inject into CLAUDE.md..."
          rows={4}
          className="w-full px-3 py-2 bg-surface-800 border border-surface-600 rounded-md text-surface-100 font-mono text-sm focus:ring-2 focus:ring-accent-purple focus:border-transparent"
        />
      </div>

      <div className="grid grid-cols-2 gap-4">
        <div>
          <label className="block text-sm font-medium text-surface-300 mb-1">
            Allowed Tools (comma-separated)
          </label>
          <input
            type="text"
            value={allowedToolsString}
            onChange={(e) => setAllowedToolsString(e.target.value)}
            placeholder="Bash, Read, Edit, Grep, Glob"
            className="w-full px-3 py-2 bg-surface-800 border border-surface-600 rounded-md text-surface-100 focus:ring-2 focus:ring-accent-purple focus:border-transparent"
          />
          <p className="text-xs text-surface-500 mt-1">
            Leave empty to allow all tools
          </p>
        </div>

        <div>
          <label className="block text-sm font-medium text-surface-300 mb-1">
            CLI Flags (comma-separated)
          </label>
          <input
            type="text"
            value={flagsString}
            onChange={(e) => setFlagsString(e.target.value)}
            placeholder="--verbose, --no-cache"
            className="w-full px-3 py-2 bg-surface-800 border border-surface-600 rounded-md text-surface-100 focus:ring-2 focus:ring-accent-purple focus:border-transparent"
          />
          <p className="text-xs text-surface-500 mt-1">
            Additional CLI arguments
          </p>
        </div>
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
          {agent ? 'Update Agent' : 'Create Agent'}
        </button>
      </div>
    </form>
  );
}
