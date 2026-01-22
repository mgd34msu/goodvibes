// ============================================================================
// PLUGIN CARD - Premium Glass Morphism Design with Rainbow Effects
// ============================================================================

import {
  ExternalLink,
  Package,
  Zap,
  Wrench,
  MessageSquare,
  Brain,
  Download,
  Sparkles,
  Power,
  PowerOff,
} from 'lucide-react';
import type { Plugin, CategoryConfig } from './types';

// ============================================================================
// CONSTANTS
// ============================================================================

const CATEGORY_CONFIG: Record<string, CategoryConfig> = {
  productivity: {
    icon: <Zap className="w-5 h-5" />,
    iconClass: 'card-icon',
    label: 'Productivity',
  },
  devops: {
    icon: <Wrench className="w-5 h-5" />,
    iconClass: 'card-icon',
    label: 'DevOps',
  },
  communication: {
    icon: <MessageSquare className="w-5 h-5" />,
    iconClass: 'card-icon',
    label: 'Communication',
  },
  ai: {
    icon: <Brain className="w-5 h-5" />,
    iconClass: 'card-icon',
    label: 'AI & ML',
  },
  custom: {
    icon: <Package className="w-5 h-5" />,
    iconClass: 'card-icon',
    label: 'Custom',
  },
};

const DEFAULT_CATEGORY: CategoryConfig = {
  icon: <Package className="w-5 h-5" />,
  iconClass: 'card-icon',
  label: 'Custom',
};

// ============================================================================
// PLUGIN CARD COMPONENT
// ============================================================================

interface PluginCardProps {
  plugin: Plugin;
  installed: boolean;
  onInstall?: (plugin: Plugin) => void;
  onToggle?: (plugin: Plugin) => void;
  onUninstall?: (plugin: Plugin) => void;
  isUninstalling?: boolean;
}

export function PluginCard({ plugin, installed, onInstall, onToggle, onUninstall, isUninstalling }: PluginCardProps): React.JSX.Element {
  const categoryConfig: CategoryConfig = CATEGORY_CONFIG[plugin.category] ?? DEFAULT_CATEGORY;
  const isFeatured = plugin.featured;

  // Featured card gets special rainbow treatment
  const cardClasses = isFeatured
    ? `card-hover card-featured group ${installed ? 'card-selected' : ''}`
    : `card-hover group ${installed ? 'card-selected' : ''}`;

  // Featured items use sparkles icon with special styling
  const iconElement = isFeatured ? (
    <div className="card-icon card-icon-featured">
      <Sparkles className="w-5 h-5" />
    </div>
  ) : (
    <div className={categoryConfig.iconClass}>
      {categoryConfig.icon}
    </div>
  );

  return (
    <div className={cardClasses}>
      {/* Main Content */}
      <div className="flex items-start justify-between gap-4">
        {/* Left Section: Icon + Info */}
        <div className="flex items-start gap-3 flex-1 min-w-0">
          {/* Icon */}
          {iconElement}

          {/* Info */}
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <h3 className={isFeatured ? "card-title-rainbow text-base" : "card-title-gradient text-base"}>
                {plugin.name}
              </h3>
              {isFeatured && plugin.vibes && (
                <span className="card-badge card-badge-rainbow">
                  <Sparkles className="w-3 h-3" />
                  {plugin.vibes} vibes
                </span>
              )}
              {plugin.version && (
                <span className="card-badge card-badge-muted">
                  v{plugin.version}
                </span>
              )}
            </div>
            <p className="card-description line-clamp-2">{plugin.description}</p>
            {plugin.author && (
              <div className="card-meta mt-3">
                <span className="card-meta-item">
                  By {plugin.author}
                </span>
              </div>
            )}
          </div>
        </div>

        {/* Right Section: Actions */}
        <div className="card-actions">
          {plugin.documentation && (
            <a
              href={plugin.documentation}
              target="_blank"
              rel="noopener noreferrer"
              className="card-action-btn card-action-btn-primary"
              title="Documentation"
            >
              <ExternalLink className="w-4 h-4" />
            </a>
          )}
          {plugin.repository && (
            <a
              href={plugin.repository}
              target="_blank"
              rel="noopener noreferrer"
              className="card-action-btn card-action-btn-secondary"
              title="Repository"
            >
              <Package className="w-4 h-4" />
            </a>
          )}
          {installed ? (
            <div className="flex items-center gap-2">
              {onToggle && (
                <button
                  onClick={() => onToggle(plugin)}
                  className={`card-action-btn ${plugin.enabled ? 'card-action-btn-success' : 'card-action-btn-muted'}`}
                  title={plugin.enabled ? 'Disable plugin' : 'Enable plugin'}
                >
                  {plugin.enabled ? <Power className="w-4 h-4" /> : <PowerOff className="w-4 h-4" />}
                </button>
              )}
              {onUninstall && (
                <button
                  onClick={() => onUninstall(plugin)}
                  disabled={isUninstalling}
                  className={`px-3 py-1.5 text-sm font-medium rounded-lg transition-colors ${
                    isUninstalling
                      ? 'bg-error-500/10 text-error-400/50 cursor-not-allowed opacity-50'
                      : 'bg-error-500/20 text-error-400 hover:bg-error-500/30'
                  }`}
                >
                  {isUninstalling ? 'Uninstalling...' : 'Uninstall'}
                </button>
              )}
            </div>
          ) : (
            onInstall && (
              <button
                onClick={() => onInstall(plugin)}
                className={isFeatured ? "card-action-rainbow" : "card-action-primary"}
              >
                <Download className="w-3.5 h-3.5" />
                Install
              </button>
            )
          )}
        </div>
      </div>
    </div>
  );
}

export default PluginCard;
