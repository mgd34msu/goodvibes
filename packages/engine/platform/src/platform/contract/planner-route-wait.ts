/**
 * A contract no model can be routed to plan keeps its `planning` status and
 * waits until a provider serves the work; its status line says so. This module
 * is the one owner of that line: the planner writes it and the turn that waits
 * on the contract's agents reads it.
 */

/** How a contract waiting for a route for its planner begins its status line, after its id. */
const PLANNER_ROUTE_WAIT = 'is waiting: no model can be routed to plan it';

/** The one line a contract waiting for a route for its planner says, to the owner, on its row and to its session's model. */
export function plannerRouteWaitLine(contractId: string, why: string): string {
  return `Contract ${contractId} ${PLANNER_ROUTE_WAIT} (${why.replace(/\.$/, '')}). `
    + 'It plans on its own as soon as a provider that serves this work is available: signed in, configured, or answering again. Cancel the contract to stop it.';
}

/** Whether a contract is waiting for a model route for its planner (its status stays `planning`). */
export function isWaitingForPlannerRoute(contract: { readonly id: string; readonly status: string; readonly statusLine?: string | undefined }): boolean {
  return contract.status === 'planning' && contract.statusLine?.startsWith(`Contract ${contract.id} ${PLANNER_ROUTE_WAIT}`) === true;
}
