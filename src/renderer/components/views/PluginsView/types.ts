// ============================================================================
// PLUGINS VIEW TYPES
// ============================================================================

/**
 * Plugin interface representing a Claude Code plugin
 */
export interface Plugin {
  /** Unique identifier for the plugin */
  id: string;
  /** Display name of the plugin */
  name: string;
  /** Short description of what the plugin does */
  description: string;
  /** Category for filtering and organization */
  category: 'productivity' | 'devops' | 'communication' | 'ai' | 'custom';
  /** GitHub repository URL */
  repository?: string;
  /** Documentation website URL */
  documentation?: string;
  /** Whether this plugin is featured (gets special styling) */
  featured?: boolean;
  /** Vibes rating for featured plugins */
  vibes?: 'good' | 'great' | 'immaculate';
  /** Whether the plugin is currently installed */
  installed?: boolean;
  /** Whether the plugin is enabled */
  enabled?: boolean;
  /** Version string */
  version?: string;
  /** Author name */
  author?: string;
}

/**
 * Plugin category configuration for icons and styling
 */
export interface CategoryConfig {
  icon: React.ReactNode;
  iconClass: string;
  label: string;
}
