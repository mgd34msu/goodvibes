// ============================================================================
// HOOKS STATE MANAGEMENT HOOK
// ============================================================================

import { useState, useEffect, useCallback } from 'react';
import { createLogger } from '../../../../shared/logger';
import { formatTimestamp } from '../../../../shared/dateUtils';
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
            hookType: hookData.hookType || 'command',
            prompt: hookData.prompt || null,
          });
        }
        await loadHooks();
        return true;
      } catch (error) {
        logger.error('Failed to save hook:', error);
        return false;
      }
    },
    [loadHooks]
  );

  const handleToggle = useCallback(
    async (id: number, enabled: boolean) => {
      try {
        await window.goodvibes.updateHook(id, { enabled });
        await loadHooks();
      } catch (error) {
        logger.error('Failed to toggle hook:', error);
      }
    },
    [loadHooks]
  );

  const handleDelete = useCallback(
    async (id: number) => {
      try {
        await window.goodvibes.deleteHook(id);
        await loadHooks();
      } catch (error) {
        logger.error('Failed to delete hook:', error);
      }
    },
    [loadHooks]
  );

  const handleTest = useCallback(
    async (id: number) => {
      // Find the hook to test
      const hook = hooks.find((h) => h.id === id);
      if (!hook) {
        logger.error('Hook not found:', id);
        return;
      }

      const testingHookName = hook.name;

      try {
        // Log the test execution
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
        await loadHooks();

        // Show success notification
        alert(
          `Hook "${testingHookName}" test triggered.\n\nCommand: ${hook.command}\n\nCheck the activity log for execution details.`
        );
      } catch (error) {
        logger.error('Failed to test hook:', error);
        alert(
          `Failed to test hook "${testingHookName}": ${error instanceof Error ? error.message : 'Unknown error'}`
        );
      }
    },
    [hooks, loadHooks]
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
