import { randomUUID } from 'node:crypto';
import type { RuntimeEventBus } from '../runtime/events/index.js';
import type { EmitterContext } from '../runtime/emitters/index.js';
import { announceTransport, type TransportAnnouncement } from '../runtime/emitters/transport-announce.js';
import type { HookDispatcher } from '../hooks/index.js';
import type { ResolvedInboundTlsContext } from '../runtime/network/index.js';
import { summarizeError } from '../utils/error-display.js';
import { logger } from '../utils/logger.js';

interface DaemonTransportEventsContext {
  readonly runtimeBus: RuntimeEventBus | null;
  readonly hookDispatcher: Pick<HookDispatcher, 'fire'> | null;
  readonly host: string;
  readonly port: number;
  readonly tlsState: () => ResolvedInboundTlsContext | null;
}

/**
 * The daemon listener's transport lifecycle. Its id is fixed for the life of
 * the daemon server, so a rebind to another host or port continues the same
 * transport (the endpoint it reached is in the `connected` payload), and a
 * connection after a failure or stop opens a new lifecycle with
 * `initializing` first, so every `connected` has a start and an end.
 */
export class DaemonTransportEventsHelper {
  private readonly id = `daemon:http:${randomUUID().slice(0, 8)}`;
  /** Between `initializing` and the next `disconnected` or `failed`. */
  private open = false;

  constructor(private readonly context: DaemonTransportEventsContext) {}

  transportId(): string {
    return this.id;
  }

  transportScheme(): 'http' | 'https' {
    return this.context.tlsState()?.scheme ?? 'http';
  }

  transportEndpoint(): string {
    return `${this.transportScheme()}://${this.context.host}:${this.context.port}`;
  }

  emitterContext(): EmitterContext {
    return {
      sessionId: 'daemon-server',
      traceId: `daemon-server:${this.id}`,
      source: 'daemon-server',
    };
  }

  emitTransportInitializing(): void {
    this.open = true;
    this.announce({ step: 'initializing', payload: { transportId: this.id, protocol: 'http-daemon' } });
  }

  emitTransportConnected(): void {
    if (!this.open) this.emitTransportInitializing();
    this.announce({ step: 'connected', payload: { transportId: this.id, endpoint: this.transportEndpoint() } });
  }

  emitTransportDisconnected(reason: string, willRetry: boolean): void {
    if (!this.open) return;
    this.open = false;
    this.announce({ step: 'disconnected', payload: { transportId: this.id, reason, willRetry } });
  }

  emitTransportTerminalFailure(error: string): void {
    // A failed bind after a failure or stop is a lifecycle of its own: started, then failed.
    if (!this.open) this.emitTransportInitializing();
    this.open = false;
    this.announce({ step: 'failed', payload: { transportId: this.id, error } });
  }

  private announce(announcement: TransportAnnouncement): void {
    announceTransport(this.context.runtimeBus, this.context.hookDispatcher, this.emitterContext(), announcement, (step, error) => {
      logger.warn('[daemon-transport] lifecycle hook failed', { specific: step, error: summarizeError(error) });
    });
  }
}
