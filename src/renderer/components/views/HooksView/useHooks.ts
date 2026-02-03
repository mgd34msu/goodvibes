// ============================================================================
// HOOKS STATE MANAGEMENT HOOK
// ============================================================================

import { useState, useEffect, useCallback } from 'react';
import { createLogger } from '../../../../shared/logger';
import { formatTimestamp } from '../../../../shared/dateUtils';
import { toast } from '../../../stores/toastStore';
import type { Hook, HookEventType } from './types';
import type { BuiltinHook } from './builtinHooks';

const logger = createLogger('HooksView');

interface UseHooksReturn {
  hooks: Hook[];
  loading: boolean;
  loadHooks: () => Promise<void>;
  handleSave: (hookData: Partial<Hook>) => Promise<boolean>;
  handleToggle: (id: number, enabled: boolean) => Promise<void>;
  handleDelete: (id: number) => Promise<void>;
  handleTest: (id: number) => Promise<void>;
}

export function useHooks(): UseHooksReturn {
  const [hooks, setHooks] = useState<Hook[]>([]);
  const [loading, setLoading] = useState(true);

  // Load hooks
  const loadHooks = useCallback(async () => {
    setLoading(true);
    try {
      const result = await window.goodvibes.getHooks();
      setHooks(result || []);
    } catch (error) {
      logger.error('Failed to load hooks:', error);
      toast.error('Failed to load hooks');
      setHooks([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadHooks();
  }, [loadHooks]);

  const handleSave = useCallback(
    async (hookData: Partial<Hook>): Promise<boolean> => {
      const isUpdate = Boolean(hookData.id);
      const hookName = hookData.name || 'hook';

      try {
        if (hookData.id) {
          // Optimistic update for existing hook
          setHooks((prev) =>
            prev.map((h) => (h.id === hookData.id ? { ...h, ...hookData } : h))
          );
          await window.goodvibes.updateHook(hookData.id, hookData);
          toast.success(`Updated ${hookName}`);
        } else {
          // For create, we need to reload to get the server-assigned ID
          await window.goodvibes.createHook({
            name: hookData.name || '',
            eventType: hookData.eventType || 'PostToolUse',
            command: hookData.command || '',
            enabled: hookData.enabled ?? true,
            timeout: hookData.timeout,
            projectPath: hookData.projectPath || undefined,
          });
          await loadHooks();
          toast.success(`Created ${hookName}`);
        }
        return true;
      } catch (error) {
        if (isUpdate && hookData.id) {
          // Revert optimistic update on failure
          await loadHooks();
        }
        logger.error('Failed to save hook:', error);
        toast.error(isUpdate ? 'Failed to update hook' : 'Failed to create hook');
        return false;
      }
    },
    [loadHooks]
  );

  const handleToggle = useCallback(
    async (id: number, enabled: boolean) => {
      // Optimistic update - update local state immediately
      setHooks((prev) =>
        prev.map((h) => (h.id === id ? { ...h, enabled } : h))
      );

      try {
        await window.goodvibes.updateHook(id, { enabled });
        toast.success(enabled ? 'Hook enabled' : 'Hook disabled');
      } catch (error) {
        // Revert on failure
        setHooks((prev) =>
          prev.map((h) => (h.id === id ? { ...h, enabled: !enabled } : h))
        );
        logger.error('Failed to toggle hook:', error);
        toast.error('Failed to toggle hook');
      }
    },
    []
  );

  const handleDelete = useCallback(
    async (id: number) => {
      // Find the hook before removing
      const hook = hooks.find((h) => h.id === id);
      if (!hook) {
        throw new Error('Hook not found');
      }

      // Optimistic removal - remove from state immediately
      setHooks((prev) => prev.filter((h) => h.id !== id));

      try {
        // Delete from database
        await window.goodvibes.deleteHook(id);

        // Uninstall from .claude/hooks/ directory and remove from settings.json
        try {
          await window.goodvibes.uninstallHook({
            name: hook.name,
            eventType: hook.eventType,
            scope: hook.scope,
            projectPath: hook.projectPath || undefined,
          });
        } catch (uninstallError) {
          // Log error but don't fail the entire operation if file doesn't exist
          logger.warn('Failed to uninstall hook file (may not exist)', { error: uninstallError });
        }

        toast.success('Hook deleted');
      } catch (error) {
        // Revert on failure - add the hook back
        setHooks((prev) => [...prev, hook]);
        logger.error('Failed to delete hook:', error);
        toast.error('Failed to delete hook');
      }
    },
    [hooks]
  );

  const handleTest = useCallback(
    async (id: number) => {
      const hook = hooks.find((h) => h.id === id);
      if (!hook) {
        logger.error('Hook not found:', id);
        toast.error('Hook not found');
        return;
      }

      const testingHookName = hook.name;
      const newExecutionCount = (hook.executionCount || 0) + 1;
      const newLastExecuted = formatTimestamp();

      // Optimistic update - update execution stats immediately
      setHooks((prev) =>
        prev.map((h) =>
          h.id === id
            ? { ...h, executionCount: newExecutionCount, lastExecuted: newLastExecuted }
            : h
        )
      );

      try {
        await window.goodvibes.logActivity(
          'hook_test',
          null,
          `Testing hook: ${testingHookName}`,
          { hookId: id, command: hook.command, eventType: hook.eventType }
        );

        await window.goodvibes.updateHook(id, {
          executionCount: newExecutionCount,
          lastExecuted: newLastExecuted,
        });

        toast.success(`Hook "${testingHookName}" test triggered`, {
          title: 'Test Successful',
        });
      } catch (error) {
        // Revert on failure
        setHooks((prev) =>
          prev.map((h) =>
            h.id === id
              ? { ...h, executionCount: hook.executionCount, lastExecuted: hook.lastExecuted }
              : h
          )
        );
        logger.error('Failed to test hook:', error);
        toast.error(`Failed to test hook "${testingHookName}"`);
      }
    },
    [hooks]
  );

  return {
    hooks,
    loading,
    loadHooks,
    handleSave,
    handleToggle,
    handleDelete,
    handleTest,
  };
}

export interface UseHookFiltersReturn {
  filter: HookEventType | 'all';
  setFilter: (filter: HookEventType | 'all') => void;
  filteredHooks: Hook[];
}

// Filter hooks utility
export function useHookFilters(hooks: Hook[]): UseHookFiltersReturn {
  const [filter, setFilter] = useState<HookEventType | 'all'>('all');

  const filteredHooks = filter === 'all' ? hooks : hooks.filter((h) => h.eventType === filter);

  return {
    filter,
    setFilter,
    filteredHooks,
  };
}

// Filter hooks with built-in support
export function useHookFiltersWithBuiltIn(
  hooks: Hook[],
  builtInHooks: BuiltinHook[]
) {
  const [filter, setFilter] = useState<HookEventType | 'all'>('all');
  const [categoryFilter, setCategoryFilter] = useState<BuiltinHook['category'] | 'all'>('all');
  const [searchQuery, setSearchQuery] = useState('');
  const [showBuiltIn, setShowBuiltIn] = useState(true);

  // Filter custom hooks by event type and search
  const filteredHooks = hooks.filter((h) => {
    const matchesEventType = filter === 'all' || h.eventType === filter;
    const matchesSearch =
      !searchQuery ||
      h.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
      h.command.toLowerCase().includes(searchQuery.toLowerCase());
    return matchesEventType && matchesSearch;
  });

  // Filter built-in hooks by event type, category, and search
  const filteredBuiltIn = builtInHooks.filter((h) => {
    const matchesEventType = filter === 'all' || h.eventType === filter;
    const matchesCategory = categoryFilter === 'all' || h.category === categoryFilter;
    const matchesSearch =
      !searchQuery ||
      h.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
      h.description.toLowerCase().includes(searchQuery.toLowerCase()) ||
      h.tags.some((tag) => tag.toLowerCase().includes(searchQuery.toLowerCase()));
    return matchesEventType && matchesCategory && matchesSearch;
  });

  return {
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
  };
}
