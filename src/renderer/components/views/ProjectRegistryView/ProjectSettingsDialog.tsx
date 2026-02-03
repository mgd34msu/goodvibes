// ============================================================================
// PROJECT SETTINGS DIALOG
// ============================================================================

import { useState } from 'react';
import type { RegisteredProject, ProjectSettings } from './types';

interface ProjectSettingsDialogProps {
  project: RegisteredProject;
  onSave: (settings: ProjectSettings) => void;
  onClose: () => void;
}

export function ProjectSettingsDialog({
  project,
  onSave,
  onClose,
}: ProjectSettingsDialogProps) {
  const [settings, setSettings] = useState<ProjectSettings>(project.settings);
  const [newTag, setNewTag] = useState('');

  function handleAddTag() {
    if (newTag.trim()) {
      setSettings(prev => ({
        ...prev,
        tags: [...(prev.tags || []), newTag.trim()],
      }));
      setNewTag('');
    }
  }

  function handleRemoveTag(index: number) {
    setSettings(prev => ({
      ...prev,
      tags: prev.tags?.filter((_, i) => i !== index),
    }));
  }

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-[9999]" onClick={onClose}>
      <div
        className="bg-surface-900 border border-surface-700 rounded-lg shadow-xl w-full max-w-lg max-h-[90vh] overflow-auto"
        onClick={e => e.stopPropagation()}
      >
        <div className="flex items-center justify-between p-4 border-b border-surface-700">
          <h2 className="text-lg font-medium text-surface-100">Project Settings</h2>
          <button onClick={onClose} className="text-surface-500 hover:text-surface-300">x</button>
        </div>

        <div className="p-4 space-y-4">
          {/* Model */}
          <div>
            <label className="block text-sm font-medium text-surface-300 mb-1">Default Model</label>
            <select
              value={settings.defaultModel || ''}
              onChange={e => setSettings(prev => ({ ...prev, defaultModel: e.target.value || undefined }))}
              className="input w-full"
            >
              <option value="">Default</option>
              <option value="claude-sonnet-4">Claude Sonnet 4</option>
              <option value="claude-opus-4-5">Claude Opus 4.5</option>
            </select>
          </div>

          {/* Permission Mode */}
          <div>
            <label className="block text-sm font-medium text-surface-300 mb-1">Permission Mode</label>
            <select
              value={settings.permissionMode || 'default'}
              onChange={e => setSettings(prev => ({ ...prev, permissionMode: e.target.value as ProjectSettings['permissionMode'] }))}
              className="input w-full"
            >
              <option value="default">Default</option>
              <option value="strict">Strict</option>
              <option value="permissive">Permissive</option>
            </select>
          </div>

          {/* Budget */}
          <div>
            <label className="block text-sm font-medium text-surface-300 mb-1">Budget Limit (USD)</label>
            <input
              type="number"
              step="0.01"
              min="0"
              value={settings.budgetLimitUsd || ''}
              onChange={e => setSettings(prev => ({ ...prev, budgetLimitUsd: parseFloat(e.target.value) || undefined }))}
              className="input w-full"
              placeholder="No limit"
            />
          </div>

          {/* Priority */}
          <div>
            <label className="block text-sm font-medium text-surface-300 mb-1">Priority</label>
            <input
              type="number"
              min="0"
              max="100"
              value={settings.priority || 0}
              onChange={e => setSettings(prev => ({ ...prev, priority: parseInt(e.target.value) || 0 }))}
              className="input w-full"
            />
            <p className="text-xs text-surface-500 mt-1">Higher priority projects get precedence in multi-project orchestration</p>
          </div>

          {/* Auto-inject CLAUDE.md */}
          <div className="flex items-center gap-3">
            <input
              type="checkbox"
              id="autoInjectClaudeMd"
              checked={settings.autoInjectClaudeMd ?? false}
              onChange={e => setSettings(prev => ({ ...prev, autoInjectClaudeMd: e.target.checked }))}
              className="w-4 h-4 rounded border-surface-600"
            />
            <label htmlFor="autoInjectClaudeMd" className="text-sm text-surface-300">
              Auto-inject CLAUDE.md on session start
            </label>
          </div>

          {/* Tags */}
          <div>
            <label className="block text-sm font-medium text-surface-300 mb-1">Tags</label>
            <div className="flex flex-wrap gap-2 mb-2">
              {settings.tags?.map((tag, i) => (
                <span
                  key={i}
                  className="px-2 py-1 bg-surface-700 rounded text-sm text-surface-300 flex items-center gap-1"
                >
                  {tag}
                  <button
                    onClick={() => handleRemoveTag(i)}
                    className="text-surface-500 hover:text-surface-300"
                  >
                    x
                  </button>
                </span>
              ))}
            </div>
            <div className="flex gap-2">
              <input
                type="text"
                value={newTag}
                onChange={e => setNewTag(e.target.value)}
                onKeyDown={e => e.key === 'Enter' && handleAddTag()}
                className="input flex-1"
                placeholder="Add tag..."
              />
              <button onClick={handleAddTag} className="btn btn-secondary">Add</button>
            </div>
          </div>
        </div>

        <div className="flex justify-end gap-3 p-4 border-t border-surface-700">
          <button onClick={onClose} className="btn btn-ghost">Cancel</button>
          <button onClick={() => onSave(settings)} className="btn btn-primary">Save</button>
        </div>
      </div>
    </div>
  );
}
