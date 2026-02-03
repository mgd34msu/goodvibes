// ============================================================================
// PLUGINS VIEW - Plugin Management Dashboard
// ============================================================================

import { useState, useMemo, useEffect, useCallback } from 'react';
import {
  Puzzle,
  Search,
  GitBranch,
} from 'lucide-react';
import { createLogger } from '../../../../shared/logger';
import { toast } from '../../../stores/toastStore';
import { useConfirm } from '../../overlays/ConfirmModal';
import { PluginCard } from './PluginCard';
import { BUILT_IN_PLUGINS, CATEGORY_FILTERS } from './constants';
import type { Plugin } from './types';
import { RepoInstallModal, type ParsedRepoInfo } from '../../common/RepoInstallModal';

const logger = createLogger('PluginsView');

// ============================================================================
// MAIN PLUGINS VIEW
// ============================================================================

export default function PluginsView() {
  const [activeTab, setActiveTab] = useState<'installed' | 'marketplace'>('installed');
  const [searchQuery, setSearchQuery] = useState('');
  const [categoryFilter, setCategoryFilter] = useState<string>('all');
  const [installedPlugins, setInstalledPlugins] = useState<Plugin[]>([]);
  const [loading, setLoading] = useState(true);
  const [uninstallingId, setUninstallingId] = useState<string | null>(null);
  const [installingId, setInstallingId] = useState<string | null>(null);
  const [togglingId, setTogglingId] = useState<string | null>(null);
  const [showRepoInstallModal, setShowRepoInstallModal] = useState(false);
  const [isInstallingFromRepo, setIsInstallingFromRepo] = useState(false);

  const { confirm: confirmUninstall, ConfirmDialog } = useConfirm({
    title: 'Uninstall Plugin',
    message: 'Are you sure you want to uninstall this plugin?',
    confirmText: 'Uninstall',
    cancelText: 'Cancel',
    variant: 'danger',
  });

  const installedPluginIds = useMemo(() => {
    return new Set(installedPlugins.map(p => p.id));
  }, [installedPlugins]);

  const filteredMarketplace = useMemo(() => {
    return BUILT_IN_PLUGINS.filter((plugin) => {
      const matchesSearch =
        !searchQuery ||
        plugin.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
        plugin.description.toLowerCase().includes(searchQuery.toLowerCase());

      const matchesCategory = categoryFilter === 'all' || plugin.category === categoryFilter;

      return matchesSearch && matchesCategory;
    });
  }, [searchQuery, categoryFilter]);

  const loadInstalledPlugins = useCallback(async () => {
    setLoading(true);
    try {
      const response = await window.goodvibes.getInstalledPlugins();
      if (!response.success) {
        throw new Error(response.error || 'Failed to load plugins');
      }
      setInstalledPlugins(response.plugins || []);
    } catch (error) {
      logger.error('Failed to load plugins:', error);
      toast.error('Failed to load plugins');
      setInstalledPlugins([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadInstalledPlugins();
  }, [loadInstalledPlugins]);

  const handleInstall = useCallback(async (plugin: Plugin) => {
    if (!plugin.repository) {
      toast.error('Plugin repository URL is missing');
      return;
    }

    setInstallingId(plugin.id);
    try {
      const response = await window.goodvibes.installPlugin({
        repository: plugin.repository,
        scope: 'user',
      });
      if (!response.success) {
        throw new Error(response.error || 'Installation failed');
      }
      await loadInstalledPlugins();
      toast.success(`Installed ${plugin.name}`);
    } catch (error) {
      logger.error('Failed to install plugin:', error);
      toast.error(`Failed to install ${plugin.name}`);
    } finally {
      setInstallingId(null);
    }
  }, [loadInstalledPlugins]);

  const handleToggle = useCallback(async (plugin: Plugin) => {
    const newEnabledState = !plugin.enabled;
    setTogglingId(plugin.id);

    // Optimistic update - update local state immediately
    setInstalledPlugins(prev =>
      prev.map(p => p.id === plugin.id ? { ...p, enabled: newEnabledState } : p)
    );

    try {
      const response = await window.goodvibes.enablePlugin({
        pluginId: plugin.id,
        enabled: newEnabledState,
      });
      if (!response.success) {
        // Revert on failure
        setInstalledPlugins(prev =>
          prev.map(p => p.id === plugin.id ? { ...p, enabled: !newEnabledState } : p)
        );
        throw new Error(response.error || 'Failed to toggle plugin');
      }
      toast.success(`${newEnabledState ? 'Enabled' : 'Disabled'} ${plugin.name}`);
    } catch (error) {
      logger.error('Failed to toggle plugin:', error);
      toast.error('Failed to toggle plugin');
    } finally {
      setTogglingId(null);
    }
  }, []);

  const handleUninstall = useCallback(async (plugin: Plugin) => {
    const confirmed = await confirmUninstall();
    if (!confirmed) return;

    setUninstallingId(plugin.id);
    try {
      const response = await window.goodvibes.uninstallPlugin({
        pluginId: plugin.id,
        scope: 'user',
      });
      if (!response.success) {
        throw new Error(response.error || 'Failed to uninstall plugin');
      }
      // Optimistic removal - remove from local state
      setInstalledPlugins(prev => prev.filter(p => p.id !== plugin.id));
      toast.success(`Uninstalled ${plugin.name}`);
    } catch (error) {
      logger.error('Failed to uninstall plugin:', error);
      toast.error(`Failed to uninstall ${plugin.name}`);
    } finally {
      setUninstallingId(null);
    }
  }, [confirmUninstall]);

  const handleInstallFromRepo = useCallback(async (repoUrl: string, repoInfo: ParsedRepoInfo) => {
    setIsInstallingFromRepo(true);
    try {
      const response = await window.goodvibes.installPlugin({
        repository: repoUrl,
        scope: 'user',
      });
      if (!response.success) {
        throw new Error(response.error || 'Installation failed');
      }
      await loadInstalledPlugins();
      toast.success(`Installed ${repoInfo.repo} from repository`);
      setShowRepoInstallModal(false);
      setActiveTab('installed');
    } catch (error) {
      logger.error('Failed to install plugin from repository:', error);
      toast.error(`Failed to install ${repoInfo.repo}`);
      throw error;
    } finally {
      setIsInstallingFromRepo(false);
    }
  }, [loadInstalledPlugins]);

  return (
    <>
    <ConfirmDialog />
    {showRepoInstallModal && (
      <RepoInstallModal
        title="Install Plugin from Repository"
        description="Install a Claude Code plugin directly from a GitHub repository"
        placeholder="https://github.com/user/plugin or user/plugin"
        onInstall={handleInstallFromRepo}
        onClose={() => setShowRepoInstallModal(false)}
        isInstalling={isInstallingFromRepo}
      />
    )}
    <div className="h-full flex flex-col">
      {/* Header */}
      <div className="flex-shrink-0 px-6 py-4 border-b border-surface-800">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <Puzzle className="w-6 h-6 text-accent-purple" />
            <div>
              <h1 className="text-xl font-semibold text-surface-100">Plugins</h1>
              <p className="text-sm text-surface-400">
                Extend Claude Code with powerful plugins
              </p>
            </div>
          </div>
          <button
            onClick={() => setShowRepoInstallModal(true)}
            className="px-4 py-2 bg-surface-700 text-surface-200 rounded-lg hover:bg-surface-600 transition-colors flex items-center gap-2"
          >
            <GitBranch className="w-4 h-4" />
            Install from Repo
          </button>
        </div>

        {/* Tabs */}
        <div className="flex gap-4 mt-4">
          <button
            onClick={() => setActiveTab('installed')}
            className={`px-4 py-2 text-sm font-medium rounded-lg transition-colors ${
              activeTab === 'installed'
                ? 'bg-surface-700 text-surface-100'
                : 'text-surface-400 hover:text-surface-200'
            }`}
          >
            Installed ({installedPlugins.length})
          </button>
          <button
            onClick={() => setActiveTab('marketplace')}
            className={`px-4 py-2 text-sm font-medium rounded-lg transition-colors ${
              activeTab === 'marketplace'
                ? 'bg-surface-700 text-surface-100'
                : 'text-surface-400 hover:text-surface-200'
            }`}
          >
            Marketplace
          </button>
        </div>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto p-6">
        {activeTab === 'installed' ? (
          loading ? (
            <div className="flex items-center justify-center h-64">
              <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-accent-purple" />
            </div>
          ) : installedPlugins.length === 0 ? (
            <div className="text-center py-12">
              <Puzzle className="w-12 h-12 text-surface-600 mx-auto mb-4" />
              <h3 className="text-lg font-medium text-surface-300">No plugins installed</h3>
              <p className="text-surface-500 mt-2">
                Browse the marketplace to find plugins
              </p>
              <button
                onClick={() => setActiveTab('marketplace')}
                className="mt-4 px-4 py-2 bg-accent-purple text-white rounded-lg hover:bg-accent-purple/80 transition-colors"
              >
                Browse Marketplace
              </button>
            </div>
          ) : (
            <div className="space-y-3">
              {installedPlugins.map((plugin) => (
                <PluginCard
                  key={plugin.id}
                  plugin={plugin}
                  installed={true}
                  onToggle={handleToggle}
                  onUninstall={handleUninstall}
                  isUninstalling={uninstallingId === plugin.id}
                  isToggling={togglingId === plugin.id}
                />
              ))}
            </div>
          )
        ) : (
          <div>
            {/* Marketplace search/filter */}
            <div className="flex gap-4 mb-6">
              <div className="flex-1 relative min-w-0">
                <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 w-4 h-4 text-surface-500" />
                <input
                  type="text"
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  placeholder="Search plugins..."
                  className="w-full pl-10 pr-3 py-2 bg-surface-800 border border-surface-600 rounded-lg text-surface-100 focus:ring-2 focus:ring-accent-purple focus:border-transparent"
                />
              </div>
              <select
                value={categoryFilter}
                onChange={(e) => setCategoryFilter(e.target.value)}
                className="w-48 flex-shrink-0 px-3 py-2 bg-surface-800 border border-surface-600 rounded-lg text-surface-100 focus:ring-2 focus:ring-accent-purple focus:border-transparent"
              >
                {CATEGORY_FILTERS.map((cat) => (
                  <option key={cat.value} value={cat.value}>
                    {cat.label}
                  </option>
                ))}
              </select>
            </div>

            {/* Marketplace grid */}
            <div className="space-y-3">
              {filteredMarketplace.length === 0 ? (
                <div className="text-center py-12">
                  <Search className="w-12 h-12 text-surface-600 mx-auto mb-4" />
                  <h3 className="text-lg font-medium text-surface-300">No plugins found</h3>
                  <p className="text-surface-500 mt-2">
                    Try adjusting your search or filter
                  </p>
                </div>
              ) : (
                filteredMarketplace.map((plugin) => (
                  <PluginCard
                    key={plugin.id}
                    plugin={plugin}
                    installed={installedPluginIds.has(plugin.id)}
                    onInstall={handleInstall}
                    isInstalling={installingId === plugin.id}
                  />
                ))
              )}
            </div>
          </div>
        )}
      </div>
    </div>
    </>
  );
}
