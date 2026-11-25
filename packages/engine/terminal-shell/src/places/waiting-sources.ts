/**
 * waiting-sources.ts, the two lists of Waiting for you that a terminal
 * program supplies itself (waiting-place.ts names them): the kinds of
 * approval (the same list the capability approval.kinds reads), and the sends
 * the Agent's content check refused, while they wait. Kept apart from the
 * declaration, which the web UI imports.
 */
import { APPROVAL_KINDS } from '@goodvibes/engine/platform/platform/capabilities';
import { listRefusedOutwardActions, onRefusedOutwardActionsChange } from '../agent-turn/outward-approvals.js';
import type { PlaceProgramSource } from './place-host.js';

/** Waiting for you's program sources for this program: the kinds of approval in both, the held sends in the Agent. */
export function waitingPlaceSources(program: 'tui' | 'agent'): Readonly<Record<string, PlaceProgramSource>> {
  return {
    'approval-kinds': { read: () => APPROVAL_KINDS, subscribe: () => () => {} },
    // Only the Agent's turns send mail and calendar invitations through the content check.
    ...(program === 'agent' ? { 'held-sends': { read: () => listRefusedOutwardActions(), subscribe: (onChange: () => void) => onRefusedOutwardActionsChange(onChange) } } : {}),
  };
}
