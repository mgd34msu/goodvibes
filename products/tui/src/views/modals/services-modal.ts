import type { ConfigModalActionContext, ConfigModalSurface, ConfigModalView } from '../../input/config-modal-types.ts';
import type { ServiceInspectionQuery, SubscriptionAccessQuery } from '@/runtime/index.ts';
import type { ProviderSubscription, ServiceConfig, ServiceInspection, ServiceConnectionTestResult } from '@goodvibes/engine/platform/platform/config';
import { subscriptionState } from '@goodvibes/engine/platform/platform/config';
import { summarizeError } from '@goodvibes/engine/platform/platform/utils/native-error-summary';
import { toneStyle, statusGlyph, pad, postureLine, kv, type Tone } from './modal-surface-helpers.ts';

interface Entry {
  readonly name: string;
  readonly inspection: ServiceInspection | null;
  lastTest?: ServiceConnectionTestResult;
}

function statusLabel(e: Entry): string {
  if (!e.inspection) return 'INSPECT FAILED';
  if (!e.inspection.hasPrimaryCredential) return 'UNCONFIGURED';
  if (e.lastTest?.ok) return 'HEALTHY';
  if (e.lastTest && !e.lastTest.ok) return 'ERROR';
  return 'CONFIGURED';
}

function statusTone(e: Entry): Tone {
  const label = statusLabel(e);
  if (label === 'HEALTHY') return 'good';
  if (label === 'ERROR' || label === 'INSPECT FAILED') return 'bad';
  if (label === 'CONFIGURED') return 'warn';
  return 'dim';
}

function statusDotTone(e: Entry): Tone {
  const label = statusLabel(e);
  if (label === 'HEALTHY') return 'good';
  if (label === 'ERROR' || label === 'INSPECT FAILED') return 'bad';
  return 'dim';
}

/** `subscriptions` is the store read once for the whole view, keyed by provider. */
function authSummary(config: ServiceConfig, subscriptions: ReadonlyMap<string, ProviderSubscription>): string {
  const provider = config.providerId ?? config.name;
  const record = subscriptions.get(provider);
  const hasOverride = record?.overrideAmbientApiKeys === true;
  switch (config.authType) {
    case 'bearer': return hasOverride ? 'bearer+subscription' : 'bearer';
    case 'basic': return 'basic';
    case 'api-key': return hasOverride ? 'oauth-override' : config.apiKeyHeader ? `api-key:${config.apiKeyHeader}` : 'api-key';
    case 'oauth': {
      const subscription = subscriptions.get(provider);
      if (!subscription) return 'oauth';
      const state = subscriptionState(subscription);
      return state === 'expired' || state === 'revoked' ? `oauth(${state}, sign in again)` : `oauth(${state})`;
    }
  }
}

/**
 * Services config-modal surface (migrated from the `services` view). Reads the
 * same ServiceInspectionQuery, getAll() is sync but inspect()/testConnection()
 * are async, so an inspection cache is refreshed on open / `r` and read
 * synchronously by buildView (mirrors the earlier view's own refresh contract).
 * Actions map onto their existing behaviours; `s` jumps to the subscription
 * surface, `t`/`T` run the same live connection tests, `r` re-inspects.
 *
 * One run at a time: `run` is the refresh or test in progress, with a token. A
 * key that would start another while one runs is answered with its progress,
 * a result is applied only while its token is current, and closing the modal
 * drops the token so a pass still in flight stops and paints nothing.
 */
class ServicesModalSurface implements ConfigModalSurface {
  readonly name = 'services-modal';
  readonly title = 'Services';
  private entries: Entry[] = [];
  private loading = false;
  private error = '';
  private requestRender: () => void = () => {};
  /** The refresh or test running now; null when idle. */
  private run: { readonly token: number; readonly kind: 'refresh' | 'test'; done: number; readonly total: number } | null = null;
  private nextToken = 0;

  constructor(
    private readonly registry: ServiceInspectionQuery,
    private readonly manager: SubscriptionAccessQuery,
  ) {}

  readonly actions = [
    { key: 'r', id: 'refresh', label: 'refresh' },
    { key: 't', id: 'test', label: 'test' },
    { key: 'T', id: 'test-all', label: 'test all' },
    { key: 's', id: 'subscription', label: 'subscription' },
  ];

  onOpen(requestRender: () => void): void {
    this.requestRender = requestRender;
    // Every open re-inspects: a connection test from an earlier visit may predate a
    // credential or base-URL change, so it is dropped before the first paint.
    this.entries = this.entries.map((e) => ({ name: e.name, inspection: e.inspection }));
    this.run = null;
    void this.refresh();
  }

  onClose(): void {
    this.run = null;
    this.loading = false;
  }

  /** Claim the one run slot, or say what is running and refuse. */
  private begin(kind: 'refresh' | 'test', total: number, ctx?: ConfigModalActionContext): number | null {
    if (this.run) {
      ctx?.setStatus(this.run.kind === 'refresh'
        ? 'A refresh is in progress; wait for it to finish.'
        : `A test is in progress (${this.run.done}/${this.run.total}); wait for it to finish.`);
      return null;
    }
    const token = ++this.nextToken;
    this.run = { token, kind, done: 0, total };
    return token;
  }

  private current(token: number): boolean {
    return this.run?.token === token;
  }

  buildView(): ConfigModalView {
    const counts = { healthy: 0, error: 0, unconfigured: 0 };
    for (const e of this.entries) {
      const label = statusLabel(e);
      if (label === 'HEALTHY') counts.healthy++;
      else if (label === 'ERROR') counts.error++;
      else if (label !== 'CONFIGURED') counts.unconfigured++;
    }
    const header = [postureLine([
      kv('services', this.entries.length),
      kv('healthy', counts.healthy),
      kv('errors', counts.error),
      kv('unconfigured', counts.unconfigured),
    ])];

    const subscriptions = new Map(this.manager.list().map((record) => [record.provider, record] as const));
    const rows = this.entries.map((e) => {
      const auth = e.inspection ? authSummary(e.inspection.config, subscriptions) : 'n/a';
      const base = e.inspection ? (e.inspection.config.baseUrl ?? '(no baseUrl)') : '(inspection failed)';
      return {
        id: `svc:${e.name}`,
        label: `${statusGlyph(statusDotTone(e))} ${pad(e.name, 16)} ${pad(statusLabel(e), 13)} ${pad(auth, 18)} ${base}`,
        style: toneStyle(statusTone(e)),
      };
    });

    const progress = this.run?.kind === 'test' ? ` (testing ${this.run.done}/${this.run.total}…)` : this.loading ? ' (refreshing…)' : '';
    return {
      title: this.loading && this.entries.length === 0 ? 'Services (loading…)' : `Services${progress}`,
      degraded: this.error || undefined,
      tabs: [{
        id: 'services',
        label: 'Services',
        header,
        rows,
        emptyText: this.loading ? 'Loading configured services…' : 'No services configured. Try /services check.',
      }],
    };
  }

  onAction(id: string, ctx: ConfigModalActionContext): void {
    if (id === 'refresh') void this.refresh(ctx);
    else if (id === 'test') void this.testOne(ctx);
    else if (id === 'test-all') void this.testAll(ctx);
    else if (id === 'subscription') ctx.openModal?.('subscription-modal');
  }

  private nameOf(rowId: string | undefined): string | null {
    return rowId?.startsWith('svc:') ? rowId.slice('svc:'.length) : null;
  }

  private async refresh(ctx?: ConfigModalActionContext): Promise<void> {
    const token = this.begin('refresh', 1, ctx);
    if (token === null) return;
    this.loading = true;
    this.error = '';
    this.requestRender();
    try {
      const configs = this.registry.getAll();
      const unreadable = this.registry.unreadableReason?.() ?? null;
      const names = Object.keys(configs).sort((a, b) => a.localeCompare(b));
      const inspections = await Promise.all(names.map(async (name) => ({ name, inspection: await this.registry.inspect(name) })));
      if (!this.current(token)) return;
      if (unreadable) this.error = `Service list unusable: ${unreadable}`;
      // A re-inspection drops earlier connection tests: the credential or base URL
      // may have changed since, and a stale HEALTHY must not read as current.
      this.entries = inspections;
    } catch (e) {
      if (!this.current(token)) return;
      this.error = `Refresh failed: ${summarizeError(e)}`;
    }
    this.run = null;
    this.loading = false;
    this.requestRender();
  }

  private async testOne(ctx: ConfigModalActionContext): Promise<void> {
    const name = this.nameOf(ctx.row?.id);
    if (!name) return;
    const token = this.begin('test', 1, ctx);
    if (token === null) return;
    ctx.setStatus(`Testing ${name}…`);
    this.requestRender();
    let status: string;
    try {
      const result = await this.registry.testConnection(name);
      if (!this.current(token)) return;
      this.entries = this.entries.map((e) => (e.name === name ? { ...e, lastTest: result } : e));
      status = `${name}: ${result.ok ? 'ok' : `failed (${result.status ?? 'n/a'})`}`;
    } catch (e) {
      if (!this.current(token)) return;
      status = `Test of ${name} failed: ${summarizeError(e)}`;
    }
    this.run = null;
    ctx.setStatus(status);
    this.requestRender();
  }

  private async testAll(ctx: ConfigModalActionContext): Promise<void> {
    const names = this.entries.map((entry) => entry.name);
    const token = this.begin('test', names.length, ctx);
    if (token === null) return;
    const failures: string[] = [];
    ctx.setStatus(`Testing ${names.length} service(s)…`);
    this.requestRender();
    for (const name of names) {
      let failure: string | null = null;
      try {
        const result = await this.registry.testConnection(name);
        if (!this.current(token)) return;
        this.entries = this.entries.map((e) => (e.name === name ? { ...e, lastTest: result } : e));
        if (!result.ok) failure = `${name} (${result.status ?? 'n/a'})`;
      } catch (e) {
        if (!this.current(token)) return;
        failure = `${name}: ${summarizeError(e)}`;
      }
      if (failure) failures.push(failure);
      this.run!.done++;
      this.requestRender();
    }
    this.run = null;
    ctx.setStatus(failures.length === 0
      ? `Tested ${names.length} service(s): all ok.`
      : `Tested ${names.length} service(s): ${failures.length} failed: ${failures.join('; ')}`);
    this.requestRender();
  }
}

export function createServicesModalSurface(
  registry: ServiceInspectionQuery,
  manager: SubscriptionAccessQuery,
): ConfigModalSurface {
  return new ServicesModalSurface(registry, manager);
}
