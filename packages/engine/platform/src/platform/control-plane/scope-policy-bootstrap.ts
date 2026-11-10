/** Construction-only bridge from the product graph to completed host registration. */
import type { GatewayMethodCatalog, GatewayScopePolicyOwner, GatewayPolicyRevision } from './method-catalog.js';

type BootstrapPhase = 'facade' | 'boot';
const pending = new WeakMap<GatewayMethodCatalog, (phase: BootstrapPhase) => void>();
const prepared = new WeakSet<GatewayMethodCatalog>();
interface Readiness { state: 'pending' | 'active' | 'closed'; readonly listeners: Set<() => void> }
const readiness = new WeakMap<GatewayMethodCatalog, Readiness>();

/** Wait for this already-owned graph's host registration. Never prepares a
 * catalog, grants scopes, polls, or lets a retired graph become ready again. */
export function waitForGatewayScopePolicyBootstrap(catalog: GatewayMethodCatalog, signal: AbortSignal): Promise<void> {
  const owned = readiness.get(catalog);
  return new Promise<void>((resolve, reject) => {
    const cleanup = () => { owned?.listeners.delete(changed); signal.removeEventListener('abort', changed); };
    const changed = () => {
      if (signal.aborted || !owned || owned.state === 'closed') {
        cleanup(); reject(new Error('Gateway scope bootstrap is unavailable')); return;
      }
      if (owned.state === 'active') { cleanup(); resolve(); }
    };
    owned?.listeners.add(changed); signal.addEventListener('abort', changed, { once: true }); changed();
  });
}

/** Native policy reads refuse until every initial host registration phase has completed. */
export function prepareGatewayScopePolicyOwner(catalog: GatewayMethodCatalog, beforeMutation: () => void,
  needsBoot = false, revisionForSnapshot?: GatewayPolicyRevision): GatewayScopePolicyOwner {
  if (prepared.has(catalog)) throw new Error('Gateway scope bootstrap is already owned or retired');
  prepared.add(catalog);
  const ready: Readiness = { state: 'pending', listeners: new Set() }; readiness.set(catalog, ready);
  let active: GatewayScopePolicyOwner | undefined; let closed = false;
  const phases = new Set<BootstrapPhase>();
  const complete = (phase: BootstrapPhase) => {
    if (closed || active) throw new Error('Gateway scope bootstrap is no longer current');
    phases.add(phase);
    if (!phases.has('facade') || (needsBoot && !phases.has('boot'))) return;
    active = catalog.attachScopePolicyOwner(beforeMutation, revisionForSnapshot); pending.delete(catalog);
    ready.state = 'active'; for (const listener of [...ready.listeners]) listener();
  };
  pending.set(catalog, complete);
  return Object.freeze({
    current(version: 1 | 2 = 2) { if (closed || !active) throw new Error('Gateway scope bootstrap is incomplete or retired'); return active.current(version); },
    grantedScopes() { if (closed || !active) throw new Error('Gateway scope bootstrap is incomplete or retired'); return active.grantedScopes(); },
    close() { if (closed) return; closed = true; ready.state = 'closed';
      for (const listener of [...ready.listeners]) listener();
      if (pending.get(catalog) === complete) pending.delete(catalog); active?.close(); },
  });
}

/** Idempotent host completion cannot mint an owner or reopen a retired graph. */
export function completeGatewayScopePolicyBootstrap(catalog: GatewayMethodCatalog, phase: BootstrapPhase = 'facade'): void {
  pending.get(catalog)?.(phase);
}
