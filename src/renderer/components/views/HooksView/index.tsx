// ============================================================================
// HOOKS VIEW - Claude Code Hooks Management Dashboard
// ============================================================================

import { useState, useCallback } from 'react';
import { Webhook, Plus, Settings, Search } from 'lucide-react';
import { createLogger } from '../../../../shared/logger';

const logger = createLogger('HooksView');
import { useConfirm } from '../../overlays/ConfirmModal';
import { HookForm } from './HookForm';
import { HookCard } from './HookCard';
import { BuiltinHookCard } from './BuiltinHookCard';
import { InstallHookModal } from './InstallHookModal';
import { useHooks, useHookFiltersWithBuiltIn } from './useHooks';
import { EVENT_TYPES, EVENT_TYPE_ICONS, type Hook } from './types';
import { BUILT_IN_HOOKS, CATEGORY_COLORS, CATEGORY_LABELS, type BuiltinHook } from './builtinHooks';

// ============================================================================
// MAIN HOOKS VIEW
// ============================================================================

export default function HooksView() {
  const [showForm, setShowForm] = useState(false);
  const [editingHook, setEditingHook] = useState<Hook | undefined>();
  const [hookToInstall, setHookToInstall] = useState<BuiltinHook | null>(null);

  const { confirm: confirmDeleteHook, ConfirmDialog: DeleteHookDialog } = useConfirm({
    title: 'Delete Hook',
    message: 'Are you sure you want to delete this hook?',
    confirmText: 'Delete',
    variant: 'danger',
  });

  const { hooks, loading, handleSave, handleDelete } = useHooks();
  const {
    filter,
    setFilter,
    categoryFilter,
    setCategoryFilter,
    searchQuery,
    setSearchQuery,
    showBuiltIn,
    setShowBuiltIn,
    filteredHooks,
    filteredBuiltIn,
  } = useHookFiltersWithBuiltIn(hooks, BUILT_IN_HOOKS);

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

  // Open install modal for built-in hook
  const handleOpenInstallModal = useCallback((builtinHook: BuiltinHook) => {
    setHookToInstall(builtinHook);
  }, []);

  // Install a built-in hook with selected scope and project
  const handleInstallBuiltIn = useCallback(
    async (builtinHook: BuiltinHook, scope: 'user' | 'project', projectPath: string | null) => {
      try {
        // Install hook to .claude/hooks/ directory and update settings.json
        await window.goodvibes.installHook({
          name: builtinHook.name,
          script: builtinHook.command,
          eventType: builtinHook.eventType,
          matcher: builtinHook.matcher || undefined,
          scope,
          projectPath: projectPath || undefined,
        });

        // Also save to database for UI display
        const hookData: Partial<Hook> = {
          name: builtinHook.name,
          eventType: builtinHook.eventType,
          matcher: builtinHook.matcher,
          command: builtinHook.command,
          hookType: builtinHook.hookType,
          prompt: builtinHook.prompt,
          timeout: builtinHook.timeout,
          scope,
          projectPath,
          enabled: true,
        };
        await handleSave(hookData);
        setHookToInstall(null);
      } catch (error) {
        logger.error('Failed to install hook:', error);
      }
    },
    [handleSave]
  );

  const hasNoResults =
    filteredHooks.length === 0 && (!showBuiltIn || filteredBuiltIn.length === 0);

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

        {/* Search and filters */}
        <div className="flex gap-4 mt-4">
          <div className="flex-1 relative">
            <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 w-4 h-4 text-surface-500" />
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Search hooks..."
              className="w-full pl-10 pr-3 py-2 bg-surface-800 border border-surface-600 rounded-lg text-surface-100 focus:ring-2 focus:ring-accent-purple focus:border-transparent"
            />
          </div>
          <button
            onClick={() => setShowBuiltIn(!showBuiltIn)}
            className={`px-3 py-2 text-sm rounded-lg transition-colors ${
              showBuiltIn
                ? 'bg-surface-700 text-surface-200'
                : 'text-surface-400 hover:text-surface-200 hover:bg-surface-800'
            }`}
          >
            {showBuiltIn ? 'Hide Built-in' : 'Show Built-in'}
          </button>
        </div>

        {/* Event type filter tabs */}
        <div className="flex gap-1.5 mt-4 overflow-x-auto pb-1">
          <button
            onClick={() => setFilter('all')}
            className={`px-1 py-1.5 text-sm rounded-md transition-colors whitespace-nowrap ${
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
              className={`px-1 py-1.5 text-sm rounded-md transition-colors flex items-center gap-1 whitespace-nowrap ${
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

        {/* Category filter (only shown when built-in hooks are visible) */}
        {showBuiltIn && (
          <div className="flex gap-2 mt-3">
            <span className="text-xs text-surface-500 self-center mr-1">Category:</span>
            <button
              onClick={() => setCategoryFilter('all')}
              className={`px-2 py-1 text-xs rounded transition-colors ${
                categoryFilter === 'all'
                  ? 'bg-surface-700 text-surface-200'
                  : 'text-surface-400 hover:text-surface-200 hover:bg-surface-800'
              }`}
            >
              All
            </button>
            {(Object.keys(CATEGORY_LABELS) as BuiltinHook['category'][]).map((cat) => (
              <button
                key={cat}
                onClick={() => setCategoryFilter(cat)}
                className={`px-2 py-1 text-xs rounded border transition-colors ${
                  categoryFilter === cat
                    ? CATEGORY_COLORS[cat]
                    : 'text-surface-400 hover:text-surface-200 border-transparent hover:bg-surface-800'
                }`}
              >
                {CATEGORY_LABELS[cat]}
              </button>
            ))}
          </div>
        )}
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
        ) : hasNoResults ? (
          <div className="text-center py-12">
            <Webhook className="w-12 h-12 text-surface-600 mx-auto mb-4" />
            <h3 className="text-lg font-medium text-surface-300">
              {searchQuery ? 'No hooks match your search' : 'No hooks configured'}
            </h3>
            <p className="text-surface-500 mt-2">
              {searchQuery
                ? 'Try a different search term or show built-in hooks'
                : 'Create hooks to automate actions when Claude uses tools'}
            </p>
            {!searchQuery && (
              <button
                onClick={() => setShowForm(true)}
                className="mt-4 px-4 py-2 bg-surface-700 text-surface-200 rounded-lg hover:bg-surface-600 transition-colors"
              >
                Create your first hook
              </button>
            )}
          </div>
        ) : (
          <div className="space-y-6">
            {/* Custom Hooks */}
            {filteredHooks.length > 0 && (
              <div>
                <h2 className="text-sm font-medium text-surface-400 mb-3">
                  My Hooks ({filteredHooks.length})
                </h2>
                <div className="space-y-3">
                  {filteredHooks.map((hook) => (
                    <HookCard
                      key={hook.id}
                      hook={hook}
                      onDelete={onDelete}
                    />
                  ))}
                </div>
              </div>
            )}

            {/* Built-in Hooks */}
            {showBuiltIn && filteredBuiltIn.length > 0 && (
              <div>
                <h2 className="text-sm font-medium text-surface-400 mb-3">
                  Built-in Hooks ({filteredBuiltIn.length})
                </h2>
                <div className="space-y-3">
                  {filteredBuiltIn.map((hook) => (
                    <BuiltinHookCard
                      key={hook.id}
                      hook={hook}
                      onInstall={handleOpenInstallModal}
                      isInstalled={hooks.some((h) => h.name === hook.name)}
                    />
                  ))}
                </div>
              </div>
            )}
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
              <p className="mt-2">
                <strong className="text-surface-300">Built-in hooks:</strong> Browse the library
                of pre-made hooks and click "Install" to add them to your configuration.
              </p>
            </div>
          </div>
        </div>
      </div>
      <DeleteHookDialog />

      {/* Install Hook Modal */}
      {hookToInstall && (
        <InstallHookModal
          hook={hookToInstall}
          isOpen={hookToInstall !== null}
          onClose={() => setHookToInstall(null)}
          onInstall={handleInstallBuiltIn}
        />
      )}
    </div>
  );
}

// Re-export types for convenience
export type { Hook, HookEventType } from './types';
export type { BuiltinHook } from './builtinHooks';
