/**
 * A program's health and `/status`, described once for both terminal apps.
 *
 * Whether this program is working is the System capabilities `health.*`
 * (capabilities/builtin/system-program.ts): what needs attention, one area in
 * detail, a problem described, this session's failure reports, the runtime
 * store and the connected host's compatibility. Each runs in the program with
 * its own services (`healthServicesOf` binds this program's policy), from the
 * System place's Health tab and a model's `capability_run`.
 */
import { defineCommand, type DescribedCommand } from './command-actions/define.js';
import { defineList, type ListRow } from './command-actions/lists.js';
import type { CommandActionContext, CommandReport } from './command-actions/types.js';
import { sessionCapabilityAction } from './command-actions/capability-actions.js';
import { renderCommandReport } from './command-actions/report.js';
import {
  SYSTEM_STATUS, type FailureReportView, type HealthArea, type SystemHealthServices, type SystemSessionServices,
} from '@goodvibes/engine/platform/platform/capabilities';
// The remote runners as both programs' health and setup checks read them: the daemon's (remote-health.ts).
export { readRemoteRunnersHealth, type RemoteRunnersHealth } from './remote-health.js';
// The areas "Check one area" offers: the capability's own list (capabilities/builtin/system-program.ts).
export { HEALTH_AREAS, type FailureReportView, type HealthArea } from '@goodvibes/engine/platform/platform/capabilities';

/**
 * What a piece of a program's own work prints, as text: the work runs with a context whose print collects the lines
 * (and which cannot redraw a line in place), and the lines come back with what the work returned. The System
 * capabilities that run in the program return words (capabilities/builtin/system-program.ts); older work printed them.
 */
export async function printedText<Ctx extends { print(message: string): void }>(
  ctx: Ctx,
  work: (ctx: Ctx) => Promise<unknown> | unknown,
): Promise<string> {
  const lines: string[] = [];
  const collecting = { ...ctx, print: (message: string) => { lines.push(message); }, printLive: undefined } as Ctx;
  const said = await work(collecting);
  if (typeof said === 'string' && said.trim() !== '') lines.push(said);
  return lines.join('\n');
}

/** What `/forensics` and `/incident` read: this session's failure reports. */
interface FailureReportRecord {
  readonly id: string;
  readonly classification: string;
  readonly summary: string;
  readonly generatedAt: number;
}
interface FailureReportsHolder {
  readonly extensions?: { readonly forensicsRegistry?: { getAll(): readonly FailureReportRecord[] } | null | undefined } | undefined;
}

// This session's failure reports, newest first: the list `health.failure-reports` the capabilities' report input names.
defineList<CommandActionContext>({
  name: 'health.failure-reports',
  async read(ctx) {
    const registry = (ctx as CommandActionContext & FailureReportsHolder).extensions?.forensicsRegistry;
    if (!registry) return [];
    return [...registry.getAll()].sort((a, b) => b.generatedAt - a.generatedAt).map((report): ListRow => ({
      value: report.id, label: report.summary || report.classification,
      detail: `${report.classification} · ${new Date(report.generatedAt).toLocaleString()}`,
    }));
  },
  operator: { terminalOnly: 'Failure reports are kept by the terminal app for its own session.' },
});


/** What each app does for its health. An optional part an app does not have is refused with `elsewhere`. */
export interface HealthCommandPolicy<Ctx> {
  /** The short status: everything working, or each thing that is not with the line that fixes it. */
  readonly report: (ctx: Ctx) => Promise<CommandReport>;
  /** One area in detail; refuses an area this app does not check. */
  readonly check: (ctx: Ctx, area: HealthArea, provider: string) => Promise<string>;
  /** The runbook for a symptom, run against this app's live state (no model request). */
  readonly diagnose: (ctx: Ctx, symptom: string) => Promise<string>;
  /** The runtime store by domain, credentials masked. */
  readonly runtimeState: (ctx: Ctx, domains: readonly string[]) => string;
  /** The connected host's compatibility, where this app has one. */
  readonly compat?: ((ctx: Ctx, json: boolean) => Promise<string>) | undefined;
  readonly failures?: {
    show(ctx: Ctx, report: string, view: FailureReportView): string;
    save(ctx: Ctx, input: { readonly report: string; readonly path: string; readonly replay: boolean; readonly replace: boolean }): string;
    keep(ctx: Ctx, report: string): Promise<string>;
  } | undefined;
  /** Where the parts this app lacks are: "the terminal app (goodvibes)". */
  readonly elsewhere: string;
}

/** This program's health policy bound to its context: the services `health.*` run with (system-session.ts `health`). */
export function healthServicesOf<Ctx>(policy: HealthCommandPolicy<Ctx>, ctx: Ctx): SystemHealthServices {
  const failures = policy.failures;
  const compat = policy.compat;
  return {
    // The fix in its own words, never a line to type: the controls are in the places.
    report: async () => {
      const report = await policy.report(ctx);
      return renderCommandReport({
        ...report,
        items: report.items.map((item) => (item.fix && item.fix.line.startsWith('/') ? { sentence: item.fix.label ? `${item.sentence} ${item.fix.label}.` : item.sentence } : item)),
      });
    },
    check: (area, provider) => policy.check(ctx, area as HealthArea, provider),
    diagnose: (symptom) => policy.diagnose(ctx, symptom),
    state: (domains) => policy.runtimeState(ctx, domains),
    ...(failures ? {
      failures: {
        show: (report: string, view: FailureReportView) => failures.show(ctx, report, view),
        save: (input: Parameters<NonNullable<SystemHealthServices['failures']>['save']>[0]) => failures.save(ctx, input),
        keep: (report: string) => failures.keep(ctx, report),
      },
    } : {}),
    ...(compat ? { compat: (json: boolean) => compat(ctx, json) } : {}),
    elsewhere: policy.elsewhere,
  };
}

// `/health` is gone: the `health.*` capabilities are the System place's Health tab (run with `healthServicesOf`, from
// each program's session-capabilities.ts), and stopping a running agent is Work and agents' Your agents (agents.stop).

/**
 * `/status` for one app: the capability system.status (capabilities/builtin/system-session.ts), what each app
 * reports being its own. Typed by a person where the System place can open, it opens that place on "This
 * session" (the command-level `opens`); from a model or a script it is the report as text.
 */
export function createStatusCommand<Ctx extends CommandActionContext>(
  services: (ctx: Ctx) => SystemSessionServices,
): DescribedCommand<Ctx> {
  return defineCommand<Ctx>({
    name: 'status',
    title: 'Status',
    summary: 'See this session at a glance: model, context window and what is in force',
    group: 'Health',
    // Unlisted: typed, it opens System on This session; a model or script typing it gets the status.
    firstScreen: false,
    opens: 'system/session',
    actions: [sessionCapabilityAction<Ctx, SystemSessionServices>(SYSTEM_STATUS, services, { terminalOnly: 'It reports the terminal program you are using.' })],
  });
}
