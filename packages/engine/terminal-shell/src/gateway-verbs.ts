/**
 * gateway-verbs.ts, attach handlers for every ws-only gateway verb group, in
 * one shared place the daemon front-ends consume.
 *
 * The GatewayMethodCatalog's builtin DESCRIPTORS make fleet.* (including the
 * archive verbs), checkpoints.*, sessions.search, and push.* appear in the
 * contract, but a descriptor without an attached handler answers
 * 501 "Gateway method is not invokable" over both websocket and HTTP invoke.
 * A composition root that registers those descriptors but never calls the platform's
 * registration entry point ships exactly that 501 for the whole ws-only family
 *, the regression this package exists to make impossible to reintroduce
 * independently in each front-end. `attachWsOnlyGatewayVerbHandlers` binds the
 * descriptors and their handlers together, and the conformance helper in
 * ./conformance.ts gates that no descriptor is ever left handler-less.
 *
 * This module is a thin, dependency-injected wrapper over the platform's own
 * registration entry points. Front-ends pass their concrete managers in; the
 * package owns the wiring so it cannot drift between them.
 */
import {
  registerGatewayVerbGroups,
  type GatewayMethodCatalog,
  type GatewayVerbGroupDeps,
} from '@goodvibes/engine/platform/platform/control-plane';
import type { ArchivableProcessRegistry, ProcessRegistryDeps } from '@goodvibes/engine/platform/platform/runtime/fleet';

/**
 * Attach handlers for the ws-only gateway verb groups (fleet.* / checkpoints.* /
 * sessions.search / push.*) onto an existing catalog. Descriptors and handlers
 * are registered together, so a verb can never be descriptor-present but
 * handler-absent (the 501 regression class).
 *
 * Call once, at composition time, after the injected managers all exist. The
 * dependency shape (`GatewayVerbGroupDeps`) is owned by the platform; this wrapper
 * exists so each front-end has a single named call site instead of reaching
 * into the platform's registration internals directly and diverging.
 */
export function attachWsOnlyGatewayVerbHandlers(
  gatewayMethods: GatewayMethodCatalog,
  deps: GatewayVerbGroupDeps,
): void {
  registerGatewayVerbGroups(gatewayMethods, deps);
}

export type { GatewayVerbGroupDeps, ProcessRegistryDeps, ArchivableProcessRegistry };
