/**
 * permissions.rules.* gateway handlers, the settings-domain surface over the
 * durable user-origin permission rule store. Read/delete only: rules are
 * WRITTEN by remembered approval decisions (PermissionManager), never minted
 * ad hoc through the wire, so the store's provenance stays "a user answered
 * an ask".
 */

import type { GatewayMethodCatalog } from '../method-catalog.js';
import type { GatewayMethodHandler } from '../method-catalog-shared.js';
import { projectIdentity, type UserPermissionRuleStore } from '../../permissions/user-rule-store.js';
import { projectRootOfDirectory } from '../../permissions/call-project.js';
import { readInvocationParams, requireString } from './invocation-params.js';
import { attachHandler } from './attach-handler.js';
import { logger } from '../../utils/logger.js';


export interface PermissionRulesGatewayDeps {
  readonly userRuleStore: Pick<UserPermissionRuleStore, 'list' | 'delete'>;
}

export function createPermissionRulesListHandler(store: PermissionRulesGatewayDeps['userRuleStore']): GatewayMethodHandler {
  return async (invocation) => {
    const params = readInvocationParams(invocation);
    const named = params['project'];
    const folder = typeof named === 'string' && named.trim().length > 0 ? named.trim() : undefined;
    // A project's own list: its rules and the ones of every project, never another project's.
    const project = folder === undefined ? undefined : projectIdentity(projectRootOfDirectory(folder));
    return { rules: store.list().filter((record) => project === undefined || record.project === undefined || record.project === project).map((record) => ({
      id: record.rule.id,
      effect: record.rule.effect,
      tier: record.tier,
      tool: record.tool,
      ...(record.rule.description ? { description: record.rule.description } : {}),
      createdAt: record.createdAt,
      ...(record.project !== undefined ? { project: record.project } : {}),
      // Carried from 3.5.0 to every project, until placed in one or removed.
      ...(record.carried !== undefined ? { carried: record.carried } : {}),
      // The session whose answer made it, by its title when it had one (a runner by its task, a chat by its title).
      ...(record.madeIn !== undefined ? { madeIn: record.madeIn } : {}),
    })) };
  };
}

export function createPermissionRulesDeleteHandler(store: PermissionRulesGatewayDeps['userRuleStore']): GatewayMethodHandler {
  return async (invocation) => {
    const params = readInvocationParams(invocation);
    const ruleId = requireString(params, 'ruleId');
    const deleted = await store.delete(ruleId);
    // A standing grant or denial is security policy: who removed it is kept,
    // the rule's content is not.
    if (deleted) {
      logger.info('permission rule deleted', {
        ruleId,
        principalId: invocation.context?.principalId ?? 'unknown',
        principalKind: invocation.context?.principalKind ?? 'unknown',
      });
    }
    return { deleted };
  };
}

/** Attach the permissions.rules.list/.delete handlers to their descriptors (a missing one is logged). */
export function registerPermissionRulesGatewayMethods(catalog: GatewayMethodCatalog, deps: PermissionRulesGatewayDeps): void {
  attachHandler(catalog, 'permissions.rules.list', createPermissionRulesListHandler(deps.userRuleStore));
  attachHandler(catalog, 'permissions.rules.delete', createPermissionRulesDeleteHandler(deps.userRuleStore));
}
