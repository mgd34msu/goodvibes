/**
 * Regression guard for this process's adopt-only contract: goodvibes-agent
 * composes NO inbound channel consumer of its own.
 *
 * This process never runs a daemon of its own. `src/runtime/bootstrap-external-services.ts`
 * only ever ADOPTS a connected host through the platform's host services,
 * which have no path that constructs, embeds, or restarts a DaemonServer, and there is no getUpdates/ntfy/inbox poll loop anywhere
 * under src/ outside tests.
 *
 * That property is true today by construction, but nothing enforced it.
 * Constructing a daemon or starting an inbound consumer (a Telegram
 * getUpdates poll, an ntfy subscription, an inbox poller) here would be an
 * architectural change to how this process relates to the daemon it
 * connects to, and must be raised and agreed on deliberately, never made
 * silently as a side effect of an unrelated change. These tests fail
 * loudly, with an explanation, the moment that stops being true.
 */
import { describe, expect, mock, test } from 'bun:test';
import { wireAgentExternalServices } from '../../runtime/bootstrap-external-services.ts';
import { AgentDaemonReceiptFeed } from '../../runtime/daemon-receipts.ts';
import { createDeferredStartupCoordinator, startExternalServices, type ExternalServicesHandle } from '@/runtime/index.ts';


describe('external-services bootstrap stays adopt-only (no daemon construction)', () => {
  test('wireAgentExternalServices calls the adopt-only platform host services once during boot discovery', async () => {
    // Drive the real seam with injected fakes instead of grepping text: this
    // proves the *behavior*, not just the source shape, so a future refactor
    // that routes boot discovery around the platform call still fails this test.
    const daemonReceiptFeed = new AgentDaemonReceiptFeed();
    const memoryConsolidationReceiptFeed = new AgentDaemonReceiptFeed();

    const fakeHandle: ExternalServicesHandle = {
      daemonServer: null,
      httpListener: null,
      daemonStatus: { mode: 'external', host: '127.0.0.1', port: 3421, baseUrl: 'http://127.0.0.1:3421' },
      httpListenerStatus: { mode: 'disabled', host: '127.0.0.1', port: 3422, baseUrl: 'http://127.0.0.1:3422' },
      listRecentControlPlaneEvents: () => [],
      stop: async () => {},
    };

    // Spy standing in for `startExternalServices` (== the platform's
    // `bootstrap.startHostServices`, the ONLY seam that can construct or
    // embed a DaemonServer). We never let it run for real; we only assert
    // how the Agent calls it.
    const startServicesSpy = mock(async (..._args: unknown[]) => fakeHandle) as unknown as typeof startExternalServices;

    const configManager = {
      get: (key: 'daemon.enabled' | 'danger.httpListener' | 'controlPlane.host' | 'controlPlane.port' | 'httpListener.host' | 'httpListener.port') => {
        switch (key) {
          case 'controlPlane.host': return '127.0.0.1';
          case 'controlPlane.port': return 3421;
          case 'httpListener.host': return '127.0.0.1';
          case 'httpListener.port': return 3422;
          default: return undefined;
        }
      },
    };

    const deferredStartup = createDeferredStartupCoordinator();

    const controller = wireAgentExternalServices({
      configManager,
      runtimeBus: {} as never,
      hookDispatcher: {} as never,
      // `asDaemonGradeView` is what the wiring hands the platform: the graph
      // with its two client narrowings substituted back. The platform reads only
      // localUserAuthManager and configManager off it.
      services: { daemonReceiptFeed, memoryConsolidationReceiptFeed, asDaemonGradeView: () => ({}) } as never,
      uiServices: { platform: {} } as never,
      deferredStartup,
      systemMessageRouter: { high: () => {}, low: () => {} } as never,
      requestRender: () => {},
      startServices: startServicesSpy,
      // Explicit seam so the boot-time "installed but stopped" autostart check
      // (a separate, already-adopted-daemon short-circuit) never needs to
      // touch a real platform service manager in this test.
      connectedHostAutostart: {
        control: { snapshot: () => [] } as never,
        probeReachability: async () => 'online' as never,
      },
    });

    await controller.whenDiscovered();

    const calls = (startServicesSpy as unknown as { mock: { calls: unknown[][] } }).mock.calls;
    expect(
      calls.length,
      'wireAgentExternalServices must call the platform host services exactly once during boot discovery. ' +
      'This process is adopt-only: it connects to an existing daemon rather than running one. If this count ' +
      'changed, check what boot-time path now bypasses the shared policy call.',
    ).toBe(1);
  });
});
