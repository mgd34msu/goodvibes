/**
 * routes/tailscale.ts
 *
 * Handlers for the tailscale.* verbs over the remote-access tailscale module.
 * Detection is read-only; serve and stop are the only state-changing tailscale
 * commands, each run only from its explicit user-initiated verb and recorded
 * with an honest receipt. A successful serve points web.publicBaseUrl at the
 * https MagicDNS URL and remembers the value it replaced; a successful stop
 * puts that value back when the address still points at the tailnet.
 */
import type { GatewayMethodCatalog } from '../method-catalog.js';
import type { GatewayMethodHandler, GatewayMethodInvocation } from '../method-catalog-shared.js';
import {
  detectTailscaleAsync,
  disableTailscaleServeAsync,
  enableTailscaleServeAsync,
  type TailscaleCommandRunner,
  type TailscaleServeReceipt,
  type TailscaleServeReceiptStore,
} from '../../remote-access/tailscale.js';
import { GatewayVerbError } from './gateway-verb-error.js';
import { logger } from '../../utils/logger.js';

export interface TailscaleGatewayDeps {
  /** Injectable command runner (tests never touch a real tailscale). */
  readonly runner: TailscaleCommandRunner;
  readonly receipts: TailscaleServeReceiptStore;
  /**
   * The local port `tailscale serve` fronts: where the web UI is served
   * (`resolveWebUiListener`), null when no web UI is served.
   */
  readonly resolveWebUiPort: () => number | null;
  /** Persist web.publicBaseUrl: the https MagicDNS URL on a serve, the earlier value on a stop. */
  readonly setPublicBaseUrl: (url: string) => void;
  /**
   * Read the current web.publicBaseUrl. Without it a serve cannot remember the
   * value it replaced and a stop leaves web.publicBaseUrl as it is, saying so.
   */
  readonly getPublicBaseUrl?: (() => string) | undefined;
}

function requirePrincipal(invocation: GatewayMethodInvocation): void {
  if (!invocation.context.principalId) {
    throw new GatewayVerbError('Tailscale verbs require an authenticated principal', 'UNAUTHENTICATED', 401);
  }
}

/** Record a receipt; a store that cannot take it must not turn a command that already ran into an error. */
function record(deps: TailscaleGatewayDeps, verb: string, receipt: TailscaleServeReceipt): boolean {
  try {
    deps.receipts.append(receipt);
    return true;
  } catch (error) {
    logger.warn(`${verb}: the receipt could not be recorded`, {
      error: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
}

function createGetHandler(deps: TailscaleGatewayDeps): GatewayMethodHandler {
  return async (invocation) => {
    requirePrincipal(invocation);
    const detection = await detectTailscaleAsync(deps.runner);
    const lastServe = deps.receipts.latest();
    const activeServe = deps.receipts.active();
    return { ...detection, ...(lastServe ? { lastServe } : {}), ...(activeServe ? { activeServe } : {}) };
  };
}

function createServeRunHandler(deps: TailscaleGatewayDeps): GatewayMethodHandler {
  return async (invocation) => {
    requirePrincipal(invocation);
    const port = deps.resolveWebUiPort();
    if (port === null) {
      throw new GatewayVerbError('No web UI is served on this machine, so tailscale serve would front nothing. Serve it first with goodvibes-daemon webui enable --bundle-dir <dir>.', 'WEB_UI_NOT_SERVED', 409);
    }
    const attempt = await enableTailscaleServeAsync(port, deps.runner);
    let receipt = attempt;
    if (attempt.ok && attempt.url && deps.getPublicBaseUrl) {
      // A second serve while one is on must keep the address the first one
      // replaced, not remember the tailnet URL as the value to restore.
      const current = deps.getPublicBaseUrl();
      const active = deps.receipts.active();
      const previous = active?.url === current ? active.previousPublicBaseUrl : current;
      if (previous !== undefined) receipt = { ...attempt, previousPublicBaseUrl: previous };
    }
    const receiptRecorded = record(deps, 'tailscale.serve.run', receipt);
    let publicBaseUrlUpdated = false;
    if (receipt.ok && receipt.url) {
      try {
        deps.setPublicBaseUrl(receipt.url);
        publicBaseUrlUpdated = true;
      } catch (error) {
        logger.warn('tailscale.serve.run: web.publicBaseUrl update failed', {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    return { receipt, publicBaseUrlUpdated, receiptRecorded };
  };
}

function createServeStopHandler(deps: TailscaleGatewayDeps): GatewayMethodHandler {
  return async (invocation) => {
    requirePrincipal(invocation);
    const active = deps.receipts.active();
    const receipt = await disableTailscaleServeAsync(active?.url, deps.runner);
    const receiptRecorded = record(deps, 'tailscale.serve.stop', receipt);
    let publicBaseUrlRestored = false;
    let publicBaseUrlDetail: string;
    if (!receipt.ok) {
      publicBaseUrlDetail = 'web.publicBaseUrl is unchanged because tailscale serve was not stopped';
    } else if (!active?.url) {
      publicBaseUrlDetail = 'web.publicBaseUrl is unchanged: no serve started from this daemon is on record';
    } else if (!deps.getPublicBaseUrl) {
      publicBaseUrlDetail = `web.publicBaseUrl is unchanged: this daemon cannot read it; set it with config.set if it still names ${active.url}`;
    } else if (deps.getPublicBaseUrl() !== active.url) {
      publicBaseUrlDetail = 'web.publicBaseUrl is unchanged: it was changed after tailscale serve started';
    } else {
      const restored = active.previousPublicBaseUrl ?? '';
      try {
        deps.setPublicBaseUrl(restored);
        publicBaseUrlRestored = true;
        publicBaseUrlDetail = restored ? `web.publicBaseUrl is back to ${restored}` : 'web.publicBaseUrl is cleared';
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        logger.warn('tailscale.serve.stop: web.publicBaseUrl restore failed', { error: reason });
        publicBaseUrlDetail = `web.publicBaseUrl still names ${active.url}: ${reason}; set it with config.set`;
      }
    }
    return { receipt, publicBaseUrlRestored, publicBaseUrlDetail, receiptRecorded };
  };
}

const TAILSCALE_HANDLER_FACTORIES: Readonly<Record<string, (deps: TailscaleGatewayDeps) => GatewayMethodHandler>> = {
  'tailscale.get': createGetHandler,
  'tailscale.serve.run': createServeRunHandler,
  'tailscale.serve.stop': createServeStopHandler,
};

/**
 * Attach the tailscale.* handlers to their cataloged descriptors. A missing
 * descriptor is a silent no-op (the operator-contract gates catch real drift).
 */
export function registerTailscaleGatewayMethods(catalog: GatewayMethodCatalog, deps: TailscaleGatewayDeps): void {
  for (const [methodId, factory] of Object.entries(TAILSCALE_HANDLER_FACTORIES)) {
    const descriptor = catalog.get(methodId);
    if (descriptor) {
      catalog.register(descriptor, factory(deps), { replace: true });
    }
  }
}
