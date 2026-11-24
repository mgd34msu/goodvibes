import type { AgentWorkspaceAction, AgentWorkspaceCategory, AgentWorkspaceCategoryId, AgentWorkspaceFocusPane } from './agent-workspace-types.ts';

interface AgentWorkspaceNavigationHost {
  readonly categories: readonly AgentWorkspaceCategory[];
  readonly actions: readonly AgentWorkspaceAction[];
  focusPane: AgentWorkspaceFocusPane;
  selectedCategoryIndex: number;
  selectedActionIndex: number;
  /** The status line and the last action's result, which belong to the category they were made in. */
  status: string;
  lastActionResult: unknown;
  clampSelection(): void;
}

/** Moving to another category starts it with its own status line, not the last category's result. */
function enterCategory(host: AgentWorkspaceNavigationHost, previousIndex: number): void {
  if (host.selectedCategoryIndex === previousIndex) return;
  host.lastActionResult = null;
  // The area's name is in the header already: no status line until something happens.
  host.status = '';
}

const AGENT_WORKSPACE_CATEGORY_ALIASES = {
  connected: 'host',
  'connected-host': 'host',
  host: 'host',
  mcp: 'tools',
  tool: 'tools',
  channel: 'onboarding-channels',
  channels: 'onboarding-channels',
  messaging: 'onboarding-channels',
  voice: 'onboarding-voice-media',
  media: 'onboarding-voice-media',
  'voice-media': 'onboarding-voice-media',
  profile: 'profiles',
  persona: 'personas',
  skill: 'skills',
  routine: 'routines',
  schedule: 'automation',
  schedules: 'automation',
  plan: 'work',
  planning: 'work',
  task: 'host',
  tasks: 'host',
  note: 'notes',
  scratchpad: 'notes',
  kb: 'knowledge',
  artifacts: 'documents',
  artifact: 'documents',
  delegate: 'work',
  delegation: 'work',
} as const satisfies Readonly<Record<string, AgentWorkspaceCategoryId>>;

type AgentWorkspaceCategoryAlias = keyof typeof AGENT_WORKSPACE_CATEGORY_ALIASES;

function isAgentWorkspaceCategoryAlias(categoryIdOrLabel: string): categoryIdOrLabel is AgentWorkspaceCategoryAlias {
  return Object.prototype.hasOwnProperty.call(AGENT_WORKSPACE_CATEGORY_ALIASES, categoryIdOrLabel);
}

function normalizeAgentWorkspaceCategoryRequest(categoryIdOrLabel: string): string {
  const normalized = categoryIdOrLabel.trim().toLowerCase();
  if (!normalized) return '';
  return isAgentWorkspaceCategoryAlias(normalized) ? AGENT_WORKSPACE_CATEGORY_ALIASES[normalized] : normalized;
}

export function moveAgentWorkspaceSelection(host: AgentWorkspaceNavigationHost, delta: -1 | 1): void {
  if (host.focusPane === 'categories') {
    const previous = host.selectedCategoryIndex;
    host.selectedCategoryIndex = Math.max(0, Math.min(host.categories.length - 1, host.selectedCategoryIndex + delta));
    host.selectedActionIndex = 0;
    enterCategory(host, previous);
  } else {
    host.selectedActionIndex = Math.max(0, Math.min(host.actions.length - 1, host.selectedActionIndex + delta));
  }
  host.clampSelection();
}

export function jumpAgentWorkspaceSelection(host: AgentWorkspaceNavigationHost, target: 'home' | 'end'): void {
  if (host.focusPane === 'categories') {
    const previous = host.selectedCategoryIndex;
    host.selectedCategoryIndex = target === 'home' ? 0 : host.categories.length - 1;
    enterCategory(host, previous);
  } else {
    host.selectedActionIndex = target === 'home' ? 0 : host.actions.length - 1;
  }
  host.clampSelection();
}

function findAgentWorkspaceCategoryIndex(categories: readonly AgentWorkspaceCategory[], categoryIdOrLabel: string): number {
  const normalized = normalizeAgentWorkspaceCategoryRequest(categoryIdOrLabel);
  if (!normalized) return -1;
  return categories.findIndex((category) =>
    category.id.toLowerCase() === normalized
    || category.label.toLowerCase() === normalized
    || category.label.toLowerCase().replace(/[^a-z0-9]+/g, '-') === normalized
  );
}

/** True when the workspace would open this area, aliases included. */
export function isKnownAgentWorkspaceCategory(categories: readonly AgentWorkspaceCategory[], categoryIdOrLabel: string): boolean {
  return findAgentWorkspaceCategoryIndex(categories, categoryIdOrLabel) >= 0;
}

export function selectAgentWorkspaceCategory(host: AgentWorkspaceNavigationHost, categoryIdOrLabel: string): boolean {
  const categoryIndex = findAgentWorkspaceCategoryIndex(host.categories, categoryIdOrLabel);
  if (categoryIndex < 0) return false;
  host.selectedCategoryIndex = categoryIndex;
  host.selectedActionIndex = 0;
  host.focusPane = 'actions';
  host.clampSelection();
  return true;
}
