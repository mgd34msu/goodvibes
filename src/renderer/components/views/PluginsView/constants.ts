// ============================================================================
// PLUGINS VIEW CONSTANTS
// ============================================================================

import type { Plugin } from './types';

/**
 * Built-in plugins that are available in the marketplace
 */
export const BUILT_IN_PLUGINS: Plugin[] = [
  {
    id: 'goodvibes',
    name: 'GoodVibes',
    description: 'Supercharge Claude Code with intelligent context injection, persistent memory, smart error recovery, automated quality gates, and 170+ development skills.',
    category: 'productivity',
    repository: 'https://github.com/mgd34msu/goodvibes-plugin',
    documentation: 'https://goodvibes.sh/',
    featured: true,
    vibes: 'immaculate',
  },
];

/**
 * Category filter options for the marketplace
 */
export const CATEGORY_FILTERS = [
  { value: 'all', label: 'All Categories' },
  { value: 'productivity', label: 'Productivity' },
  { value: 'devops', label: 'DevOps' },
  { value: 'communication', label: 'Communication' },
  { value: 'ai', label: 'AI & ML' },
  { value: 'custom', label: 'Custom' },
] as const;
