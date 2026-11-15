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

/** The installed port; throws when none is installed. */
export function judgmentPort(site: string): JudgmentPort {
  assertDecisionModelsEnabled(site);
  if (installed === undefined) throw new JudgmentPortMissingError(site);
  return installed.port;
}

/** Package-private installation facts; identities contain no source or credential data. */
export function judgmentPortInstallation(site: string): {
  readonly port: JudgmentPort;
  readonly signal: AbortSignal;
  readonly identityFor: (owner: object) => object;
} {
  judgmentPort(site);
  const current = installed!;
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
