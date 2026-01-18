// ============================================================================
// PLUGINS VIEW - Plugin Management Dashboard
// ============================================================================

import { useState, useMemo } from 'react';
import {
  Puzzle,
  Search,
} from 'lucide-react';
import { createLogger } from '../../../../shared/logger';
import { PluginCard } from './PluginCard';
import { BUILT_IN_PLUGINS, CATEGORY_FILTERS } from './constants';
import type { Plugin } from './types';

const logger = createLogger('PluginsView');

// ============================================================================
// MAIN PLUGINS VIEW
// ============================================================================

export default function PluginsView() {
  const [activeTab, setActiveTab] = useState<'installed' | 'marketplace'>('installed');
  const [searchQuery, setSearchQuery] = useState('');
  const [categoryFilter, setCategoryFilter] = useState<string>('all');

  // For now, GoodVibes is the only installed plugin (it's built into the app)
  const installedPlugins = useMemo(() => {
    return BUILT_IN_PLUGINS.filter(p => p.id === 'goodvibes').map(p => ({
      ...p,
      installed: true,
      enabled: true,
    }));
  }, []);

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

  const handleInstall = async (plugin: Plugin) => {
    logger.info('Installing plugin:', plugin.id);
    // TODO: Implement actual plugin installation
    // For now, GoodVibes is built-in and always installed
  };

  const handleToggle = async (plugin: Plugin) => {
    logger.info('Toggling plugin:', plugin.id, 'enabled:', !plugin.enabled);
    // TODO: Implement plugin enable/disable
  };

  return (
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
          installedPlugins.length === 0 ? (
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
                  />
                ))
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
