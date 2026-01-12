// ============================================================================
// HOOKS VIEW - Claude Code Hooks Management Dashboard
// ============================================================================

import { useState, useCallback } from 'react';
import { Webhook, Plus, Settings } from 'lucide-react';
import { useConfirm } from '../../overlays/ConfirmModal';
import { HookForm } from './HookForm';
import { HookCard } from './HookCard';
import { useHooks, useHookFilters } from './useHooks';
import { EVENT_TYPES, EVENT_TYPE_ICONS, type Hook } from './types';

// ============================================================================
// MAIN HOOKS VIEW
// ============================================================================

export default function HooksView() {
  const [showForm, setShowForm] = useState(false);
  const [editingHook, setEditingHook] = useState<Hook | undefined>();

  const { confirm: confirmDeleteHook, ConfirmDialog: DeleteHookDialog } = useConfirm({
    title: 'Delete Hook',
    message: 'Are you sure you want to delete this hook?',
    confirmText: 'Delete',
    variant: 'danger',
  });

  const { hooks, loading, handleSave, handleToggle, handleDelete, handleTest } = useHooks();
  const { filter, setFilter, filteredHooks } = useHookFilters(hooks);

  const onSave = async (hookData: Partial<Hook>) => {
    const success = await handleSave(hookData);
    if (success) {
      setShowForm(false);
      setEditingHook(undefined);
    }
  };

  const onDelete = useCallback(
    async (id: number) => {
      const confirmed = await confirmDeleteHook();
      if (confirmed) {
        await handleDelete(id);
      }
    },
    [confirmDeleteHook, handleDelete]
  );

  const handleEdit = (hook: Hook) => {
    setEditingHook(hook);
    setShowForm(true);
  };

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
              onSave={onSave}
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
                onDelete={onDelete}
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
                <strong className="text-surface-300">Exit codes:</strong> 0 = success, 1 =
                failure, 2 = block action (PreToolUse only)
              </p>
            </div>
          </div>
        </div>
      </div>
      <DeleteHookDialog />
    </div>
  );
}

// Re-export types for convenience
export type { Hook, HookEventType } from './types';
