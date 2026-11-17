import { CONFIG_SCHEMA } from '../config/schema.js';
import type { ConfigKey } from '../config/schema-types.js';

/**
 * One security-relevant setting as it stands: the value read from the
 * configuration next to the schema default, and whether that value is the
 * insecure one the entry describes.
 */
export interface SecuritySettingReport {
  /** The settings key that controls this behavior. */
  readonly key: ConfigKey;
  readonly type: 'setting' | 'configuration';
  /** The schema default, as text (`safe-text`, `true`, ...). */
  readonly defaultState: string;
  /** The configured value, as text; the default when no configuration was given. */
  readonly currentState: string;
  /** The configured value itself; the default when no configuration was given. */
  readonly value: unknown;
  readonly defaultValue: unknown;
  /** Whether the current value is the one `insecureWhen` describes. */
  readonly insecure: boolean;
  readonly securityRelevant: true;
  readonly summary: string;
  readonly insecureWhen: string;
  readonly enablementEffect: string;
  readonly enablementRequirements: readonly string[];
  readonly operationalNotes: readonly string[];
}

/** Reads a setting's current value (a ConfigManager). */
export interface SecuritySettingsReader {
  get(key: ConfigKey): unknown;
}

interface SecuritySettingEntry extends Omit<SecuritySettingReport, 'defaultState' | 'currentState' | 'value' | 'defaultValue' | 'insecure'> {
  /** True for the value `insecureWhen` describes. */
  readonly isInsecure: (value: unknown) => boolean;
}

const isOff = (value: unknown): boolean => value === false;

const SECURITY_SETTINGS: readonly SecuritySettingEntry[] = [
  {
    key: 'fetch.sanitizeMode',
    type: 'setting',
    isInsecure: (value) => value === 'none',
    securityRelevant: true,
    summary: 'Controls fetch response sanitization; host trust-tier blocking is always active.',
    insecureWhen:
      'When fetch.sanitizeMode is none, response content is returned without sanitization; private-IP and cloud-metadata blocking still applies.',
    enablementEffect:
      'At safe-text (the default) or strict, unknown hosts are sanitized, explicitly blocked hosts are denied, and private/metadata targets are denied before request or redirect follow. Localhost dev servers ask once; approving saves fetch.allowLocalhost in your own settings (a project file cannot turn it on).',
    enablementRequirements: [
      'Add a host to fetch.trustedHosts only when its raw content is safe to expose to the model.',
      'Keep fetch.sanitizeMode at safe-text or strict unless the target host is explicitly trusted.',
    ],
    operationalNotes: [
      'Requests to link-local metadata endpoints and encoded private IP forms are always blocked. A private-network host is reached only when the call wrote it and fetch.allowedPrivateHosts lists it (or, written as an IP, in YOLO or an admitted call); a redirect into a private address is always refused.',
      'Redirect chains are validated hop-by-hop.',
      'Localhost fetches are refused until approved; the approval is saved as fetch.allowLocalhost in your own settings and applies to every project.',
    ],
  },
  {
    key: 'permissions.engine',
    type: 'setting',
    isInsecure: (value) => value === 'baseline',
    securityRelevant: true,
    summary: 'Selects the layered permission evaluator (policy-engine) for tool execution.',
    insecureWhen:
      'At baseline, the platform uses the baseline permission manager and does not enforce layered path/tool policy bundles.',
    enablementEffect:
      'At policy-engine, tool calls can be evaluated against granular runtime policy rules before execution.',
    enablementRequirements: [
      'Provide or load a valid permission policy.',
      'Validate policy behavior in prompt/custom modes before using enforce-heavy deployments.',
    ],
    operationalNotes: [
      'Applies at startup; set it before constructing runtime services.',
    ],
  },
  {
    key: 'policy.requireSignedBundles',
    type: 'setting',
    isInsecure: isOff,
    securityRelevant: true,
    summary: 'Controls HMAC signature validation for managed permission policy bundles.',
    insecureWhen:
      'When off, managed policy bundles are not cryptographically verified by this check.',
    enablementEffect:
      'When on, managed mode rejects policy bundles with invalid or missing signatures.',
    enablementRequirements: [
      'Provision the policy signing secret in the runtime environment or secret store.',
      'Sign policy bundles before loading them in managed mode.',
    ],
    operationalNotes: [
      'Unsigned local development bundles may need a non-managed mode or explicit signing during rollout.',
    ],
  },
  {
    key: 'permissions.simulation',
    type: 'setting',
    isInsecure: isOff,
    securityRelevant: true,
    summary: 'Runs the candidate permission evaluator beside the active evaluator without changing enforcement.',
    insecureWhen:
      'When off, operators do not receive divergence telemetry before moving to stricter permission policy enforcement.',
    enablementEffect:
      'When on (the default), the platform records evaluator divergence so clients can validate a stricter permission policy before enforcing it.',
    enablementRequirements: [
      'Review divergence diagnostics before switching enforcement modes.',
    ],
    operationalNotes: [
      'Simulation never blocks tool execution by itself; it is an observability step for permission hardening.',
    ],
  },
  {
    key: 'permissions.divergenceDashboard',
    type: 'setting',
    isInsecure: isOff,
    securityRelevant: true,
    summary: 'Surfaces permission evaluator divergence and gates enforce-mode rollout.',
    insecureWhen:
      'When off, clients may lack a first-class view of permission divergence before enabling stricter enforcement.',
    enablementEffect:
      'When on (the default), divergence by command class, prefix, and mode is exposed for diagnostics and can block unsafe enforce-mode transitions.',
    enablementRequirements: [
      'Keep permissions.simulation on so divergence data exists.',
      'Configure an acceptable divergence threshold for the host surface.',
    ],
    operationalNotes: [
      'This is a rollout-control feature; it may prevent policy promotion until divergence is resolved.',
    ],
  },
  {
    key: 'policy.registryEnabled',
    type: 'setting',
    isInsecure: isOff,
    securityRelevant: true,
    summary: 'Controls versioned permission policy bundle promotion and rollback.',
    insecureWhen:
      'When off, permission policy changes are not managed through platform-level promote/rollback controls.',
    enablementEffect:
      'When on, policy bundles can be loaded, diffed, simulated, promoted, and rolled back with recorded evidence.',
    enablementRequirements: [
      'Define a policy bundle source and promotion flow.',
      'Use permissions.simulation and policy.requireSignedBundles for high-assurance managed deployments.',
    ],
    operationalNotes: [
      'Operational clients need to handle policy promotion failures and rollback states.',
    ],
  },
  {
    key: 'runtime.toolBudget.enforced',
    type: 'setting',
    isInsecure: isOff,
    securityRelevant: true,
    summary: 'Controls runtime budget enforcement for tool execution pipelines.',
    insecureWhen:
      'When off, a tool call runs as long as it takes, and one over a token or cost limit is not reported as failed.',
    enablementEffect:
      'When on, a tool call is stopped at its wall-clock limit and the model is told so; a call that finishes over its token or cost limit is reported as failed, with its output kept and a note that its action may have taken effect.',
    enablementRequirements: [
      'Configure appropriate budget limits (runtime.toolBudget.maxMs/maxTokens/maxCostUsd) for the host surface.',
      'Ensure callers handle budget-exceeded tool errors as normal failures.',
    ],
    operationalNotes: [
      'Long-running tools or large batch operations may fail earlier once budgets are enforced.',
    ],
  },
  {
    key: 'security.tokenAudit.enabled',
    type: 'setting',
    isInsecure: isOff,
    securityRelevant: true,
    summary: 'Audits API tokens for excessive scopes and stale rotation cadence.',
    insecureWhen:
      'When off, token scope and age findings are not reported at all; when on without security.tokenAudit.managed, findings are advisory only.',
    enablementEffect:
      'When on (the default) with security.tokenAudit.managed, tokens with excess scopes or expired rotation windows can be blocked from use.',
    enablementRequirements: [
      'Define expected token scopes for the deployed integrations.',
      'Configure rotation cadence and managed-mode policy before relying on blocking behavior.',
    ],
    operationalNotes: [
      'In managed mode, tokens that currently work may be blocked if they are over-scoped or overdue for rotation.',
    ],
  },
  {
    key: 'permissions.commandParser',
    type: 'setting',
    isInsecure: (value) => value === 'flat',
    securityRelevant: true,
    summary: 'Controls the parse that refuses an exec command with nothing to run, just before it runs (default ast).',
    insecureWhen:
      'At flat, the parse is skipped: a command in which a segment has nothing to run reaches the shell and fails there instead of being refused with that segment named. Risk decisions do not change; the permission gate makes them in both modes.',
    enablementEffect:
      'At ast (the default), each exec command is parsed into segments just before it runs, and a command in which a segment (or the whole command) has nothing to run is refused, naming that segment. The parse does not decide risk: the permission gate has already decided every command, including the catastrophic-command block, in both modes. When the parser cannot read a command (a parse error), the command runs as the gate decided.',
    enablementRequirements: [
      'None, ast is the default and remains runtime-switchable.',
      'Set permissions.commandParser to flat to skip the parse.',
    ],
    operationalNotes: [
      'A refusal from this parse lists every segment and says which one has nothing to run.',
      'Permission verdicts and their denial explanations come from the permission gate and are the same at ast and flat.',
    ],
  },
];

export function getSecuritySettingsReport(
  config: SecuritySettingsReader | null | undefined,
): SecuritySettingReport[] {
  return SECURITY_SETTINGS.map(({ isInsecure, ...setting }) => {
    const defaultValue = CONFIG_SCHEMA.find((entry) => entry.key === setting.key)?.default;
    const value = config ? readSetting(config, setting.key, defaultValue) : defaultValue;
    return {
      ...setting,
      defaultState: String(defaultValue),
      currentState: String(value),
      value,
      defaultValue,
      insecure: isInsecure(value),
    };
  });
}

function readSetting(config: SecuritySettingsReader, key: ConfigKey, fallback: unknown): unknown {
  try {
    return config.get(key) ?? fallback;
  } catch {
    return fallback;
  }
}
