import type { JudgmentPort } from '@goodvibes-jev/judgment/decisions';
import { assertDecisionModelsEnabled } from './decision-policy.js';

/** One installation lifetime; restoring the same port never restores old readers. */
interface Installation {
  readonly port: JudgmentPort;
  readonly controller: AbortController;
  readonly identities: WeakMap<object, object>;
}
let installed: Installation | undefined;
/**
 * Runtimes that share this process (embedded daemons for separate workspaces),
 * oldest first. Each keeps its readings until it retires itself; the newest is
 * the one new readings use.
 */
const alongside: Installation[] = [];

export class JudgmentPortMissingError extends Error {
  constructor(site: string) {
    super(`No judgment port is installed; ${site} needs one. Call installJudgmentPort() at startup.`);
    this.name = 'JudgmentPortMissingError';
  }
}

const installationFor = (port: JudgmentPort): Installation => ({ port, controller: new AbortController(), identities: new WeakMap() });

/**
 * Names the port of the runtime the current call belongs to, when the host can
 * tell (the platform keeps it per async call chain; this package stays free of
 * Node-only modules). Unset, or naming no runtime still installed, the
 * process-current installation answers.
 */
let runtimeScope: (() => JudgmentPort | undefined) | undefined;

/**
 * Installs how a call names its runtime's port. With two runtimes alongside,
 * a reading started by the older one then keeps that runtime's port and
 * lifetime, so stopping the newer runtime never ends it.
 */
export function installJudgmentRuntimeScope(read: (() => JudgmentPort | undefined) | undefined): void {
  runtimeScope = read;
}

/** The installation the current call belongs to: its own runtime's while that runtime is installed, else the current one. */
function currentInstallation(): Installation | undefined {
  const scoped = runtimeScope?.();
  if (scoped === undefined || scoped === installed?.port) return installed;
  return alongside.find((entry) => entry.port === scoped && !entry.controller.signal.aborted) ?? installed;
}

/**
 * Make `next` current. The replaced installation's readers end, except when a
 * runtime joins alongside another runtime that is still running.
 */
function publish(next: Installation | undefined, joining: boolean): void {
  const previous = installed;
  installed = next;
  // Publish the replacement before reentrant cancellation listeners run.
  if (previous !== undefined && previous !== next && !(joining && alongside.includes(previous))) previous.controller.abort();
}

/**
 * Installs the port; returns the one it replaced, preserving the public contract.
 * `alongside`: the port belongs to a runtime that may share the process with
 * another runtime (two embedded daemons). It becomes current, but the readings
 * the other runtime already holds keep running; they end when that runtime
 * retires its own port with {@link restoreJudgmentPort}.
 */
export function installJudgmentPort(port: JudgmentPort | undefined, options: { readonly alongside?: boolean | undefined } = {}): JudgmentPort | undefined {
  const previous = installed;
  if (previous?.port === port) {
    if (options.alongside && previous !== undefined && !alongside.includes(previous)) alongside.push(previous);
    return port;
  }
  const next = port === undefined ? undefined : installationFor(port);
  const joining = next !== undefined && options.alongside === true;
  if (joining) alongside.push(next);
  publish(next, joining);
  return previous?.port;
}

/**
 * Retiring an older runtime must never temporarily replace the live runtime.
 * A runtime installed alongside others hands the process to the newest one
 * still running, and only to `previous` when it was the last.
 */
export function restoreJudgmentPort(owner: JudgmentPort, previous: JudgmentPort | undefined): void {
  const index = alongside.findIndex(entry => entry.port === owner);
  if (index < 0) {
    if (installed?.port === owner) installJudgmentPort(previous);
    return;
  }
  const [retiring] = alongside.splice(index, 1);
  if (installed?.port === owner) {
    let next = alongside.at(-1);
    // A port installed by hand once displaced that runtime and ended its readers; it starts a fresh lifetime.
    if (next !== undefined && next.controller.signal.aborted) {
      const fresh = installationFor(next.port);
      alongside[alongside.length - 1] = fresh;
      next = fresh;
    }
    if (next !== undefined) publish(next, false);
    else installJudgmentPort(previous);
  }
  retiring?.controller.abort();
}

/** The installed port (the calling runtime's own, when it runs alongside another); throws when none is installed. */
export function judgmentPort(site: string): JudgmentPort {
  return requireInstallation(site).port;
}

function requireInstallation(site: string): Installation {
  assertDecisionModelsEnabled(site);
  const current = currentInstallation();
  if (current === undefined) throw new JudgmentPortMissingError(site);
  return current;
}

/** Package-private installation facts; identities contain no source or credential data. */
export function judgmentPortInstallation(site: string): {
  readonly port: JudgmentPort;
  readonly signal: AbortSignal;
  readonly identityFor: (owner: object) => object;
} {
  const current = requireInstallation(site);
  return {
    port: current.port,
    signal: current.controller.signal,
    identityFor(owner) {
      let identity = current.identities.get(owner);
      if (!identity) { identity = Object.freeze({}); current.identities.set(owner, identity); }
      return identity;
    },
  };
}
