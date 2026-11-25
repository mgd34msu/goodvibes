/**
 * `goodvibes://open/<view>[?target=<id>[:<kind>]]`: a link that opens a view of
 * this app and, for a process view, selects the process it names. One parser
 * and one opener serve `/deeplink open`, `/setup link` and `/setup open-link`.
 */
import type { CommandContext } from '../command-registry.ts';
import { AGENT_VIEW_NAMES, parseViewTarget } from '../views.ts';

/** The views a link is offered for in reviews. Any name `/open` knows also works. */
export const DEEP_LINK_SURFACES: readonly string[] = ['cockpit', 'security', 'remote', 'knowledge', 'marketplace', 'sandbox', 'incident', 'hooks', 'orchestration', 'tasks'];

export function buildDeepLink(surface: string, target?: string): string {
  const encodedTarget = target ? `?target=${encodeURIComponent(target)}` : '';
  return `goodvibes://open/${encodeURIComponent(surface)}${encodedTarget}`;
}

export function parseDeepLink(value: string): { surface: string; target?: string } | null {
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== 'goodvibes:') return null;
    const segments = parsed.pathname.split('/').filter(Boolean);
    if (parsed.hostname !== 'open' || segments.length !== 1) return null;
    const target = parsed.searchParams.get('target');
    return { surface: decodeURIComponent(segments[0]!), ...(target ? { target } : {}) };
  } catch {
    return null;
  }
}

/** The old screens' names a link may carry, and the place (and tab) that replaced each. */
const PLACE_OF_OLD_VIEW: Readonly<Record<string, { readonly id: string; readonly list?: string; readonly title: string }>> = {
  security: { id: 'safety', title: 'Permissions and safety' },
  sandbox: { id: 'safety', title: 'Permissions and safety' },
  marketplace: { id: 'tools', title: 'Tools and extensions' },
  hooks: { id: 'tools', title: 'Tools and extensions' },
  knowledge: { id: 'memory', title: 'Memory and knowledge' },
  remote: { id: 'work', list: 'runners', title: 'Work and agents, Runners' },
  incident: { id: 'system', list: 'health', title: 'System, Health' },
  notifications: { id: 'system', list: 'notices', title: 'System, Notices' },
  devices: { id: 'devices', list: 'devices', title: 'Devices and network, Paired' },
  'settings-sync': { id: 'devices', list: 'settings-sync', title: 'Devices and network, Settings sync' },
};

/** True when the view selects a process by id (the Agents view and its old names). */
function viewSelectsTarget(surface: string): boolean {
  const id = surface.trim().toLowerCase();
  return id === 'hosted' || AGENT_VIEW_NAMES.includes(id);
}

/**
 * Opens the view a link (or a bare view name plus target) names and returns the
 * line that says what happened: opened, opened without the selection (a view
 * that has no selection), or not opened and why.
 */
export function openDeepLink(ctx: CommandContext, surface: string, target?: string): string {
  // A screen a place replaced: its old name in a link opens that place (on the tab that holds what it showed).
  const place = PLACE_OF_OLD_VIEW[surface.trim().toLowerCase()];
  if (place && ctx.openPlace) {
    ctx.openPlace(place.id, place.list ? { list: place.list } : undefined);
    return `Opened ${place.title}${target !== undefined ? `; it has no selection, so the target ${target} was not used` : ''}.`;
  }
  if (!ctx.openView) return `This surface cannot open views; ${buildDeepLink(surface, target)} opens in the terminal app.`;
  const selects = target !== undefined && viewSelectsTarget(surface);
  const viewTarget = selects ? parseViewTarget(target) : undefined;
  if (selects && !viewTarget) return `Not opened: "${target}" is not a target. Use <id> or <id>:<kind>, for example contract-123:contract.`;
  if (!ctx.openView(surface, viewTarget)) return `Not opened: no view is named "${surface}". Views with links: ${DEEP_LINK_SURFACES.join(', ')}.`;
  if (target === undefined) return `Opened ${surface}.`;
  return selects
    ? `Opened ${surface} with ${target} selected.`
    : `Opened ${surface}; it has no selection, so the target ${target} was not used. Targets select in process views (agents, tasks, orchestration).`;
}
