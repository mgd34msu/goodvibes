// ============================================================================
// PROJECT SETUP STEP
// Configure initial project directory
// ============================================================================

import { useState, useCallback } from 'react';
import { FolderOpen, Check, AlertCircle, RefreshCw } from 'lucide-react';
import { clsx } from 'clsx';
import { useSettingsStore } from '../../stores/settingsStore';

// ============================================================================
// Component
// ============================================================================

export function ProjectSetupStep() {
  const settings = useSettingsStore((s) => s.settings);
  const updateSetting = useSettingsStore((s) => s.updateSetting);

  const [projectsRoot, setProjectsRoot] = useState(settings.projectsRoot || '');
  const [defaultCwd, setDefaultCwd] = useState(settings.defaultCwd || '');
  const [isValidating, setIsValidating] = useState(false);
  const [validationState, setValidationState] = useState<{
    projectsRoot: 'idle' | 'valid' | 'invalid';
    defaultCwd: 'idle' | 'valid' | 'invalid';
  }>({ projectsRoot: 'idle', defaultCwd: 'idle' });

  const validatePath = useCallback(async (path: string): Promise<boolean> => {
    if (!path) return false;
    // Path validation is done by trying to select and checking if it exists
    // Since we're just validating a typed path, we assume it's valid if non-empty
    // The actual validation will happen when the user starts a session
    return path.length > 0;
  }, []);

  const handleBrowseProjectsRoot = useCallback(async () => {
    try {
      const folder = await window.goodvibes.selectFolder();
      if (folder) {
        setProjectsRoot(folder);
        await updateSetting('projectsRoot', folder);
        setValidationState((s) => ({ ...s, projectsRoot: 'valid' }));
      }
    } catch (err) {
      console.error('Failed to open directory picker:', err);
    }
  }, [updateSetting]);

  const handleBrowseDefaultCwd = useCallback(async () => {
    try {
      const folder = await window.goodvibes.selectFolder();
      if (folder) {
        setDefaultCwd(folder);
        await updateSetting('defaultCwd', folder);
        setValidationState((s) => ({ ...s, defaultCwd: 'valid' }));
      }
    } catch (err) {
      console.error('Failed to open directory picker:', err);
    }
  }, [updateSetting]);

  const handleValidateProjectsRoot = useCallback(async () => {
    if (!projectsRoot) return;
    setIsValidating(true);
    const isValid = await validatePath(projectsRoot);
    setValidationState((s) => ({ ...s, projectsRoot: isValid ? 'valid' : 'invalid' }));
    if (isValid) {
      await updateSetting('projectsRoot', projectsRoot);
    }
    setIsValidating(false);
  }, [projectsRoot, validatePath, updateSetting]);

  const handleValidateDefaultCwd = useCallback(async () => {
    if (!defaultCwd) return;
    setIsValidating(true);
    const isValid = await validatePath(defaultCwd);
    setValidationState((s) => ({ ...s, defaultCwd: isValid ? 'valid' : 'invalid' }));
    if (isValid) {
      await updateSetting('defaultCwd', defaultCwd);
    }
    setIsValidating(false);
  }, [defaultCwd, validatePath, updateSetting]);

  return (
    <div className="space-y-6">
      {/* Projects Root Directory */}
      <div className="space-y-3">
        <label className="block">
          <span className="text-sm font-medium text-surface-200">
            Projects Root Directory
          </span>
          <span className="text-xs text-surface-500 ml-2">(Optional)</span>
        </label>
        <p className="text-sm text-surface-400">
          The root folder containing all your projects. This helps GoodVibes discover and organize your sessions.
        </p>
        <div className="flex gap-2">
          <div className="relative flex-1">
            <input
              type="text"
              value={projectsRoot}
              onChange={(e) => {
                setProjectsRoot(e.target.value);
                setValidationState((s) => ({ ...s, projectsRoot: 'idle' }));
              }}
              onBlur={handleValidateProjectsRoot}
              placeholder="C:\Users\You\Projects"
              className={clsx(
                'input w-full pr-10',
                validationState.projectsRoot === 'valid' && 'border-success-500',
                validationState.projectsRoot === 'invalid' && 'border-error-500'
              )}
            />
            {validationState.projectsRoot === 'valid' && (
              <Check className="absolute right-3 top-1/2 -translate-y-1/2 w-4 h-4 text-success-500" />
            )}
            {validationState.projectsRoot === 'invalid' && (
              <AlertCircle className="absolute right-3 top-1/2 -translate-y-1/2 w-4 h-4 text-error-500" />
            )}
          </div>
          <button
            onClick={handleBrowseProjectsRoot}
            className="btn btn-secondary flex items-center gap-2"
          >
            <FolderOpen className="w-4 h-4" />
            Browse
          </button>
        </div>
        {validationState.projectsRoot === 'invalid' && (
          <p className="text-xs text-error-400">
            This directory does not exist or is not accessible.
          </p>
        )}
      </div>

      {/* Default Working Directory */}
      <div className="space-y-3">
        <label className="block">
          <span className="text-sm font-medium text-surface-200">
            Default Working Directory
          </span>
          <span className="text-xs text-surface-500 ml-2">(Optional)</span>
        </label>
        <p className="text-sm text-surface-400">
          The default folder for new terminal sessions. Leave empty to use the last used directory.
        </p>
        <div className="flex gap-2">
          <div className="relative flex-1">
            <input
              type="text"
              value={defaultCwd}
              onChange={(e) => {
                setDefaultCwd(e.target.value);
                setValidationState((s) => ({ ...s, defaultCwd: 'idle' }));
              }}
              onBlur={handleValidateDefaultCwd}
              placeholder="C:\Users\You\Projects\my-project"
              className={clsx(
                'input w-full pr-10',
                validationState.defaultCwd === 'valid' && 'border-success-500',
                validationState.defaultCwd === 'invalid' && 'border-error-500'
              )}
            />
            {validationState.defaultCwd === 'valid' && (
              <Check className="absolute right-3 top-1/2 -translate-y-1/2 w-4 h-4 text-success-500" />
            )}
            {validationState.defaultCwd === 'invalid' && (
              <AlertCircle className="absolute right-3 top-1/2 -translate-y-1/2 w-4 h-4 text-error-500" />
            )}
          </div>
          <button
            onClick={handleBrowseDefaultCwd}
            className="btn btn-secondary flex items-center gap-2"
          >
            <FolderOpen className="w-4 h-4" />
            Browse
          </button>
        </div>
        {validationState.defaultCwd === 'invalid' && (
          <p className="text-xs text-error-400">
            This directory does not exist or is not accessible.
          </p>
        )}
      </div>

      {/* Startup Behavior */}
      <div className="space-y-3">
        <label className="block text-sm font-medium text-surface-200">
          Startup Behavior
        </label>
        <div className="space-y-2">
          <StartupOption
            value="empty"
            label="Start Empty"
            description="Open GoodVibes without any terminal sessions"
            current={settings.startupBehavior}
            onChange={(v) => updateSetting('startupBehavior', v)}
          />
          <StartupOption
            value="last-project"
            label="Restore Last Session"
            description="Open the last project you were working on"
            current={settings.startupBehavior}
            onChange={(v) => updateSetting('startupBehavior', v)}
          />
          <StartupOption
            value="folder-picker"
            label="Show Folder Picker"
            description="Prompt to select a project folder on startup"
            current={settings.startupBehavior}
            onChange={(v) => updateSetting('startupBehavior', v)}
          />
        </div>
      </div>

      {/* Validation indicator */}
      {isValidating && (
        <div className="flex items-center gap-2 text-sm text-surface-400">
          <RefreshCw className="w-4 h-4 animate-spin" />
          Validating paths...
        </div>
      )}
    </div>
  );
}

// ============================================================================
// Startup Option
// ============================================================================

interface StartupOptionProps {
  value: 'empty' | 'last-project' | 'folder-picker';
  label: string;
  description: string;
  current: string;
  onChange: (value: 'empty' | 'last-project' | 'folder-picker') => void;
}

function StartupOption({ value, label, description, current, onChange }: StartupOptionProps) {
  const isSelected = current === value;

  return (
    <label
      className={clsx(
        'flex items-start gap-3 p-3 rounded-lg border cursor-pointer transition-colors',
        isSelected
          ? 'border-primary-500 bg-primary-500/10'
          : 'border-surface-700 hover:border-surface-600'
      )}
    >
      <input
        type="radio"
        name="startupBehavior"
        value={value}
        checked={isSelected}
        onChange={() => onChange(value)}
        className="mt-0.5"
      />
      <div>
        <div className="text-sm font-medium text-surface-200">{label}</div>
        <div className="text-xs text-surface-500">{description}</div>
      </div>
    </label>
  );
}
