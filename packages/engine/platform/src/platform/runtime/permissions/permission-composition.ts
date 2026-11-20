import type { AutonomousToolPromptHost } from './autonomous-tool-prompts.js';
/**
 * Shared permission composition for client and daemon graphs: durable owner
 * rules, PermissionManager, sandbox escalation and owned tool sub-operations.
 * Canonical localhost/PTY callbacks carry the recorded autonomous owner and
 * explicit workspace constraint. Sandbox escalations carry a final-spawn permit.
 * The broker callback remains for compatibility APIs outside autonomous calls.
 */

import { logger } from '../../utils/logger.js';
import { summarizeError } from '../../utils/error-display.js';
import type { ConfigManager } from '../../config/manager.js';
import type { SecretsManager } from '../../config/secrets.js';
import type { PermissionPromptDecision, PermissionPromptRequest } from '../../permissions/prompt.js';
import { callingAgentId } from '../../agents/calling-agent.js';
import type { GatePresetName } from '../../gate/presets.js';
import { PermissionManager, createPermissionConfigReader } from '../../permissions/manager.js';
import { ownerPermissionRulesPath, UserPermissionRuleStore } from '../../permissions/user-rule-store.js';
import type { HookDispatcher } from '../../hooks/index.js';
import { isFeatureGateEnabled, type FeatureFlagManager } from '../feature-flags/index.js';
import {
  createSandboxContainmentAnnouncer,
  type FeatureAnnouncementStore,
} from '../feature-announcements.js';
import { PolicyRuntimeState } from './policy-runtime.js';
import { PolicyRegistry } from './policy-registry.js';
import { loadConfiguredPolicyBundle } from './policy-config-loader.js';
import { buildSandboxEscalationHandler, type ExecSandboxEscalationHandler } from './sandbox-escalation-wiring.js';
import { buildExecPromptAnswerHandler, type ExecPromptAnswerHandler } from './exec-prompt-wiring.js';
import { buildLocalhostFetchApproval, type LocalhostFetchApproval } from './localhost-fetch-approval.js';

/**
 * Raise an approval ask and wait for the decision.
 *
 * The one seam that separates an embedded composition from a client one: a
 * daemon-grade graph passes its `ApprovalBroker.requestApproval`; a pure client
 * passes a function that posts the ask to the daemon (`approvals.raise`) while
 * prompting on this surface.
 */
export type ApprovalRaiser = (input: {
  readonly request: import('../../permissions/prompt.js').PermissionPromptRequest;
  /** In-process cancellation, excluded from persisted/wire request data. */
  readonly signal?: AbortSignal | undefined;
  readonly routeId?: string | undefined;
  readonly metadata?: Record<string, unknown> | undefined;
}) => Promise<PermissionPromptDecision>;

/**
 * The slice of the durable rule store a permission manager actually uses:
 * read the remembered rules, add a newly remembered one. Typed as this rather
 * than the concrete `UserPermissionRuleStore` so a surface can remember its own
 * approvals locally while the daemon keeps the canonical `permissions.rules.*`
 * store, the two are the same contract, and neither has to be the other.
 */
export type UserPermissionRuleAccess = Pick<UserPermissionRuleStore, 'rules' | 'add'>
  & Partial<Pick<UserPermissionRuleStore, 'init' | 'awaitReady' | 'getPublicationRevision'>>;

/**
 * Build the durable user-origin permission-rule store at the control-plane
 * config dir, initialising in the background. Init failure is deliberately
 * non-fatal: asks then prompt instead of matching a remembered rule.
 */
export function createUserPermissionRuleStore(
  configManager: Pick<ConfigManager, 'getControlPlaneConfigDir' | 'getHomeDirectory'>,
): UserPermissionRuleStore {
  const store = new UserPermissionRuleStore(ownerPermissionRulesPath(configManager));
  void store.init().catch((error) => logger.warn('user permission rule store init failed; asks will prompt', { error: summarizeError(error) }));
  return store;
}

/**
 * Build the policy runtime state and load whatever bundle config names.
 *
 * With `policy.requireSignedBundles` on, every bundle must carry a valid HMAC-SHA256 signature
 * made with the key in `GOODVIBES_POLICY_SIGNING_KEY` (hex, at least 16 bytes). With no key the
 * bundle is refused, never loaded unverified.
 */
export function createPolicyRuntimeState(
  configManager: ConfigManager,
  featureFlags: FeatureFlagManager,
  env: Readonly<Record<string, string | undefined>> = process.env,
): PolicyRuntimeState {
  const signingKey = env['GOODVIBES_POLICY_SIGNING_KEY']?.trim();
  const policyRuntimeState = new PolicyRuntimeState(new PolicyRegistry({
    loaderOptions: {
      featureFlags,
      managed: isFeatureGateEnabled(featureFlags, 'policy-signing'),
      ...(signingKey ? { signingKey } : {}),
      provenanceSource: 'local-file',
    },
  }));
  loadConfiguredPolicyBundle(configManager, featureFlags, policyRuntimeState);
  return policyRuntimeState;
}

export interface BrokeredPermissionManagerOptions {
  readonly workspaceTrust?: AutonomousToolPromptHost['workspaceTrust'];
  readonly requestApproval: ApprovalRaiser;
  readonly configManager: ConfigManager;
  readonly policyRuntimeState: PolicyRuntimeState;
  readonly hookDispatcher: HookDispatcher;
  readonly featureFlags: FeatureFlagManager;
  readonly userRuleStore: UserPermissionRuleAccess | null;
  /** Reads what the owner's stored webhook destinations name, for the recipient check. */
  readonly secretsManager?: Pick<SecretsManager, 'resolveLocalSecretSync'> | null | undefined;
  /** The session the call being checked belongs to, read when it asks: the approval is raised under that session. */
  readonly sessionOfAsk?: (() => string | undefined) | undefined;
}

/**
 * A permission manager whose asks ride the given seam.
 *
 * Background/subagent tool calls are brokered through the SAME session
 * permission mode as the foreground turn loop, so a background ask surfaces
 * through the same blocked-on-user machinery, here carrying the subagent's
 * attribution.
 */
export function createBrokeredPermissionManager(options: BrokeredPermissionManagerOptions): PermissionManager {
  return new PermissionManager(
    (asked, execution) => {
      // An ask raised inside an agent's tool call names that agent even when
      // its gate passed no attribution (the autonomous admission path), so a
      // surface, or an embedder sharing one daemon, knows whose work asks.
      const callingAgent = asked.attribution === undefined ? callingAgentId() : undefined;
      const request: PermissionPromptRequest = callingAgent === undefined
        ? asked
        : { ...asked, attribution: { kind: 'background-agent', agentId: callingAgent } };
      const sessionId = options.sessionOfAsk?.();
      return options.requestApproval({
        request,
        ...(execution?.signal === undefined ? {} : { signal: execution.signal }),
        ...(sessionId === undefined ? {} : { sessionId }),
        ...(request.attribution?.kind === 'background-agent'
          ? {
              routeId: request.attribution.agentId,
              metadata: {
                source: 'background-agent',
                agentId: request.attribution.agentId,
                ...(request.attribution.template ? { agentTemplate: request.attribution.template } : {}),
              },
            }
          : {}),
      });
    },
    createPermissionConfigReader(options.configManager, options.secretsManager ?? null),
    options.policyRuntimeState,
    options.hookDispatcher,
    options.featureFlags,
    options.userRuleStore,
    { workspaceTrust: options.workspaceTrust },
  );
}

export interface ApprovalDerivedHandlerOptions {
  readonly autonomousHost?: AutonomousToolPromptHost | undefined;
  readonly requestApproval: ApprovalRaiser;
  readonly configManager: ConfigManager;
  readonly featureFlags: FeatureFlagManager;
  /** Announce-once store backing the containment receipt. */
  readonly announcementStore: Pick<FeatureAnnouncementStore, 'recordOnce'>;
  /**
   * Whether a person can answer on this surface now: a terminal app, or a
   * hosted session with a client attached. Read when a model's run meets
   * something only a person can answer. Absent: no one is attached.
   */
  readonly attended?: (() => boolean) | undefined;
  /** The permission mode the current call runs under; absent reads as ask-me. */
  readonly permissionMode?: (() => GatePresetName) | undefined;
}

/** The handlers that must ride the same ask seam as a tool permission. */
export interface ApprovalDerivedHandlers {
  readonly sandboxEscalationHandler: ExecSandboxEscalationHandler;
  readonly execPromptAnswerHandler: ExecPromptAnswerHandler;
  readonly localhostFetchApproval: LocalhostFetchApproval;
  readonly onSandboxedRun: () => void;
}

export function createApprovalDerivedHandlers(options: ApprovalDerivedHandlerOptions): ApprovalDerivedHandlers {
  // One rule for what a model's run may put to the person at the surface. A
  // terminal prompt (a passphrase, a package name) is something only the person
  // knows, so it is asked in every mode but just-vibes, which never interrupts.
  // The localhost one-tap ask saves a standing grant, so it replaces Jev's
  // per-hop admission only in ask-me; the other modes keep the per-hop admission.
  const attended = options.attended;
  const mode = (): GatePresetName => options.permissionMode?.() ?? 'ask-me';
  const promptAttended = attended ? (): boolean => attended() && mode() !== 'just-vibes' : undefined;
  const localhostAttended = attended ? (): boolean => attended() && mode() === 'ask-me' : undefined;
  // The same recorded owner admits exact sandbox plans; final spawn consumes
  // the permit without widening argv, network, or filesystem containment.
  const sandboxEscalationHandler = buildSandboxEscalationHandler({
    autonomousHost: options.autonomousHost,
    requestApproval: options.requestApproval,
    configManager: options.configManager,
    featureFlags: options.featureFlags,
  });
  // An exec command blocked on a terminal prompt (host-key confirmation,
  // credential ask) rides the same seam: the pending prompt surfaces through
  // every surface's approval machinery and the typed answer feeds the same
  // continuing run.
  const execPromptAnswerHandler = buildExecPromptAnswerHandler({
    autonomousHost: options.autonomousHost,
    attended: promptAttended,
    requestApproval: options.requestApproval,
  });
  // Localhost dev-server fetches ride the same seam: ask once; approving
  // saves fetch.allowLocalhost in the user's own settings.
  const localhostFetchApproval = buildLocalhostFetchApproval({
    autonomousHost: options.autonomousHost,
    attended: localhostAttended,
    requestApproval: options.requestApproval,
    configManager: options.configManager,
  });
  // Announce-once receipts for default-on features: the first contained exec
  // run yields the one-time containment line (persisted, once per install).
  const onSandboxedRun = createSandboxContainmentAnnouncer(options.announcementStore, (announcement) => {
    logger.info(announcement.text, { announcement: announcement.id });
  });
  return { sandboxEscalationHandler, execPromptAnswerHandler, localhostFetchApproval, onSandboxedRun };
}
