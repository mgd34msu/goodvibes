import type { ConfigManager } from '../config/manager.js';
import type { PairingTokenManager } from '../pairing/pairing-token-store.js';
import type { FeatureFlagManager } from './feature-flags/index.js';
import type { RuntimeEventBus } from './events/index.js';
import { ApiTokenAuditor } from '../security/token-audit.js';
import { createTokenAuditBusEmitter } from './token-audit-events.js';
import { logger } from '../utils/logger.js';
import { isFeatureGateEnabled } from './feature-flags/gates.js';

/** Policy every per-device pairing token is audited under: no provider scopes, rotation by age only. */
export const PAIRING_TOKEN_AUDIT_POLICY_ID = 'pairing-token';

/** How often the paired devices are re-read and their age audited. */
export const PAIRING_TOKEN_AUDIT_INTERVAL_MS = 60 * 60 * 1000;

const PAIRING_ID_PREFIX = 'pairing:';
const DAY_MS = 24 * 60 * 60 * 1000;

/** The ids this module registered per auditor, so a revoked device can be removed again. */
const registered = new WeakMap<ApiTokenAuditor, Set<string>>();

/**
 * The token auditor every product builds the same way: managed mode and the
 * rotation cadence from the `security.tokenAudit.*` settings, findings on the
 * runtime bus's security domain when a bus is given.
 */
export function createConfiguredTokenAuditor(options: {
  readonly configManager: Pick<ConfigManager, 'get'>;
  readonly featureFlags?: Pick<FeatureFlagManager, 'isEnabled'> | null | undefined;
  readonly runtimeBus?: RuntimeEventBus | null | undefined;
}): ApiTokenAuditor {
  const { configManager } = options;
  return new ApiTokenAuditor({
    managed: configManager.get('security.tokenAudit.managed') === true,
    ...(options.featureFlags ? { featureFlags: options.featureFlags } : {}),
    defaultRotationCadenceMs: Number(configManager.get('security.tokenAudit.rotationCadenceDays')) * DAY_MS,
    defaultRotationWarningThresholdMs: Number(configManager.get('security.tokenAudit.rotationWarningDays')) * DAY_MS,
  }, options.runtimeBus ? { emitter: createTokenAuditBusEmitter(options.runtimeBus) } : undefined);
}

/**
 * Managed rotation, enforced where a device token authenticates: with
 * `security.tokenAudit.managed` on (and the token audit feature enabled) the
 * pairing store refuses a device token older than `rotationCadenceDays`, and
 * says its age and the re-pair step. The settings are read at each
 * authentication, so a change applies on the next request. Returns the unbind.
 */
export function bindPairingRotationLimit(
  pairingTokens: Pick<PairingTokenManager, 'setRotationLimit'>,
  options: {
    readonly configManager: Pick<ConfigManager, 'get'>;
    readonly featureFlags?: Pick<FeatureFlagManager, 'isEnabled'> | null | undefined;
  },
): () => void {
  pairingTokens.setRotationLimit(() => {
    if (options.configManager.get('security.tokenAudit.managed') !== true) return null;
    if (!isFeatureGateEnabled(options.featureFlags, 'token-scope-rotation-audit')) return null;
    const days = Number(options.configManager.get('security.tokenAudit.rotationCadenceDays'));
    return Number.isFinite(days) && days > 0 ? days * DAY_MS : null;
  });
  return () => pairingTokens.setRotationLimit(undefined);
}

/**
 * Mirror the live per-device tokens into the auditor (revoked ones leave it).
 * Re-registering an unchanged token is skipped so the auditor's read revision
 * only moves when the set really changed.
 */
function mirrorPairingTokens(pairingTokens: Pick<PairingTokenManager, 'list'>, auditor: ApiTokenAuditor): void {
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
}

/**
 * Mirror the paired devices into the auditor and run one audit of record, so
 * rotation findings reach the security domain through the auditor's emitter.
 */
export function auditPairingTokens(
  pairingTokens: Pick<PairingTokenManager, 'list'>,
  auditor: ApiTokenAuditor,
  now: number = Date.now(),
): void {
  mirrorPairingTokens(pairingTokens, auditor);
  auditor.runAudit(now);
}

/**
 * Make the paired devices the auditor's token source, audit now and then every
 * `intervalMs`. Any other audit of record (the Security screen's `r`) also reads
 * the devices first. The returned function stops the timer and drops the source.
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
  auditor.setTokenSource(() => mirrorPairingTokens(pairingTokens, auditor));
  const run = (): void => {
    try { auditor.runAudit(); }
    catch (error) { logger.warn('pairing token audit failed', { error: error instanceof Error ? error.message : String(error) }); }
  };
  run();
  const schedule = options.setInterval ?? ((fn, ms) => { const timer = setInterval(fn, ms); timer.unref?.(); return timer; });
  const cancel = options.clearInterval ?? ((handle) => clearInterval(handle as ReturnType<typeof setInterval>));
  const handle = schedule(run, options.intervalMs ?? PAIRING_TOKEN_AUDIT_INTERVAL_MS);
  return () => {
    cancel(handle);
    auditor.setTokenSource(undefined);
  };
}
