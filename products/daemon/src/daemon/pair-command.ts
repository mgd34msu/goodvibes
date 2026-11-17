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
import type { ConfigManager } from '@goodvibes-jev/engine/platform/platform/config';
import {
  availablePairingOffers,
  defaultPairingTokenName,
  formatPairingOffers,
  isLoopbackHost,
  resolvePairingWebOrigin,
  type PairingHandoffOfferKind,
} from '@goodvibes-jev/engine/platform/platform/pairing';
import { renderPairingBanner } from '../core/pairing-banner.js';
import {
  callDaemonMethod,
  callDaemonRoute,
  extractOperatorToken,
  resolveRemoteDaemonTarget,
  type DaemonFailureCode,
  type DaemonFetch,
  resolveRuntimeEndpointBinding,
  type RemoteDaemonTarget,
} from '@goodvibes-jev/engine/terminal-shell';
import type { DaemonCommandResult, RemoteCommandFlags } from './status-command.js';

export interface PairCommandDeps {
  readonly configManager: Pick<ConfigManager, 'get'>;
  readonly daemonHomeDir: string;
  readonly version: string;
  /** Injected in tests so nothing reads a real token file. */
  readonly readToken: (daemonHomeDir: string) => string | undefined;
  /** Process-local override, never adopted into the stored companion identity. */
  readonly operatorToken?: string | undefined;
  /** Asks the daemon, here or remote, with the configured outbound TLS trust (`createDaemonCommandRemote`). */
  readonly fetchImpl?: DaemonFetch | undefined;
  /** Whether this daemon's pairing store records the shared operator token as revoked. Absent: never. */
  readonly sharedTokenRevoked?: (() => boolean) | undefined;
}

/** The listener `/api/health` reports. */
interface HealthBinding {
  readonly network?: { readonly controlPlane?: { readonly host?: string; readonly port?: number; readonly scheme?: string } };
}

type LocalDaemonAnswer =
  | { readonly kind: 'serving'; readonly bound: { readonly host: string; readonly port: number; readonly scheme: 'http' | 'https' } | undefined }
  | { readonly kind: 'refused'; readonly baseUrl: string }
  | { readonly kind: 'absent'; readonly baseUrl: string };

/**
 * Ask the daemon on this machine whether it accepts `token` and where it is
 * bound. The status code decides; nothing reads wording.
 */
async function askLocalDaemon(input: RunPairCommandInput, token: string): Promise<LocalDaemonAnswer> {
  const resolved = resolveRemoteDaemonTarget({
    flags: { token, ...(input.flags.port === undefined ? {} : { port: input.flags.port }) },
    configManager: input.configManager,
    daemonHomeDir: input.daemonHomeDir,
    readToken: input.readToken,
  });
  if (!resolved.ok) return { kind: 'absent', baseUrl: 'this machine' };
  const target = resolved.target;
  const fetchImpl = input.fetchImpl ?? fetch;
  let status: number;
  try {
    status = (await fetchImpl(`${target.baseUrl}/status`, { headers: { Authorization: `Bearer ${token}` } })).status;
  } catch {
    return { kind: 'absent', baseUrl: target.baseUrl };
  }
  if (status === 401 || status === 403) return { kind: 'refused', baseUrl: target.baseUrl };
  if (status < 200 || status >= 300) return { kind: 'absent', baseUrl: target.baseUrl };
  const health = await callDaemonRoute<HealthBinding>(target, '/api/health', { method: 'GET', envelope: 'raw' }, fetchImpl);
  const listener = health.ok ? health.data.network?.controlPlane : undefined;
  const bound = listener?.host !== undefined && typeof listener.port === 'number'
    ? { host: listener.host, port: listener.port, scheme: listener.scheme === 'https' ? 'https' as const : 'http' as const }
    : undefined;
  return { kind: 'serving', bound };
}

export interface PairCommandFlags extends RemoteCommandFlags {
  /** `-y`/`--yes`: consent to minting a new per-device token on a remote daemon. */
  readonly yes: boolean;
}

export interface RunPairCommandInput extends PairCommandDeps {
  readonly flags: PairCommandFlags;
}

/** The hosts that mean "this machine", matching the remote-target convention. */
function namesThisMachine(host: string): boolean {
  const normalized = host.trim().toLowerCase();
  return normalized === ''
    || normalized === '127.0.0.1'
    || normalized === 'localhost'
    || normalized === '::1'
    || normalized === '0.0.0.0';
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

/** `goodvibes-daemon pair` with no `--host`, or one naming this machine. */
async function runLocalReprint(input: RunPairCommandInput): Promise<DaemonCommandResult> {
  const { flags } = input;
  if (flags.port !== undefined && (!Number.isInteger(flags.port) || flags.port < 1 || flags.port > 65535)) {
    return failure('the local pairing port must identify a concrete listener', 'use the nonzero port reported by the running daemon', flags.json);
  }

  const token = flags.token ?? input.operatorToken ?? extractOperatorToken(input.readToken(input.daemonHomeDir));
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
  if (flags.token === undefined && input.operatorToken === undefined && input.sharedTokenRevoked?.() === true) {
    const resolved = resolveRemoteDaemonTarget({
      flags: { token, ...(flags.port === undefined ? {} : { port: flags.port }) },
      configManager: input.configManager,
      daemonHomeDir: input.daemonHomeDir,
      readToken: input.readToken,
    });
    if (!resolved.ok) return failure(resolved.error, resolved.fix, flags.json, resolved.code);
    if (!flags.yes) {
      return mintPlanResult(resolved.target, flags.json, [
        'The shared token on this machine was revoked and replaced; the replacement belongs to this machine\'s own apps and is not put in a pairing link.',
        '',
      ]);
    }
    return runRemoteMint(input, resolved.target, true);
  }

  const answer = await askLocalDaemon(input, token);
  if (answer.kind === 'refused') {
    return failure(
      `the daemon at ${answer.baseUrl} does not accept this machine's stored operator token, so a link built from it would not sign in`,
      'pass the token that daemon was started with: goodvibes-daemon pair --token <token>',
      flags.json,
    );
  }
  // A local reprint writes no token and no setting of its own. With no daemon
  // answering, the binding comes from settings, or from --port when given.
  const bound = answer.kind === 'serving' ? answer.bound
    : flags.port === undefined ? undefined
      : { ...resolveRuntimeEndpointBinding(input.configManager, 'controlPlane'), port: flags.port };
  const origin = resolvePairingWebOrigin(input.configManager, undefined, bound);
  const fromFiles = answer.kind === 'absent'
    ? [`no daemon answered at ${answer.baseUrl}; this link is built from the settings and the token file, and works once the daemon runs with them.`,
      'a daemon started on another port is found with: goodvibes-daemon pair --port <port>']
    : [];
  const offers = availablePairingOffers({
    relayEnabled: input.configManager.get('relay.enabled') === true,
    stepUpAvailable: true,
  });

  const banner = renderPairingBanner({
    version: input.version,
    origin: origin.origin,
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
      ...banner.lines,
      ...(fromFiles.length > 0 ? ['', ...fromFiles] : []),
      ...localOnlyNotice(input.configManager, origin.origin),
    ],
  };
}

/**
 * The listener answers another machine only with `controlPlane.enabled` on, so
 * a link to a network address is useless to a phone while it is off. A tunnel
 * or proxy on this machine that does not forward the client address is still
 * served, hence the hedge.
 */
export function localOnlyNotice(config: Pick<ConfigManager, 'get'>, origin: string): readonly string[] {
  if (config.get('controlPlane.enabled') === true) return [];
  let host: string;
  try { host = new URL(origin).hostname; } catch { return []; }
  if (isLoopbackHost(host)) return [];
  return [
    '',
    'note: controlPlane.enabled is off, so this daemon serves only this machine; a device opening this link directly is refused.',
    'To serve other devices: goodvibes-daemon config set controlPlane.enabled true',
  ];
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
async function runRemoteMint(input: RunPairCommandInput, target: RemoteDaemonTarget, local = false): Promise<DaemonCommandResult> {
  const { flags } = input;

  const outcome = await callDaemonMethod<PairingHandoffCreateResult>(
    target, 'pairing.handoff.create', { input: { name: defaultPairingTokenName() } }, input.fetchImpl ?? fetch,
  );
  if (!outcome.ok) return failure(outcome.error, outcome.fix, flags.json, outcome.code);

  const data = outcome.data;
  const offerKinds = data.offers.map((offer) => offer.kind).filter(isPairingOfferKind);
  const mintedLine = `minted a new per-device pairing token ("${data.token.name}") on the daemon at ${target.baseUrl}.`;

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
  const banner = renderPairingBanner({
    version: local ? input.version : `remote build at ${target.baseUrl}`,
    origin,
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
          offers: offerKinds,
          capabilities: banner.capabilities,
          ...(banner.notice === undefined ? {} : { notice: banner.notice }),
        },
      }, null, 2)],
    };
  }

  return { exitCode: 0, lines: [mintedLine, '', ...banner.lines] };
}

export async function runPairCommand(input: RunPairCommandInput): Promise<DaemonCommandResult> {
  const { flags } = input;

  if (flags.host !== undefined && !namesThisMachine(flags.host)) {
    const resolved = resolveRemoteDaemonTarget({
      flags: {
        host: flags.host,
        ...(flags.port === undefined ? {} : { port: flags.port }),
        ...(flags.token === undefined ? {} : { token: flags.token }),
      },
      configManager: input.configManager,
      daemonHomeDir: input.daemonHomeDir,
      readToken: input.readToken,
    });
    if (!resolved.ok) return failure(resolved.error, resolved.fix, flags.json, resolved.code);
    if (!flags.yes) return mintPlanResult(resolved.target, flags.json);
    return runRemoteMint(input, resolved.target);
  }

  return runLocalReprint(input);
}
