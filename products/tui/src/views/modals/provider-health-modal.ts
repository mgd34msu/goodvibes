import type { ConfigModalActionContext, ConfigModalRow, ConfigModalSurface, ConfigModalView } from '../../input/config-modal-types.ts';
import type { UiReadModel, UiProvidersSnapshot } from '../../runtime/ui-read-models.ts';
import type { ProviderRuntimeSnapshot } from '@goodvibes-jev/engine/platform/platform/providers';
import { buildAccountPosture, isRouteUsable } from '../provider-health-routes.ts';
import { buildProviderHealthDomainSummaries, type ProviderHealthDomainInputs } from '../provider-health-domains.ts';
import { toneStyle, statusGlyph, pad, postureLine, kv, runModalCommand } from './modal-surface-helpers.ts';
import { summarizeError } from '@goodvibes-jev/engine/platform/platform/utils/native-error-summary';

/** The slice of ProviderRuntimeInspectionQuery this surface consumes. */
export interface ProviderRuntimeInspect {
  listProviderIds(): readonly string[];
  inspectAll(): Promise<readonly ProviderRuntimeSnapshot[]>;
}

/**
 * Provider-health config-modal surface (migrated from the `provider-health`
 * view; also the target of the `providers` and `accounts` redirects).
 * providerRuntime.inspectAll() is async, so its result is cached; it is
 * re-inspected on open, on `r`, after a repair and when the providers read
 * model reports a change, never on a timer. buildView reads the cache
 * synchronously so live values update in place with a stable layout.
 *
 * The Domains tab reads eight subsystem snapshots (the security one runs a token
 * audit), so its rows are built only while that tab is shown, and then kept
 * until one of those read models reports a change or `r` is pressed, not on
 * every render. A provider change that arrives while an inspection is running
 * is answered by one more inspection when that one ends.
 *
 * Auth-route descriptors and the eight repair domains are presented through
 * the engine-owned pure posture builders. Credential-backed account commands
 * and the existing Enter repair dispatch retain their separate responsibilities.
 */
class ProviderHealthModalSurface implements ConfigModalSurface {
  readonly name = 'providers-modal';
  readonly title = 'Providers';
  private requestRender: () => void = () => {};
  private cache = new Map<string, ProviderRuntimeSnapshot>();
  private unsubs: Array<() => void> = [];
  private loaded = false;
  private inspectionError: string | null = null;
  private inspectionGeneration = 0;
  private pendingInspection: number | null = null;
  private opened = false;
  /** Domains tab rows as last built; null = build again when the tab is next shown. */
  private domainRows: ConfigModalRow[] | null = null;
  /** The tab the last view was built for; undefined before the first one is shown. */
  private shownTab: string | undefined;
  /** A provider change arrived during the running inspection, so one more follows it. */
  private inspectAgain = false;

  constructor(
    private readonly providerRuntime: ProviderRuntimeInspect,
    private readonly providersReadModel?: UiReadModel<UiProvidersSnapshot>,
    private readonly domainInputs?: () => ProviderHealthDomainInputs,
    /** Subscribe to the read models behind `domainInputs`; the listener marks the Domains rows stale. */
    private readonly subscribeDomains?: (listener: () => void) => () => void,
  ) {}

  readonly actions = [
    {
      key: 'enter', id: 'repair', label: 'repair',
      enabledFor: (row: ConfigModalRow | null, tabId: string) =>
        (tabId === 'health' || tabId === 'accounts') && Boolean(row?.id.startsWith('provider:')),
    },
    { key: 'r', id: 'refresh', label: 'refresh posture' },
  ];

  onOpen(requestRender: () => void): void {
    this.opened = true;
    this.requestRender = requestRender;
    this.domainRows = null;
    void this.reinspect();
    if (this.unsubs.length === 0) {
      // A provider change re-inspects; one arriving mid-inspection is answered when that one ends.
      if (this.providersReadModel) this.unsubs.push(this.providersReadModel.subscribe(() => {
        if (this.pendingInspection === null) void this.reinspect();
        else this.inspectAgain = true;
      }));
      if (this.subscribeDomains) this.unsubs.push(this.subscribeDomains(() => {
        this.domainRows = null;
        if (this.shownTab === 'domains') this.requestRender();
      }));
    }
  }

  onClose(): void {
    this.opened = false;
    this.inspectionGeneration++;
    this.pendingInspection = null;
    this.inspectAgain = false;
    this.domainRows = null;
    this.shownTab = undefined;
    for (const unsub of this.unsubs) unsub();
    this.unsubs = [];
  }

  private providerIds(): string[] {
    const ids = new Set<string>([
      ...(this.providersReadModel?.getSnapshot().providerIds ?? []),
      ...this.providerRuntime.listProviderIds(),
      ...this.cache.keys(),
    ]);
    return [...ids].sort((a, b) => a.localeCompare(b));
  }

  buildView(activeTabId?: string): ConfigModalView {
    this.shownTab = activeTabId;
    const ids = this.providerIds();
    const active = ids.filter((id) => this.cache.get(id)?.active).length;
    const header = [postureLine([
      kv('providers', ids.length),
      kv('active', active),
      kv('inspected', this.cache.size),
    ])];

    const rowFor = (id: string): ConfigModalRow => {
      const snap = this.cache.get(id);
      const isActive = Boolean(snap?.active);
      return {
        id: `provider:${id}`,
        label: `${statusGlyph(isActive ? 'good' : 'dim')} ${pad(id, 18)} ${pad(isActive ? 'ACTIVE' : 'idle', 8)} models=${snap?.modelCount ?? '—'}`,
        style: toneStyle(isActive ? 'good' : 'dim'),
      };
    };

    const rows = ids.map(rowFor);
    const routeRows = ids.flatMap((id): ConfigModalRow[] => {
      const snapshot = this.cache.get(id);
      const providerRow = { ...rowFor(id), selectable: false, header: true };
      // An uninspected provider is unknown, not an implicitly healthy account.
      if (!snapshot?.runtime?.auth) return [providerRow, {
        id: `auth:${id}:unavailable`, label: '  Auth posture unavailable', selectable: false,
      }];
      const posture = buildAccountPosture(snapshot);
      return [
        providerRow,
        { id: `auth:${id}:posture`, label: `  active=${posture.activeRoute} preferred=${posture.preferredRoute} freshness=${posture.authFreshness}`, selectable: false },
        { id: `auth:${id}:reason`, label: `  ${posture.activeRouteReason}`, selectable: false },
        ...posture.routes.map((route, index): ConfigModalRow => ({
          id: `auth:${id}:route:${index}`,
          label: `  ${route.label}: ${route.route} configured=${route.configured ? 'yes' : 'no'} usable=${isRouteUsable(route) ? 'yes' : 'no'} freshness=${route.freshness ?? 'unconfigured'}${route.detail ? `; ${route.detail}` : ''}`,
          selectable: false,
        })),
        ...posture.issues.map((issue, index): ConfigModalRow => ({ id: `auth:${id}:issue:${index}`, label: `  issue: ${issue}`, selectable: false, style: toneStyle('warn') })),
        ...posture.repairHints.map((hint, index): ConfigModalRow => ({ id: `auth:${id}:hint:${index}`, label: `  next: ${hint}`, selectable: false })),
      ];
    });
    // Built only while the Domains tab is shown; another tab keeps the last rows (or none).
    const domainRows = !this.domainInputs ? []
      : activeTabId === 'domains' ? (this.domainRows ??= this.buildDomainRows(this.domainInputs))
        : (this.domainRows ?? []);
    const emptyText = ids.length === 0
      ? (this.loaded ? 'No providers registered. Try /provider.' : 'Inspecting providers…')
      : undefined;

    return {
      title: 'Providers',
      ...(this.inspectionError !== null ? { degraded: `Provider inspection unavailable (${this.inspectionError}); showing last-known posture where available.` } : {}),
      scrollInformationalLines: true,
      tabs: [
        { id: 'health', label: 'Health', header, rows, emptyText, hints: ['r refresh posture', '/health for latency & routes'] },
        { id: 'accounts', label: 'Accounts', header, rows: ids.map(rowFor), emptyText, hints: ['Enter repair', '/accounts routes <p> for detail'] },
        { id: 'routes', label: 'Routes', header, rows: routeRows, emptyText, hints: ['↑↓ scroll details', 'Accounts tab for repair'] },
        ...(this.domainInputs ? [{ id: 'domains', label: 'Domains', rows: domainRows, hints: ['/health <domain> for detail'] }] : []),
      ],
    };
  }

  private buildDomainRows(read: () => ProviderHealthDomainInputs): ConfigModalRow[] {
    const rows: ConfigModalRow[] = [];
    try {
      for (const domain of buildProviderHealthDomainSummaries(read())) {
        rows.push(
          { id: `domain:${domain.name}`, label: `${statusGlyph(domain.level)} ${domain.name}: ${domain.summary}`, style: toneStyle(domain.level), selectable: false, header: true },
          ...domain.details.map((detail, index): ConfigModalRow => ({ id: `domain:${domain.name}:detail:${index}`, label: `  ${detail}`, selectable: false })),
          ...domain.nextSteps.map((step, index): ConfigModalRow => ({ id: `domain:${domain.name}:next:${index}`, label: `  next: ${step}`, selectable: false })),
        );
      }
    } catch (error) {
      return [{ id: 'domains:unavailable', label: `Health-domain posture unavailable: ${summarizeError(error)}`, selectable: false, style: toneStyle('warn') }];
    }
    return rows;
  }

  onAction(id: string, ctx: ConfigModalActionContext): void {
    if (id === 'refresh') {
      this.domainRows = null;
      void this.reinspect();
      ctx.setStatus('Refreshing provider posture…');
      return;
    }
    if (id === 'repair') {
      const provider = ctx.row?.id.startsWith('provider:') ? ctx.row.id.slice('provider:'.length) : null;
      if (!provider) return;
      runModalCommand(ctx, 'accounts', ['repair', provider], `/accounts repair ${provider}`, { afterSettle: () => { void this.reinspect(); } });
    }
  }

  private async reinspect(): Promise<void> {
    if (!this.opened) return;
    const generation = ++this.inspectionGeneration;
    this.pendingInspection = generation;
    // This inspection starts after any change already seen, so it answers it.
    this.inspectAgain = false;
    try {
      const snapshots = await this.providerRuntime.inspectAll();
      if (!this.opened || generation !== this.inspectionGeneration) return;
      const next = new Map<string, ProviderRuntimeSnapshot>();
      for (const s of snapshots) next.set(s.providerId, s);
      this.cache = next;
      this.inspectionError = null;
    } catch (error) {
      if (!this.opened || generation !== this.inspectionGeneration) return;
      this.inspectionError = summarizeError(error);
      // Leave the last-known cache in place; a transient inspect failure should
      // not blank the live table (honest degraded behaviour).
    } finally {
      if (!this.opened || generation !== this.inspectionGeneration) return;
      this.pendingInspection = null;
      this.loaded = true;
      this.requestRender();
      if (this.inspectAgain) {
        this.inspectAgain = false;
        void this.reinspect();
      }
    }
  }
}

export function createProviderHealthModalSurface(
  providerRuntime: ProviderRuntimeInspect,
  providersReadModel?: UiReadModel<UiProvidersSnapshot>,
  domainInputs?: () => ProviderHealthDomainInputs,
  subscribeDomains?: (listener: () => void) => () => void,
): ConfigModalSurface {
  return new ProviderHealthModalSurface(providerRuntime, providersReadModel, domainInputs, subscribeDomains);
}
