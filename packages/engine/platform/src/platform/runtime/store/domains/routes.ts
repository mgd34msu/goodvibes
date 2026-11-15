/**
 * Route binding domain state, external conversation, thread, and session mappings.
 */
import { TRANSPORT_SURFACE_KINDS } from '../../../../events/surfaces.js';
import type { AutomationRouteBinding } from '../../../automation/routes.js';

export interface RoutesDomainState {
  readonly revision: number;
  readonly lastUpdatedAt: number;
  readonly source: string;
  readonly bindings: Map<string, AutomationRouteBinding>;
  readonly bindingIds: string[];
  readonly bindingIdsBySurface: Readonly<Record<string, readonly string[]>>;
  readonly activeBindingIds: string[];
  readonly recentBindingIds: string[];
  readonly totalBindings: number;
  readonly totalResolved: number;
  readonly totalFailures: number;
}

/** One empty list per route surface kind, from the canonical list so a new kind needs no second edit. */
export function emptyBindingIdsBySurface(): Record<string, string[]> {
  return Object.fromEntries(TRANSPORT_SURFACE_KINDS.map((kind) => [kind, [] as string[]]));
}

export function createInitialRoutesState(): RoutesDomainState {
  return {
    revision: 0,
    lastUpdatedAt: 0,
    source: 'init',
    bindings: new Map(),
    bindingIds: [],
    bindingIdsBySurface: emptyBindingIdsBySurface(),
    activeBindingIds: [],
    recentBindingIds: [],
    totalBindings: 0,
    totalResolved: 0,
    totalFailures: 0,
  };
}
