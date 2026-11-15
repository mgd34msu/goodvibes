import type { DomainVerbosity } from '../runtime/notifications/types.js';
import type { FeatureFlagReader } from '../runtime/feature-flags/index.js';
import { isFeatureGateEnabled, requireFeatureGate } from '../runtime/feature-flags/index.js';

// ---------------------------------------------------------------------------
// How much the terminal apps print: the one setting `behavior.hitlMode`.
// quiet prints less (only warnings and errors toast; routine notifications
// wait in the history), balanced is the default, operator prints everything.
// ---------------------------------------------------------------------------

export type HITLMode = 'quiet' | 'balanced' | 'operator';

export interface HITLModeDefinition {
  name: HITLMode;
  description: string;
  defaultDomainVerbosity: DomainVerbosity;
  quietWhileTyping: boolean;
  batchWindowMs: number;
}

export const HITL_QUIET: HITLModeDefinition = {
  name: 'quiet',
  description: 'Prints less: only warnings and errors toast; routine notices and notifications go to the history (/notifications). Batches updates in 5s windows.',
  defaultDomainVerbosity: 'minimal',
  quietWhileTyping: true,
  batchWindowMs: 5_000,
};

export const HITL_BALANCED: HITLModeDefinition = {
  name: 'balanced',
  description: 'Default: notices toast, routine notifications go to the history. Batches updates in 2s windows.',
  defaultDomainVerbosity: 'normal',
  quietWhileTyping: true,
  batchWindowMs: 2_000,
};

export const HITL_OPERATOR: HITLModeDefinition = {
  name: 'operator',
  description: 'Prints everything: every notice and notification toasts, immediately, even while you type.',
  defaultDomainVerbosity: 'verbose',
  quietWhileTyping: false,
  batchWindowMs: 500,
};

const HITL_PRESETS: HITLModeDefinition[] = [HITL_QUIET, HITL_BALANCED, HITL_OPERATOR];

/** The router setters a print level reaches. */
export interface PrintLevelRouter {
  setQuietWhileTyping(enabled: boolean): void;
  setBatchWindowMs?(ms: number): void;
  setDefaultDomainVerbosity?(verbosity: DomainVerbosity): void;
  setDomainVerbosity(domain: string, verbosity: DomainVerbosity): void;
}

// ---------------------------------------------------------------------------
// ModeManager
// ---------------------------------------------------------------------------

export class ModeManager {
  private readonly featureFlags: FeatureFlagReader;

  private hitlMode: HITLMode = 'balanced';
  private domainOverrides: Map<string, DomainVerbosity> = new Map();
  /** Routers kept on this mode: applied when attached and after every change. */
  private readonly routers = new Set<PrintLevelRouter>();
  /** Domains given their own verbosity on the routers, so a later mode puts them back on its default. */
  private readonly routedDomains = new Set<string>();

  constructor(options: { readonly featureFlags?: FeatureFlagReader } = {}) {
    this.featureFlags = options.featureFlags ?? null;
  }

  private hitlEnabled(): boolean {
    return isFeatureGateEnabled(this.featureFlags, 'hitl-ux-modes');
  }

  private requireHitlEnabled(operation: string): void {
    requireFeatureGate(this.featureFlags, 'hitl-ux-modes', operation);
  }

  // -------------------------------------------------------------------------
  // HITL UX mode API.
  // -------------------------------------------------------------------------

  getHITLMode(): HITLMode {
    if (!this.hitlEnabled()) return 'balanced';
    return this.hitlMode;
  }

  getHITLPreset(): HITLModeDefinition {
    if (!this.hitlEnabled()) return HITL_BALANCED;
    return HITL_PRESETS.find((p) => p.name === this.hitlMode) ?? HITL_BALANCED;
  }

  /**
   * Switch the active HITL mode.
   *
   * Switching modes clears all per-domain verbosity overrides that may have
   * been set via {@link setDomainVerbosity}. This ensures the new mode's
   * `defaultDomainVerbosity` applies uniformly until the caller re-establishes
   * any domain-specific overrides.
   */
  setHITLMode(mode: HITLMode): void {
    this.requireHitlEnabled('set HITL UX mode');
    const found = HITL_PRESETS.find((p) => p.name === mode);
    if (!found) {
      const available = HITL_PRESETS.map((p) => `"${p.name}"`).join(', ');
      throw new Error(`Unknown HITL mode: "${mode}". Available: ${available}`);
    }
    this.hitlMode = mode;
    this.domainOverrides.clear();
    this.applyToRouters();
  }

  listHITLPresets(): HITLModeDefinition[] {
    if (!this.hitlEnabled()) return [];
    return [...HITL_PRESETS];
  }

  setDomainVerbosity(domain: string, verbosity: DomainVerbosity): void {
    this.requireHitlEnabled('set HITL domain verbosity');
    this.domainOverrides.set(domain, verbosity);
    this.applyToRouters();
  }

  /** Keep a notification router on this mode: applied now and after every change. Returns the detach function. */
  attachRouter(router: PrintLevelRouter): () => void {
    this.routers.add(router);
    this.applyToRouter(router);
    return () => { this.routers.delete(router); };
  }

  private applyToRouters(): void {
    for (const router of this.routers) this.applyToRouter(router);
  }

  getDomainVerbosity(domain: string): DomainVerbosity {
    if (!this.hitlEnabled()) return HITL_BALANCED.defaultDomainVerbosity;
    return this.domainOverrides.get(domain) ?? this.getHITLPreset().defaultDomainVerbosity;
  }

  getDomainOverrides(): Record<string, DomainVerbosity> {
    if (!this.hitlEnabled()) return {};
    return Object.fromEntries(this.domainOverrides);
  }

  /**
   * Push the mode into a notification router: batch window, default and
   * per-domain verbosity. Quiet-while-typing is not a per-mode constant: the
   * host sets it from the prompt's real typing state at each notification
   * (getHITLPreset().quietWhileTyping says whether this mode allows it), so
   * here it is cleared.
   */
  applyToRouter(router: PrintLevelRouter): void {
    const preset = this.getHITLPreset();
    const overrides = this.getDomainOverrides();
    router.setQuietWhileTyping(false);
    router.setBatchWindowMs?.(preset.batchWindowMs);
    router.setDefaultDomainVerbosity?.(preset.defaultDomainVerbosity);
    for (const domain of this.routedDomains) {
      if (!(domain in overrides)) router.setDomainVerbosity(domain, preset.defaultDomainVerbosity);
    }
    for (const [domain, verbosity] of Object.entries(overrides)) {
      router.setDomainVerbosity(domain, verbosity);
      this.routedDomains.add(domain);
    }
  }
}
