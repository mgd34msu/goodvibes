/**
 * pair-command.ts, `goodvibes-daemon pair`.
 *
 * Two forms.
 *
 * LOCAL FORM, `pair` with no `--host`, or one naming this machine, reprints
 * the pairing block a daemon prints once as it starts: the web origin, the
 * offers a new device can accept, what it will be able to do, and a QR code
 * encoding the deep link that opens the web app already signed in. It takes
 * the EXISTING token (`--token`, the process override, or the shared companion
 * token in `<daemon home>/operator-tokens.json`) rather than minting a new one,
 * so a link printed here and the one printed at boot are the same link.
 *
 * The running daemon is the authority on that link: one `GET /status` proves
 * it accepts the token, and `/api/health` names the address and scheme it is
 * really bound to. A daemon that refuses the token gets no link (it would not
 * sign in). Only when no daemon answers is the link rebuilt from the settings
 * and the token file, and the output says so.
 *
 * Once the shared token was revoked, the stored token is the replacement the
 * daemon wrote for this machine's own apps and goes in no link. The local
 * form then mints the new device its own token on this machine's daemon, the
 * same act and the same `-y` consent as the remote form.
 *
 * REMOTE FORM, `pair --host <name> [--port] [--token]`, asks THAT daemon to
 * MINT A NEW per-device pairing token over `pairing.handoff.create` and prints
 * the pairing block for it. Minting is a different act than reprinting: it is
 * a fresh token, and every token that daemon already issued (its own shared
 * token included) is left exactly as it was. Because it changes state on a
 * daemon that may not be this process's own, it states the plan and asks for
 * confirmation before acting, `-y`/`--yes` satisfies that non-interactively.
 * An unreachable daemon, a
 * rejected token, and a daemon too old to serve the verb are each refused by
 * name (see `callDaemonVerb`), never a stack trace.
 *
 * The remote form's mint call carries no `--name` flag of its own: the token
 * is named with the platform's `defaultPairingTokenName()`, the same date-stamped
 * default every other pairing producer uses when the operator did not supply
 * one. The name is user-visible and editable later in device management.
 */
import type { ConfigManager } from '@goodvibes/engine/platform/platform/config';
import {
  availablePairingOffers,
  buildPairingHandoffLink,
  defaultPairingTokenName,
  formatPairingOffers,
  lanHttpsPort,
  PAIRING_REACH_FIX,
  pairingReachFromSettings,
  pairingReadySteps,
  pairingThisMachineLines,
  pairingUnreachableLines,
  resolvePairingWebOrigin,
  SERVE_TO_NETWORK_QUESTION,
  type OriginPosture,
  type PairingHandoffOfferKind,
  type PairingReach,
} from '@goodvibes/engine/platform/platform/pairing';
import { renderPairingBanner } from '../core/pairing-banner.js';
import { httpsCertificateSource, lanHttpsInstallLink } from '@goodvibes/engine/platform/platform/daemon/lan-https/page';
import {
  callDaemonMethod,
  callDaemonRoute,
  extractOperatorToken,
  resolveLocalDaemonTarget,
  resolveRemoteDaemonTarget,
  type DaemonFailureCode,
  type DaemonFetch,
  resolveRuntimeEndpointBinding,
  type RemoteDaemonTarget,
} from '@goodvibes/engine/terminal-shell';
import type { DaemonCommandResult, RemoteCommandFlags } from './status-command.js';

export interface PairCommandDeps {
  readonly configManager: Pick<ConfigManager, 'get'>;
  readonly daemonHomeDir: string;
  readonly version: string;
  /**
   * This machine's operator token (`GOODVIBES_DAEMON_TOKEN`, else the token
   * file), the one reader every command of this program shares; injected in
   * tests so nothing reads a real token file.
   */
  readonly readToken: (daemonHomeDir: string) => string | undefined;
  /** Asks the daemon, here or remote, with the configured outbound TLS trust (`createDaemonCommandRemote`). */
  readonly fetchImpl: DaemonFetch;
  /** Whether this daemon's pairing store records the shared operator token as revoked. Absent: never. */
  readonly sharedTokenRevoked?: (() => boolean) | undefined;
  /**
   * `pair --lan`: serve the web UI to the network, as `webui enable --lan`
   * does (webui-command.ts), writing the same settings. Absent: `--lan` is refused.
   */
  readonly serveToNetwork?: (() => { readonly exitCode: number; readonly lines: readonly string[] }) | undefined;
  /**
   * Ask the person a yes or no question, opening on No (`[y/N]`); absent when
   * no one can answer (not a terminal), which answers No.
   */
  readonly askYesNo?: ((question: string) => Promise<boolean>) | undefined;
}

/** The listener `/api/health` reports. */
interface HealthBinding {
  readonly network?: { readonly controlPlane?: { readonly host?: string; readonly port?: number; readonly scheme?: string } };
}

type LocalDaemonAnswer =
  | { readonly kind: 'serving'; readonly bound: { readonly host: string; readonly port: number; readonly scheme: 'http' | 'https' } | undefined }
  | { readonly kind: 'refused'; readonly baseUrl: string }
  /** A daemon answered with a status other than success or a refusal (a 500, a 503). */
  | { readonly kind: 'unhealthy'; readonly baseUrl: string; readonly status: number }
  | { readonly kind: 'absent'; readonly baseUrl: string };

/**
 * Ask the daemon on this machine whether it accepts `token` and where it is
 * bound. The status code decides; nothing reads wording.
 */
async function askLocalDaemon(input: RunPairCommandInput, token: string, named: RemoteDaemonTarget | undefined): Promise<LocalDaemonAnswer> {
  let target: RemoteDaemonTarget;
  if (named !== undefined) {
    target = { baseUrl: named.baseUrl, token, isLocal: true };
  } else {
    // This machine's token goes only to this machine's daemon, at its bind address.
    const resolved = resolveLocalDaemonTarget({
      token,
      ...(input.flags.port === undefined ? {} : { port: input.flags.port }),
      configManager: input.configManager,
      daemonHomeDir: input.daemonHomeDir,
      readToken: input.readToken,
    });
    if (!resolved.ok) return { kind: 'absent', baseUrl: 'this machine' };
    target = resolved.target;
  }
  const fetchImpl = input.fetchImpl;
  let status: number;
  try {
    status = (await fetchImpl(`${target.baseUrl}/status`, { headers: { Authorization: `Bearer ${token}` } })).status;
  } catch {
    return { kind: 'absent', baseUrl: target.baseUrl };
  }
  if (status === 401 || status === 403) return { kind: 'refused', baseUrl: target.baseUrl };
  if (status < 200 || status >= 300) return { kind: 'unhealthy', baseUrl: target.baseUrl, status };
  const health = await callDaemonRoute<HealthBinding>(target, '/api/health', { method: 'GET', envelope: 'raw' }, fetchImpl);
  const listener = health.ok ? health.data.network?.controlPlane : undefined;
  const bound = listener?.host !== undefined && typeof listener.port === 'number'
    ? { host: listener.host, port: listener.port, scheme: listener.scheme === 'https' ? 'https' as const : 'http' as const }
    : undefined;
  return { kind: 'serving', bound };
}

export interface PairCommandFlags extends RemoteCommandFlags {
  /** `-y`/`--yes`: consent to minting a new per-device token on a remote daemon, or to serving the web UI to the network with `--lan`. */
  readonly yes: boolean;
  /** `--lan`: serve the web UI to the network first, then print the code for a phone (this machine's daemon only). */
  readonly lan?: boolean | undefined;
}

export interface RunPairCommandInput extends PairCommandDeps {
  readonly flags: PairCommandFlags;
}

/** The port a resolved daemon address names, the scheme's default when it names none. */
function targetPort(target: RemoteDaemonTarget): number {
  const url = new URL(target.baseUrl);
  return url.port === '' ? (url.protocol === 'https:' ? 443 : 80) : Number(url.port);
}

function failure(error: string, fix: string, json: boolean, code?: DaemonFailureCode): DaemonCommandResult {
  return {
    exitCode: 1,
    lines: json ? [JSON.stringify({ ok: false, ...(code ? { code } : {}), error, fix }, null, 2)] : [error, `  ${fix}`],
  };
}

/**
 * The web origin a remote handoff's deep link opens, recovered from the link
 * itself. `buildPairingHandoffLink` in the platform builds the link as exactly
 * `<webOrigin, trailing slashes stripped>/#<params>`, so slicing at the
 * first `/#` is the precise inverse, and feeding the result back into
 * `renderPairingBanner` (which rebuilds the SAME link from origin + token +
 * offers) reproduces byte-for-byte what the remote daemon already returned.
 */
function originFromDeepLink(deepLink: string): string {
  const cut = deepLink.indexOf('/#');
  return cut === -1 ? deepLink : deepLink.slice(0, cut);
}

function isPairingOfferKind(value: string): value is PairingHandoffOfferKind {
  return value === 'notifications' || value === 'relay' || value === 'passkey';
}

interface PairingHandoffOfferDetail {
  readonly kind: string;
  readonly available?: boolean;
}

/** The shape `pairing.handoff.create` returns, see routes/pairing-handoff.ts. */
interface PairingHandoffCreateResult {
  readonly token: {
    readonly id: string;
    readonly name: string;
    /** The plaintext secret, returned exactly once. */
    readonly token: string;
    readonly createdAt: number;
  };
  readonly offers: readonly PairingHandoffOfferDetail[];
  /** `#pair=<token>&offers=...`, present even when no web origin is configured. */
  readonly fragment: string;
  /** `<webOrigin>/#pair=...`, present only when that daemon has a web origin configured. */
  readonly deepLink?: string;
}

/**
 * `goodvibes-daemon pair` with no `--host`, or one naming this machine:
 * `named` is that `--host` already resolved, so its address and port are used
 * as given.
 */
async function runLocalReprint(input: RunPairCommandInput, named?: RemoteDaemonTarget, servedNow = false): Promise<DaemonCommandResult> {
  const { flags } = input;
  const port = named === undefined ? flags.port : targetPort(named);
  if (port !== undefined && (!Number.isInteger(port) || port < 1 || port > 65535)) {
    return failure('the local pairing port must identify a concrete listener', 'use the nonzero port reported by the running daemon', flags.json);
  }

  const token = flags.token ?? extractOperatorToken(input.readToken(input.daemonHomeDir));
  if (token === undefined) {
    return failure(
      'no operator token was found for this machine, so there is no link to print',
      'start the daemon once; it creates the token as it starts: goodvibes-daemon serve',
      flags.json,
    );
  }
  // Once the shared token was revoked, the value stored here is the replacement
  // only this machine's apps hold; it is never put in a link for another
  // device. The new device gets its own token from this machine's daemon instead.
  if (flags.token === undefined && input.sharedTokenRevoked?.() === true) {
    let target: RemoteDaemonTarget;
    if (named !== undefined) {
      target = { baseUrl: named.baseUrl, token, isLocal: true };
    } else {
      const resolved = resolveLocalDaemonTarget({
        token,
        ...(flags.port === undefined ? {} : { port: flags.port }),
        configManager: input.configManager,
        daemonHomeDir: input.daemonHomeDir,
        readToken: input.readToken,
      });
      if (!resolved.ok) return failure(resolved.error, resolved.fix, flags.json, resolved.code);
      target = resolved.target;
    }
    if (!flags.yes) {
      return mintPlanResult(target, flags.json, [
        'The shared token on this machine was revoked and replaced; the replacement belongs to this machine\'s own apps and is not put in a pairing link.',
        '',
      ]);
    }
    return runRemoteMint(input, target, true);
  }

  const answer = await askLocalDaemon(input, token, named);
  if (answer.kind === 'refused') {
    return failure(
      `the daemon at ${answer.baseUrl} does not accept this machine's stored operator token, so a link built from it would not sign in`,
      'pass the token that daemon was started with: goodvibes-daemon pair --token <token>',
      flags.json,
    );
  }
  // A local reprint writes no token and no setting of its own. With no daemon
  // answering, the binding comes from settings, or from --port when given.
  // Just after `--lan` wrote the network binding, the daemon's answer still
  // names the bind it is leaving, so the settings it is moving to decide.
  const bound = answer.kind === 'serving' && !servedNow ? answer.bound
    : port === undefined ? undefined
      : { ...resolveRuntimeEndpointBinding(input.configManager, 'controlPlane'), port };
  const origin = resolvePairingWebOrigin(input.configManager, undefined, bound);
  if (origin === null) {
    // No web UI is served (and no public URL names one), so a link would open nothing.
    return failure(
      'no web UI is served by this daemon and web.publicBaseUrl names none, so a pairing link would open nothing',
      'serve the web UI first: goodvibes-daemon webui enable --bundle-dir <dir> (or set web.publicBaseUrl to where it runs), then pair again',
      flags.json,
    );
  }
  const fromFiles = answer.kind === 'absent'
    ? [`no daemon answered at ${answer.baseUrl}; this link is built from the settings and the token file, and works once the daemon runs with them.`,
      'a daemon started on another port is found with: goodvibes-daemon pair --port <port>']
    : answer.kind === 'unhealthy'
      ? [`the daemon at ${answer.baseUrl} answered HTTP ${answer.status}; this link is built from the settings and the token file`]
      : [];
  const offers = availablePairingOffers({
    relayEnabled: input.configManager.get('relay.enabled') === true,
    stepUpAvailable: true,
  });

  // Whether a phone can open this address, from the daemon's own bind (its
  // /api/health answer, or the settings) and its settings: no probe. When it
  // cannot, the link is given for a browser on this machine, said so, with no QR.
  const thisMachine = thisMachineSignIn(input.configManager, origin.origin, token, offers);
  if (thisMachine !== null) {
    if (flags.json) {
      return {
        exitCode: 0,
        lines: [JSON.stringify({
          ok: true,
          data: {
            origin: origin.origin,
            deepLink: thisMachine.deepLink,
            forThisMachine: true,
            reason: thisMachine.reach.reason,
            fix: thisMachine.reach.fix,
            offers,
            originFromPublicBaseUrl: origin.fromPublicBaseUrl,
            source: answer.kind === 'serving' ? 'daemon' : 'files',
          },
        }, null, 2)],
      };
    }
    // The one real question, asked in place: on yes the daemon is served to the network and the code made in this run.
    if (!servedNow && await askToServe(input)) {
      if (answer.kind === 'serving') {
        const target = named !== undefined ? { baseUrl: named.baseUrl, token, isLocal: true } : localTarget(input, token);
        if (target) return runRemoteMint(input, target, true, true);
      }
      const served = input.serveToNetwork?.();
      if (served && served.exitCode !== 0) return { exitCode: served.exitCode, lines: served.lines };
      return runLocalReprint(input, named, true);
    }
    return { exitCode: 0, lines: [...thisMachine.lines, ...(fromFiles.length > 0 ? ['', ...fromFiles] : [])] };
  }

  const banner = renderPairingBanner({
    version: input.version,
    origin: origin.origin,
    alternateOrigin: origin.alternateOrigin,
    token,
    offers,
    includeQr: !flags.json,
  });

  if (flags.json) {
    return {
      exitCode: 0,
      lines: [JSON.stringify({
        ok: true,
        data: {
          origin: origin.origin,
          deepLink: banner.deepLink,
          ...(banner.alternateDeepLink === undefined ? {} : { alternateDeepLink: banner.alternateDeepLink }),
          offers,
          capabilities: banner.capabilities,
          ...(banner.notice === undefined ? {} : { notice: banner.notice }),
          originFromPublicBaseUrl: origin.fromPublicBaseUrl,
          source: answer.kind === 'serving' ? 'daemon' : 'files',
        },
      }, null, 2)],
    };
  }

  return {
    exitCode: 0,
    lines: [
      'Pair a phone',
      ...pairingReadySteps(origin.origin, offers, await lanCertificatePage(input, token, named, origin.origin)),
      '',
      ...banner.lines,
      ...(fromFiles.length > 0 ? ['', ...fromFiles] : []),
    ],
  };
}

/**
 * The block `pair` and the start-up output print when no phone could open the
 * link (the one decision, `pairingReachFromSettings`): that the link signs in
 * a browser on this computer and why a phone cannot open it, the steps that
 * let a phone reach it, then the link and the code to paste. No QR: a QR is
 * for another device. Null when a phone could open it. `reach` is the daemon's
 * answer when it gave one; otherwise it is decided from this machine's settings.
 */
export function thisMachineSignIn(
  config: Pick<ConfigManager, 'get'>,
  origin: string,
  token: string,
  offers: readonly PairingHandoffOfferKind[],
  answered?: PairingReach,
): { readonly lines: readonly string[]; readonly deepLink: string; readonly reach: PairingReach } | null {
  const reach = answered ?? pairingReachFromSettings(config, origin);
  if (reach.otherDevices) return null;
  const deepLink = buildPairingHandoffLink({ webOrigin: origin, token, offers });
  return {
    reach,
    deepLink,
    lines: [
      ...pairingThisMachineLines(origin, reach, 'goodvibes-daemon pair'),
      '  Or both steps in one run: goodvibes-daemon pair --lan -y',
      '',
      `  ${deepLink}`,
      `  Sign-in code: ${token}  (to paste on the web UI's sign-in page, under Other ways to sign in)`,
    ],
  };
}

/**
 * With the LAN https listener on, the link a phone opens to install the GoodVibes certificate before it opens the https
 * `origin`: the page on the https address with the certificate's fingerprint in it (lan-https/page.ts
 * `lanHttpsInstallLink`), read from this machine's daemon (secureAddress.get). Never the plain address: the certificate
 * and its fingerprint are never given over plain http. When the daemon cannot say it, the step says where the owner
 * finds the link on this computer.
 */
async function lanCertificatePage(input: RunPairCommandInput, token: string, named: RemoteDaemonTarget | undefined, origin: string): Promise<string | undefined> {
  const config = input.configManager;
  // Only GoodVibes' own certificate is installed on the phone; Let's Encrypt and a certificate you made are trusted as they are.
  if (lanHttpsPort(config) === undefined || httpsCertificateSource(config) !== 'local-authority') return undefined;
  let url: URL;
  try { url = new URL(origin); } catch { return undefined; }
  if (url.protocol !== 'https:') return undefined;
  const resolved = named !== undefined ? { ok: true as const, target: { baseUrl: named.baseUrl, token, isLocal: true } }
    : resolveLocalDaemonTarget({ token, ...(input.flags.port === undefined ? {} : { port: input.flags.port }), configManager: config, daemonHomeDir: input.daemonHomeDir, readToken: input.readToken });
  const status = resolved.ok
    ? await callDaemonMethod<{ readonly localAuthority?: { readonly fingerprint?: string } }>(resolved.target, 'secureAddress.get', { input: {} }, input.fetchImpl).catch(() => undefined)
    : undefined;
  const fingerprint = status?.ok ? status.data.localAuthority?.fingerprint : undefined;
  return fingerprint ? lanHttpsInstallLink(url.origin, fingerprint)
    : 'the link for phones in System, Secure address in the web UI on this computer (it carries the certificate\'s fingerprint)';
}

/** Ask it (opening on No: it opens this machine to the network); false with no one to ask. */
async function askToServe(input: RunPairCommandInput): Promise<boolean> {
  if (input.flags.json || !input.askYesNo) return false;
  return input.askYesNo(SERVE_TO_NETWORK_QUESTION);
}

/** This machine's own daemon as a target for `token`, at its bind address. */
function localTarget(input: RunPairCommandInput, token: string): RemoteDaemonTarget | undefined {
  const resolved = resolveLocalDaemonTarget({
    token,
    ...(input.flags.port === undefined ? {} : { port: input.flags.port }),
    configManager: input.configManager,
    daemonHomeDir: input.daemonHomeDir,
    readToken: input.readToken,
  });
  return resolved.ok ? resolved.target : undefined;
}

/** The plan a minting `pair` prints before it will act, absent `-y`. Nothing is called yet. */
function mintPlanResult(target: RemoteDaemonTarget, json: boolean, why: readonly string[] = []): DaemonCommandResult {
  const plan = [
    ...why,
    `pair${why.length > 0 ? '' : ' --host'}: this will MINT A NEW per-device pairing token on the daemon at ${target.baseUrl}`,
    'and print the pairing link/QR for that new token.',
    '',
    "That daemon's existing tokens (its shared token and every other paired device) are",
    'left exactly as they are: minting is a different act than reprinting, and this is a',
    'fresh token, not a link to one that already exists.',
    '',
    'Nothing has been changed. Re-run with -y (or --yes) to mint it.',
  ];
  if (json) {
    return {
      exitCode: 0,
      lines: [JSON.stringify({
        ok: true,
        data: { confirmed: false, target: target.baseUrl, plan },
      }, null, 2)],
    };
  }
  return { exitCode: 0, lines: plan };
}

/** The minting form, once `-y` has consented: mint and render. `local`: the daemon is this machine's own. */
async function runRemoteMint(input: RunPairCommandInput, target: RemoteDaemonTarget, local = false, serveToNetwork = false): Promise<DaemonCommandResult> {
  const { flags } = input;

  // No token is minted that a phone could not open: that daemon's own answer
  // about the address a code would carry (pairing.posture.get mints nothing;
  // the daemon decides from its settings). No answer leaves the mint to say
  // what went wrong, as before. With the owner's yes to serving the network,
  // the daemon does that and mints in the same call.
  const posture = serveToNetwork ? undefined : await callDaemonMethod<{ readonly posture: OriginPosture }>(target, 'pairing.posture.get', { input: {} }, input.fetchImpl);
  // This machine's own daemon serving only this machine: the token is minted
  // for a browser here, and printed as such, with no QR.
  let forThisMachine: PairingReach | undefined;
  if (posture?.ok) {
    const reach = posture.data.posture.reach;
    if (reach !== undefined && !reach.otherDevices && !local && await askToServe(input)) return runRemoteMint(input, target, local, true);
    if (reach !== undefined && !reach.otherDevices && local) forThisMachine = reach;
    else if (reach !== undefined && !reach.otherDevices) {
      const pairAgain = local ? 'goodvibes-daemon pair -y' : `goodvibes-daemon pair --host ${target.baseUrl} -y`;
      if (flags.json) {
        return failure(
          `no pairing code was made: a phone could not open it yet (${reach.reason ?? 'the daemon serves only its own machine'})`,
          `${reach.fix ?? PAIRING_REACH_FIX} on that daemon's machine, then ${pairAgain}`,
          flags.json,
        );
      }
      return { exitCode: 1, lines: pairingUnreachableLines(posture.data.posture.origin, reach, pairAgain) };
    }
  }

  const outcome = await callDaemonMethod<PairingHandoffCreateResult>(
    target, 'pairing.handoff.create', { input: { name: defaultPairingTokenName(), ...(forThisMachine !== undefined ? { forThisMachine: true } : {}), ...(serveToNetwork ? { serveToNetwork: true } : {}) } }, input.fetchImpl,
  );
  if (!outcome.ok) return failure(outcome.error, outcome.fix, flags.json, outcome.code);

  // Making a pairing code mints a credential for the user's own device: the user's own act. This typed command carries the machine's
  // token, which is the user, so the daemon runs it at once in every permission mode and asks nothing more; the only question
  // is the one asked above on a terminal ("Serve it to your network? [y/N]"), and a refusal came back as one above.
  const data = outcome.data;
  const offerKinds = data.offers.map((offer) => offer.kind).filter(isPairingOfferKind);
  const mintedLine = `minted a new per-device pairing token ("${data.token.name}") on the daemon at ${target.baseUrl}.`;

  if (forThisMachine !== undefined && data.deepLink !== undefined) {
    const origin = originFromDeepLink(data.deepLink);
    const thisMachine = thisMachineSignIn(input.configManager, origin, data.token.token, offerKinds, forThisMachine);
    if (thisMachine !== null) {
      if (flags.json) {
        return {
          exitCode: 0,
          lines: [JSON.stringify({
            ok: true,
            data: {
              minted: true, target: target.baseUrl, tokenId: data.token.id, tokenName: data.token.name, token: data.token.token,
              origin, deepLink: thisMachine.deepLink, forThisMachine: true, reason: thisMachine.reach.reason, fix: thisMachine.reach.fix, offers: offerKinds,
            },
          }, null, 2)],
        };
      }
      return { exitCode: 0, lines: [mintedLine, '', ...thisMachine.lines] };
    }
  }

  if (data.deepLink === undefined) {
    // Honest degraded path: the mint itself succeeded, the token is real and
    // usable, but that daemon has no web origin configured, and this process
    // has no way to read or fabricate one for it. `resolvePairingWebOrigin` is
    // what the local form reads instead, and it is exactly the thing this
    // process cannot ask a REMOTE daemon for outside this verb's own reply.
    const lines = [
      mintedLine,
      '',
      'that daemon has no web origin configured, so no deep link or QR could be built; only',
      'the raw token and pairing fragment:',
      '',
      `  token:    ${data.token.token}`,
      `  fragment: ${data.fragment}`,
      '',
      ...(offerKinds.length > 0 ? ['Offers (each declinable in the web app):', ...formatPairingOffers(offerKinds), ''] : []),
      'Configure a web origin on that daemon, then pair again for a scannable link.',
    ];
    if (flags.json) {
      return {
        exitCode: 0,
        lines: [JSON.stringify({
          ok: true,
          data: {
            minted: true,
            target: target.baseUrl,
            tokenId: data.token.id,
            tokenName: data.token.name,
            token: data.token.token,
            fragment: data.fragment,
            offers: offerKinds,
          },
        }, null, 2)],
      };
    }
    return { exitCode: 0, lines };
  }

  const origin = originFromDeepLink(data.deepLink);
  // This machine's own daemon resolves its origin from the same settings and
  // host facts as this process, so the routable fallback is known here; a
  // remote daemon's is not, and is never guessed.
  const localOrigin = local ? resolvePairingWebOrigin(input.configManager) ?? undefined : undefined;
  const banner = renderPairingBanner({
    version: local ? input.version : `remote build at ${target.baseUrl}`,
    origin,
    alternateOrigin: localOrigin?.origin === origin ? localOrigin.alternateOrigin : undefined,
    token: data.token.token,
    offers: offerKinds,
    includeQr: !flags.json,
  });

  if (flags.json) {
    return {
      exitCode: 0,
      lines: [JSON.stringify({
        ok: true,
        data: {
          minted: true,
          target: target.baseUrl,
          tokenId: data.token.id,
          tokenName: data.token.name,
          token: data.token.token,
          origin,
          deepLink: banner.deepLink,
          ...(banner.alternateDeepLink === undefined ? {} : { alternateDeepLink: banner.alternateDeepLink }),
          offers: offerKinds,
          capabilities: banner.capabilities,
          ...(banner.notice === undefined ? {} : { notice: banner.notice }),
        },
      }, null, 2)],
    };
  }

  return { exitCode: 0, lines: [mintedLine, '', ...banner.lines] };
}

/**
 * `pair --lan`: the two steps a phone needs in one run. Serving the web UI to
 * the network widens who can reach the daemon and stays until it is narrowed
 * again, so it is stated first and done only with `-y`; then the code is made
 * from the settings just written.
 */
async function runPairForNetwork(input: RunPairCommandInput, named: RemoteDaemonTarget | undefined): Promise<DaemonCommandResult> {
  const { flags } = input;
  if (input.serveToNetwork === undefined) {
    return failure('pair --lan cannot change this daemon\'s settings from here', 'run goodvibes-daemon webui enable --lan, then goodvibes-daemon pair', flags.json);
  }
  if (!flags.yes) {
    const plan = [
      'pair --lan: this will serve the web UI to your network (every device on it can reach the sign-in page;',
      'only a device with a code signs in), then print the code for the phone.',
      'It stays served to your network until you run: goodvibes-daemon webui enable --loopback',
      '',
      'Nothing has been changed. Re-run with -y (or --yes) to do it.',
    ];
    return flags.json
      ? { exitCode: 0, lines: [JSON.stringify({ ok: true, data: { confirmed: false, plan } }, null, 2)] }
      : { exitCode: 0, lines: plan };
  }
  const served = input.serveToNetwork();
  if (served.exitCode !== 0) return { exitCode: served.exitCode, lines: served.lines };
  const paired = await runLocalReprint(input, named, true);
  return flags.json ? paired : { exitCode: paired.exitCode, lines: [...served.lines, '', ...paired.lines] };
}

export async function runPairCommand(input: RunPairCommandInput): Promise<DaemonCommandResult> {
  const { flags } = input;
  if (flags.lan === true) {
    const host = flags.host?.trim();
    if (host === undefined || host === '') return runPairForNetwork(input, undefined);
    const resolved = resolveRemoteDaemonTarget({
      flags: { host, ...(flags.port === undefined ? {} : { port: flags.port }), ...(flags.token === undefined ? {} : { token: flags.token }) },
      configManager: input.configManager, daemonHomeDir: input.daemonHomeDir, readToken: input.readToken,
    });
    if (!resolved.ok) return failure(resolved.error, resolved.fix, flags.json, resolved.code);
    if (!resolved.target.isLocal) {
      return failure('pair --lan serves this machine\'s web UI to its network, so it takes no --host for another machine',
        `on that machine run goodvibes-daemon pair --lan -y, or here goodvibes-daemon pair --host ${host} -y`, flags.json);
    }
    return runPairForNetwork(input, resolved.target);
  }

  // A named host is resolved by the same rule every remote-capable command
  // uses, so `127.0.0.1`, `localhost:3421`, `[::1]` and `http://127.0.0.1:3421`
  // all mean this machine and reprint its link instead of minting a token.
  const host = flags.host?.trim();
  if (host !== undefined && host !== '') {
    const resolved = resolveRemoteDaemonTarget({
      flags: {
        host,
        ...(flags.port === undefined ? {} : { port: flags.port }),
        ...(flags.token === undefined ? {} : { token: flags.token }),
      },
      configManager: input.configManager,
      daemonHomeDir: input.daemonHomeDir,
      readToken: input.readToken,
    });
    if (!resolved.ok) return failure(resolved.error, resolved.fix, flags.json, resolved.code);
    if (resolved.target.isLocal) return runLocalReprint(input, resolved.target);
    if (!flags.yes) return mintPlanResult(resolved.target, flags.json);
    return runRemoteMint(input, resolved.target);
  }

  return runLocalReprint(input);
}
