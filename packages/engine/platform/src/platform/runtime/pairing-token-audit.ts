import type { PairingTokenManager } from '../pairing/pairing-token-store.js';
import type { ApiTokenAuditor } from '../security/token-audit.js';
import { logger } from '../utils/logger.js';

/** Policy every per-device pairing token is audited under: no provider scopes, rotation by age only. */
export const PAIRING_TOKEN_AUDIT_POLICY_ID = 'pairing-token';

/** How often the daemon re-reads the paired devices and audits their age. */
export const PAIRING_TOKEN_AUDIT_INTERVAL_MS = 60 * 60 * 1000;

const PAIRING_ID_PREFIX = 'pairing:';

/** The ids this module registered per auditor, so a revoked device can be removed again. */
const registered = new WeakMap<ApiTokenAuditor, Set<string>>();

/**
 * Mirror the live per-device tokens into the auditor (revoked ones leave it) and
 * run one audit, so rotation findings reach the security domain through the
 * auditor's emitter. Re-registering an unchanged token is skipped so the
 * auditor's read revision only moves when the set really changed.
 */
export function auditPairingTokens(
  pairingTokens: Pick<PairingTokenManager, 'list'>,
  auditor: ApiTokenAuditor,
  now: number = Date.now(),
): void {
  if (!auditor.getPolicy(PAIRING_TOKEN_AUDIT_POLICY_ID)) {
    auditor.registerPolicy({ id: PAIRING_TOKEN_AUDIT_POLICY_ID, name: 'Paired device token', allowedScopes: [] });
  }
  const live = new Set<string>();
  const mine = registered.get(auditor) ?? new Set<string>();
  registered.set(auditor, mine);
  for (const token of pairingTokens.list()) {
    const id = PAIRING_ID_PREFIX + token.id;
    live.add(id);
    const known = auditor.getTokenMetadata(id);
    if (known && known.issuedAt === token.createdAt && known.label === token.name) continue;
    auditor.registerToken({ id, label: token.name, issuedAt: token.createdAt, grantedScopes: [], policyId: PAIRING_TOKEN_AUDIT_POLICY_ID });
    mine.add(id);
  }
  for (const known of [...mine]) {
    if (!live.has(known)) { auditor.deregisterToken(known); mine.delete(known); }
  }
  auditor.auditAll(now);
}

/**
 * Audit now and then every `intervalMs`. The returned function stops the timer.
 * A failing audit is logged and the timer keeps running.
 */
export function startPairingTokenAudit(
  pairingTokens: Pick<PairingTokenManager, 'list'>,
  auditor: ApiTokenAuditor,
  options: {
    readonly intervalMs?: number;
    readonly setInterval?: (run: () => void, ms: number) => unknown;
    readonly clearInterval?: (handle: unknown) => void;
  } = {},
): () => void {
  const run = (): void => {
    try { auditPairingTokens(pairingTokens, auditor); }
    catch (error) { logger.warn('pairing token audit failed', { error: error instanceof Error ? error.message : String(error) }); }
  };
  run();
  const schedule = options.setInterval ?? ((fn, ms) => { const timer = setInterval(fn, ms); timer.unref?.(); return timer; });
  const cancel = options.clearInterval ?? ((handle) => clearInterval(handle as ReturnType<typeof setInterval>));
  const handle = schedule(run, options.intervalMs ?? PAIRING_TOKEN_AUDIT_INTERVAL_MS);
  return () => cancel(handle);
}
