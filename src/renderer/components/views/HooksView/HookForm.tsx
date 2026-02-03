// ============================================================================
// HOOK FORM COMPONENT
// ============================================================================

import React, { useState, useMemo } from 'react';
import { Save, Terminal, MessageSquare } from 'lucide-react';
import ProjectSelector from '../../shared/ProjectSelector';
import { MatcherSuggestions } from './MatcherSuggestions';
import { InputSchemaPreview } from './InputSchemaPreview';
import { OutputDecisionHelp } from './OutputDecisionHelp';
import { EnvironmentVariables } from './EnvironmentVariables';
import { HookTestPanel } from './HookTestPanel';
import { EVENT_TYPES, type Hook, type HookEventType } from './types';

interface HookFormProps {
  hook?: Hook;
  onSave: (hook: Partial<Hook>) => void;
  onCancel: () => void;
}

export function HookForm({ hook, onSave, onCancel }: HookFormProps): React.JSX.Element {
  const [name, setName] = useState(hook?.name || '');
  const [eventType, setEventType] = useState<HookEventType>(
    hook?.eventType || 'PostToolUse'
  );
  const [matcher, setMatcher] = useState(hook?.matcher || '*');
  const [command, setCommand] = useState(hook?.command || '');
  const [timeout, setTimeout] = useState(hook?.timeout || 30000);
  const [scope, setScope] = useState<'user' | 'project'>(hook?.scope || 'user');
  const [selectedProjectId, setSelectedProjectId] = useState<number | null>(null);
  const [selectedProjectPath, setSelectedProjectPath] = useState<string | null>(hook?.projectPath || null);
  const [hookType, setHookType] = useState<'command' | 'prompt'>(hook?.hookType || 'command');
  const [prompt, setPrompt] = useState(hook?.prompt || '');

  const selectedEventType = useMemo(
    () => EVENT_TYPES.find((e) => e.value === eventType),
    [eventType]
  );

  const handleProjectChange = (projectId: number | null, projectPath: string | null) => {
    setSelectedProjectId(projectId);
    setSelectedProjectPath(projectPath);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

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
      id: hook?.id,
      name,
      eventType,
      matcher,
      command: hookType === 'command' ? command : '',
      hookType,
      prompt: hookType === 'prompt' ? prompt : null,
      timeout,
      scope,
      projectPath,
      enabled: hook?.enabled ?? true,
    });
  };

  return (
    <form
      onSubmit={handleSubmit}
      className="space-y-4 bg-surface-900 rounded-lg p-4 border border-surface-700"
    >
      {/* Row 1: Name, Scope, Project */}
      <div className="grid grid-cols-3 gap-4">
        <div>
          <label className="block text-sm font-medium text-surface-300 mb-1">
            Name
          </label>
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="My Hook"
            className="w-full px-3 py-2 bg-surface-800 border border-surface-600 rounded-md text-surface-100 focus:ring-2 focus:ring-accent-purple focus:border-transparent"
            required
          />
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

      {/* Row 2: Event Type */}
      <div>
        <label className="block text-sm font-medium text-surface-300 mb-1">
          Event Type
        </label>
        <select
          value={eventType}
          onChange={(e) => setEventType(e.target.value as HookEventType)}
          className="w-full px-3 py-2 bg-surface-800 border border-surface-600 rounded-md text-surface-100 focus:ring-2 focus:ring-accent-purple focus:border-transparent"
        >
          {EVENT_TYPES.map((type) => (
            <option key={type.value} value={type.value}>
              {type.label} - {type.description}
            </option>
          ))}
        </select>
        {selectedEventType && (
          <div className="mt-2 text-xs text-surface-500">
            {selectedEventType.description}
            <div className="mt-1">
              Common uses: {selectedEventType.commonUseCases.slice(0, 3).join(', ')}
            </div>
          </div>
        )}
      </div>

      {/* Row 3: Hook Type Toggle */}
      <div>
        <label className="block text-sm font-medium text-surface-300 mb-1">
          Hook Type
        </label>
        <div className="flex gap-2">
          <button
            type="button"
            onClick={() => setHookType('command')}
            className={`flex-1 px-3 py-2 rounded-md text-sm transition-colors ${
              hookType === 'command'
                ? 'bg-accent-purple text-white'
                : 'bg-surface-800 text-surface-300 hover:bg-surface-700'
            }`}
          >
            <Terminal className="w-4 h-4 inline mr-2" />
            Command
          </button>
          <button
            type="button"
            onClick={() => setHookType('prompt')}
            className={`flex-1 px-3 py-2 rounded-md text-sm transition-colors ${
              hookType === 'prompt'
                ? 'bg-accent-purple text-white'
                : 'bg-surface-800 text-surface-300 hover:bg-surface-700'
            }`}
          >
            <MessageSquare className="w-4 h-4 inline mr-2" />
            Prompt
          </button>
        </div>
      </div>

      <div>
        <label className="block text-sm font-medium text-surface-300 mb-1">
          Matcher Pattern
          <span className="text-surface-500 ml-2 font-normal">
            (e.g., * for all, Bash(*) for Bash tool)
          </span>
        </label>
        <input
          type="text"
          value={matcher}
          onChange={(e) => setMatcher(e.target.value)}
          placeholder="*"
          className="w-full px-3 py-2 bg-surface-800 border border-surface-600 rounded-md text-surface-100 focus:ring-2 focus:ring-accent-purple focus:border-transparent"
        />
        <div className="mt-2">
          <MatcherSuggestions
            eventType={eventType}
            currentValue={matcher}
            onSelect={(pattern) => setMatcher(pattern)}
          />
        </div>
      </div>

      {hookType === 'command' ? (
        <div>
          <label className="block text-sm font-medium text-surface-300 mb-1">
            Command
          </label>
          <div className="relative">
            <Terminal className="absolute left-3 top-1/2 transform -translate-y-1/2 w-4 h-4 text-surface-500" />
            <input
              type="text"
              value={command}
              onChange={(e) => setCommand(e.target.value)}
              placeholder="node /path/to/script.js"
              className="w-full pl-10 pr-3 py-2 bg-surface-800 border border-surface-600 rounded-md text-surface-100 font-mono text-sm focus:ring-2 focus:ring-accent-purple focus:border-transparent"
              required
            />
          </div>
        </div>
      ) : (
        <div>
          <label className="block text-sm font-medium text-surface-300 mb-1">
            Prompt
          </label>
          <textarea
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            placeholder="Evaluate if the operation should proceed. Context: $ARGUMENTS..."
            rows={6}
            className="w-full px-3 py-2 bg-surface-800 border border-surface-600 rounded-md text-surface-100 font-mono text-sm focus:ring-2 focus:ring-accent-purple focus:border-transparent"
            required
          />
          <p className="text-xs text-surface-500 mt-1">
            Use $ARGUMENTS to reference the hook input JSON
          </p>
        </div>
      )}

      <div>
        <label className="block text-sm font-medium text-surface-300 mb-1">
          Timeout (ms)
        </label>
        <input
          type="number"
          value={timeout}
          onChange={(e) => setTimeout(parseInt(e.target.value, 10))}
          min={1000}
          max={300000}
          className="w-full max-w-xs px-3 py-2 bg-surface-800 border border-surface-600 rounded-md text-surface-100 focus:ring-2 focus:ring-accent-purple focus:border-transparent"
        />
      </div>

      {/* Documentation Section */}
      <div className="space-y-2 pt-4 border-t border-surface-700">
        <h3 className="text-sm font-medium text-surface-300">Documentation & Testing</h3>
        <InputSchemaPreview eventType={eventType} />
        <OutputDecisionHelp eventType={eventType} />
        <EnvironmentVariables eventType={eventType} />
        <HookTestPanel
          eventType={eventType}
          hookType={hookType}
          command={command}
          prompt={prompt}
          matcher={matcher}
        />
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
          {hook ? 'Update Hook' : 'Create Hook'}
        </button>
      </div>
    </form>
  );
}
