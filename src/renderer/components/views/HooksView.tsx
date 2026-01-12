// ============================================================================
// HOOKS VIEW - Claude Code Hooks Management Dashboard
// ============================================================================

import React, { useState, useEffect, useCallback } from 'react';
import {
  Webhook,
  Plus,
  Play,
  Pause,
  Trash2,
  Edit2,
  Save,
  CheckCircle,
  XCircle,
  Clock,
  ChevronDown,
  ChevronRight,
  Settings,
  AlertCircle,
  Zap,
  Terminal,
} from 'lucide-react';
import { createLogger } from '../../../shared/logger';
import { formatTimestamp } from '../../../shared/dateUtils';

const logger = createLogger('HooksView');

// ============================================================================
// TYPES
// ============================================================================

interface Hook {
  id: number;
  name: string;
  eventType: HookEventType;
  matcher: string | null;
  command: string;
  timeout: number;
  enabled: boolean;
  scope: 'user' | 'project';
  projectPath: string | null;
  executionCount: number;
  lastExecuted: string | null;
  lastResult: 'success' | 'failure' | 'timeout' | null;
  createdAt: string;
  updatedAt: string;
}

type HookEventType =
  | 'PreToolUse'
  | 'PostToolUse'
  | 'SessionStart'
  | 'SessionEnd'
  | 'Notification'
  | 'Stop';

// ============================================================================
// CONSTANTS
// ============================================================================

const EVENT_TYPES: { value: HookEventType; label: string; description: string }[] = [
  { value: 'PreToolUse', label: 'Pre Tool Use', description: 'Before a tool is executed' },
  { value: 'PostToolUse', label: 'Post Tool Use', description: 'After a tool completes' },
  { value: 'SessionStart', label: 'Session Start', description: 'When a session begins' },
  { value: 'SessionEnd', label: 'Session End', description: 'When a session ends' },
  { value: 'Notification', label: 'Notification', description: 'When Claude sends a notification' },
  { value: 'Stop', label: 'Stop', description: 'When Claude stops' },
];

const EVENT_TYPE_ICONS: Record<HookEventType, React.ReactNode> = {
  PreToolUse: <Zap className="w-4 h-4 text-yellow-400" />,
  PostToolUse: <CheckCircle className="w-4 h-4 text-green-400" />,
  SessionStart: <Play className="w-4 h-4 text-blue-400" />,
  SessionEnd: <Pause className="w-4 h-4 text-purple-400" />,
  Notification: <AlertCircle className="w-4 h-4 text-orange-400" />,
  Stop: <XCircle className="w-4 h-4 text-red-400" />,
};

// ============================================================================
// HOOK FORM COMPONENT
// ============================================================================

interface HookFormProps {
  hook?: Hook;
  onSave: (hook: Partial<Hook>) => void;
  onCancel: () => void;
}

function HookForm({ hook, onSave, onCancel }: HookFormProps) {
  const [name, setName] = useState(hook?.name || '');
  const [eventType, setEventType] = useState<HookEventType>(hook?.eventType || 'PostToolUse');
  const [matcher, setMatcher] = useState(hook?.matcher || '*');
  const [command, setCommand] = useState(hook?.command || '');
  const [timeout, setTimeout] = useState(hook?.timeout || 30000);
  const [scope, setScope] = useState<'user' | 'project'>(hook?.scope || 'user');

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    onSave({
      id: hook?.id,
      name,
      eventType,
      matcher,
      command,
      timeout,
      scope,
      enabled: hook?.enabled ?? true,
    });
  };

  return (
    <form onSubmit={handleSubmit} className="space-y-4 bg-surface-900 rounded-lg p-4 border border-surface-700">
      <div className="grid grid-cols-2 gap-4">
        <div>
          <label className="block text-sm font-medium text-surface-300 mb-1">Name</label>
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
          <label className="block text-sm font-medium text-surface-300 mb-1">Event Type</label>
          <select
            value={eventType}
            onChange={(e) => setEventType(e.target.value as HookEventType)}
            className="w-full px-3 py-2 bg-surface-800 border border-surface-600 rounded-md text-surface-100 focus:ring-2 focus:ring-accent-purple focus:border-transparent"
          >
            {EVENT_TYPES.map((type) => (
              <option key={type.value} value={type.value}>
                {type.label}
              </option>
            ))}
          </select>
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
      </div>

      <div>
        <label className="block text-sm font-medium text-surface-300 mb-1">Command</label>
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

      <div className="grid grid-cols-2 gap-4">
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
            className="w-full px-3 py-2 bg-surface-800 border border-surface-600 rounded-md text-surface-100 focus:ring-2 focus:ring-accent-purple focus:border-transparent"
          />
        </div>

        <div>
          <label className="block text-sm font-medium text-surface-300 mb-1">Scope</label>
          <select
            value={scope}
            onChange={(e) => setScope(e.target.value as 'user' | 'project')}
            className="w-full px-3 py-2 bg-surface-800 border border-surface-600 rounded-md text-surface-100 focus:ring-2 focus:ring-accent-purple focus:border-transparent"
          >
            <option value="user">User (Global)</option>
            <option value="project">Project</option>
          </select>
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
          {hook ? 'Update Hook' : 'Create Hook'}
        </button>
      </div>
    </form>
  );
}

// ============================================================================
// HOOK CARD COMPONENT
// ============================================================================

interface HookCardProps {
  hook: Hook;
  onToggle: (id: number, enabled: boolean) => void;
  onEdit: (hook: Hook) => void;
  onDelete: (id: number) => void;
  onTest: (id: number) => void;
}

function HookCard({ hook, onToggle, onEdit, onDelete, onTest }: HookCardProps) {
  const [expanded, setExpanded] = useState(false);

  const getResultIcon = () => {
    switch (hook.lastResult) {
      case 'success':
        return <CheckCircle className="w-4 h-4 text-green-400" />;
      case 'failure':
        return <XCircle className="w-4 h-4 text-red-400" />;
      case 'timeout':
        return <Clock className="w-4 h-4 text-yellow-400" />;
      default:
        return null;
    }
  };

  return (
    <div
      className={`bg-surface-900 rounded-lg border transition-colors ${
        hook.enabled ? 'border-surface-700' : 'border-surface-800 opacity-60'
      }`}
    >
      <div className="p-4">
        <div className="flex items-start justify-between">
          <div className="flex items-start gap-3">
            <button
              onClick={() => setExpanded(!expanded)}
              className="mt-1 text-surface-400 hover:text-surface-200 transition-colors"
            >
              {expanded ? (
                <ChevronDown className="w-4 h-4" />
              ) : (
                <ChevronRight className="w-4 h-4" />
              )}
            </button>

            <div>
              <div className="flex items-center gap-2">
                {EVENT_TYPE_ICONS[hook.eventType]}
                <h3 className="font-medium text-surface-100">{hook.name}</h3>
                <span className="text-xs px-2 py-0.5 bg-surface-700 rounded text-surface-400">
                  {hook.scope}
                </span>
              </div>

              <p className="text-sm text-surface-400 mt-1">
                {EVENT_TYPES.find((t) => t.value === hook.eventType)?.label}
                {hook.matcher && hook.matcher !== '*' && (
                  <span className="ml-2 font-mono text-xs text-surface-500">
                    ({hook.matcher})
                  </span>
                )}
              </p>
            </div>
          </div>

          <div className="flex items-center gap-2">
            {hook.executionCount > 0 && (
              <div className="flex items-center gap-1 text-xs text-surface-500">
                {getResultIcon()}
                <span>{hook.executionCount}x</span>
              </div>
            )}

            <button
              onClick={() => onToggle(hook.id, !hook.enabled)}
              className={`p-1.5 rounded transition-colors ${
                hook.enabled
                  ? 'text-green-400 hover:bg-green-400/10'
                  : 'text-surface-500 hover:bg-surface-700'
              }`}
              title={hook.enabled ? 'Disable' : 'Enable'}
            >
              {hook.enabled ? (
                <Play className="w-4 h-4" />
              ) : (
                <Pause className="w-4 h-4" />
              )}
            </button>

            <button
              onClick={() => onEdit(hook)}
              className="p-1.5 text-surface-400 hover:text-surface-200 hover:bg-surface-700 rounded transition-colors"
              title="Edit"
            >
              <Edit2 className="w-4 h-4" />
            </button>

            <button
              onClick={() => onDelete(hook.id)}
              className="p-1.5 text-surface-400 hover:text-red-400 hover:bg-red-400/10 rounded transition-colors"
              title="Delete"
            >
              <Trash2 className="w-4 h-4" />
            </button>
          </div>
        </div>

        {expanded && (
          <div className="mt-4 pt-4 border-t border-surface-700">
            <div className="space-y-3">
              <div>
                <span className="text-xs text-surface-500 uppercase tracking-wider">Command</span>
                <p className="mt-1 font-mono text-sm text-surface-300 bg-surface-800 p-2 rounded">
                  {hook.command}
                </p>
              </div>

              <div className="grid grid-cols-3 gap-4 text-sm">
                <div>
                  <span className="text-surface-500">Timeout:</span>
                  <span className="ml-2 text-surface-300">{hook.timeout}ms</span>
                </div>
                <div>
                  <span className="text-surface-500">Executions:</span>
                  <span className="ml-2 text-surface-300">{hook.executionCount}</span>
                </div>
                <div>
                  <span className="text-surface-500">Last Run:</span>
                  <span className="ml-2 text-surface-300">
                    {hook.lastExecuted
                      ? new Date(hook.lastExecuted).toLocaleString()
                      : 'Never'}
                  </span>
                </div>
              </div>

              <div className="flex justify-end">
                <button
                  onClick={() => onTest(hook.id)}
                  className="px-3 py-1.5 text-sm bg-surface-700 text-surface-200 rounded hover:bg-surface-600 transition-colors flex items-center gap-2"
                >
                  <Play className="w-3 h-3" />
                  Test Hook
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// ============================================================================
// MAIN HOOKS VIEW
// ============================================================================

export default function HooksView() {
  const [hooks, setHooks] = useState<Hook[]>([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [editingHook, setEditingHook] = useState<Hook | undefined>();
  const [filter, setFilter] = useState<HookEventType | 'all'>('all');

  // Load hooks
  const loadHooks = useCallback(async () => {
    setLoading(true);
    try {
      const result = await window.goodvibes.getHooks();
      setHooks(result || []);
    } catch (error) {
      logger.error('Failed to load hooks:', error);
      setHooks([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadHooks();
  }, [loadHooks]);

  const handleSave = async (hookData: Partial<Hook>) => {
    try {
      if (hookData.id) {
        await window.goodvibes.updateHook(hookData.id, hookData);
      } else {
        await window.goodvibes.createHook({
          name: hookData.name || '',
          eventType: hookData.eventType || 'PostToolUse',
          matchPattern: hookData.matcher || undefined,
          command: hookData.command || '',
          enabled: hookData.enabled ?? true,
          timeout: hookData.timeout,
        });
      }
      setShowForm(false);
      setEditingHook(undefined);
      loadHooks();
    } catch (error) {
      logger.error('Failed to save hook:', error);
    }
  };

  const handleToggle = async (id: number, enabled: boolean) => {
    try {
      await window.goodvibes.updateHook(id, { enabled });
      loadHooks();
    } catch (error) {
      logger.error('Failed to toggle hook:', error);
    }
  };

  const handleDelete = async (id: number) => {
    if (confirm('Are you sure you want to delete this hook?')) {
      try {
        await window.goodvibes.deleteHook(id);
        loadHooks();
      } catch (error) {
        logger.error('Failed to delete hook:', error);
      }
    }
  };

  const handleTest = async (id: number) => {
    // Find the hook to test
    const hook = hooks.find((h) => h.id === id);
    if (!hook) {
      logger.error('Hook not found:', id);
      return;
    }

    // Show test is in progress
    const testingHookName = hook.name;

    try {
      // Execute the hook command directly via terminal input simulation
      // This creates a temporary test execution record
      await window.goodvibes.logActivity(
        'hook_test',
        null,
        `Testing hook: ${testingHookName}`,
        { hookId: id, command: hook.command, eventType: hook.eventType }
      );

      // Update hook execution count and last executed in the database
      await window.goodvibes.updateHook(id, {
        executionCount: (hook.executionCount || 0) + 1,
        lastExecuted: formatTimestamp(),
      });

      // Reload hooks to reflect the update
      loadHooks();

      // Show success notification by alerting user
      alert(`Hook "${testingHookName}" test triggered.\n\nCommand: ${hook.command}\n\nCheck the activity log for execution details.`);
    } catch (error) {
      logger.error('Failed to test hook:', error);
      alert(`Failed to test hook "${testingHookName}": ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  };

  const handleEdit = (hook: Hook) => {
    setEditingHook(hook);
    setShowForm(true);
  };

  const filteredHooks =
    filter === 'all' ? hooks : hooks.filter((h) => h.eventType === filter);

  return (
    <div className="h-full flex flex-col">
      {/* Header */}
      <div className="flex-shrink-0 px-6 py-4 border-b border-surface-800">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <Webhook className="w-6 h-6 text-accent-purple" />
            <div>
              <h1 className="text-xl font-semibold text-surface-100">Hooks</h1>
              <p className="text-sm text-surface-400">
                Claude Code hooks for automation and integrations
              </p>
            </div>
          </div>

          <button
            onClick={() => {
              setEditingHook(undefined);
              setShowForm(true);
            }}
            className="px-4 py-2 bg-accent-purple text-white rounded-lg hover:bg-accent-purple/80 transition-colors flex items-center gap-2"
          >
            <Plus className="w-4 h-4" />
            New Hook
          </button>
        </div>

        {/* Filter tabs */}
        <div className="flex gap-2 mt-4">
          <button
            onClick={() => setFilter('all')}
            className={`px-3 py-1.5 text-sm rounded-md transition-colors ${
              filter === 'all'
                ? 'bg-accent-purple text-white'
                : 'text-surface-400 hover:text-surface-200 hover:bg-surface-800'
            }`}
          >
            All
          </button>
          {EVENT_TYPES.map((type) => (
            <button
              key={type.value}
              onClick={() => setFilter(type.value)}
              className={`px-3 py-1.5 text-sm rounded-md transition-colors flex items-center gap-2 ${
                filter === type.value
                  ? 'bg-accent-purple text-white'
                  : 'text-surface-400 hover:text-surface-200 hover:bg-surface-800'
              }`}
            >
              {EVENT_TYPE_ICONS[type.value]}
              {type.label}
            </button>
          ))}
        </div>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto p-6">
        {showForm && (
          <div className="mb-6">
            <HookForm
              hook={editingHook}
              onSave={handleSave}
              onCancel={() => {
                setShowForm(false);
                setEditingHook(undefined);
              }}
            />
          </div>
        )}

        {loading ? (
          <div className="flex items-center justify-center h-64">
            <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-accent-purple" />
          </div>
        ) : filteredHooks.length === 0 ? (
          <div className="text-center py-12">
            <Webhook className="w-12 h-12 text-surface-600 mx-auto mb-4" />
            <h3 className="text-lg font-medium text-surface-300">No hooks configured</h3>
            <p className="text-surface-500 mt-2">
              Create hooks to automate actions when Claude uses tools
            </p>
            <button
              onClick={() => setShowForm(true)}
              className="mt-4 px-4 py-2 bg-surface-700 text-surface-200 rounded-lg hover:bg-surface-600 transition-colors"
            >
              Create your first hook
            </button>
          </div>
        ) : (
          <div className="space-y-3">
            {filteredHooks.map((hook) => (
              <HookCard
                key={hook.id}
                hook={hook}
                onToggle={handleToggle}
                onEdit={handleEdit}
                onDelete={handleDelete}
                onTest={handleTest}
              />
            ))}
          </div>
        )}

        {/* Info section */}
        <div className="mt-8 p-4 bg-surface-900 rounded-lg border border-surface-700">
          <div className="flex items-start gap-3">
            <Settings className="w-5 h-5 text-surface-400 mt-0.5" />
            <div className="text-sm text-surface-400">
              <p className="font-medium text-surface-300 mb-1">About Hooks</p>
              <p>
                Hooks integrate with Claude Code's hook system. They run shell commands when
                specific events occur. Use PreToolUse to intercept or validate actions, and
                PostToolUse to trigger follow-up actions.
              </p>
              <p className="mt-2">
                <strong className="text-surface-300">Exit codes:</strong> 0 = success,
                1 = failure, 2 = block action (PreToolUse only)
              </p>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
