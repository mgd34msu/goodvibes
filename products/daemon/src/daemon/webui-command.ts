// ---------------------------------------------------------------------------
// webui-command.ts, `goodvibes-daemon webui enable|disable|status`.
//
// WHAT THIS IS FOR
//
// The browser operator surface ships as a built bundle of static files, not as a
// fourth binary and not as a fourth service. The daemon already knows how to
// serve such a directory: with `controlPlane.webui.serve` on, its own HTTP
// router answers `/` from `controlPlane.webui.bundleDir` and falls back to
// index.html for app routes. So installing the web UI is two config writes and
// a directory on disk, and this is the command that makes those writes, so the
// curl installer does not have to know the key names, the file format, or which
// of the three settings tiers a daemon-owned key belongs in. Same reason
// `provision-wake-model` exists: the installer runs the binary it just placed
// and the one implementation owns the details.
//
// WHERE IT IS SERVED, AND WHY THE URL SAYS WHAT IT SAYS
//
// The bundle is served BY THE CONTROL-PLANE LISTENER, same origin as the API
// (that is the whole point, a same-origin bundle makes the browser's
// same-origin policy a non-issue and needs no CORS allowlist). So the URL that
// opens the web UI is the control-plane origin: `<scheme>://<host>:<controlPlane.port>`,
// https when the listener holds TLS itself (`controlPlane.tls.mode` direct),
// not `web.port`. `web.port` is where the web UI's development server listens
// (it reads it from `webui status --json`); nothing else binds it and no link,
// pairing address or `tailscale serve` uses it. This command reports the origin
// that actually answers and never stores it: `web.publicBaseUrl` holds only an
// address a person set, and a stored copy of this daemon's own origin (or the
// old placeholder) is cleared, so the printed URL, the pairing deep link and the
// running server all follow the settings as they change.
//
// EXPOSURE IS NEVER WIDENED AS A SIDE EFFECT
//
// `enable` turns serving on and names the bundle. It does not touch the
// listener's host mode in either direction, so a fresh install serves the web UI
// on loopback (the shipped `controlPlane.hostMode` default) and a host already
// deliberately bound to the LAN keeps that binding. Widening is its own explicit
// act: `--lan`, which binds every interface and turns `controlPlane.enabled` on,
// because the listener answers other machines only with that setting on.
// Narrowing back is `--loopback`. Both are stated in the receipt.
// ---------------------------------------------------------------------------

import { isAbsolute, join, resolve } from 'node:path';
import { existsSync, statSync } from 'node:fs';
import type { ConfigManager, DaemonConfigPatch } from '@goodvibes/engine/platform/platform/config';
import { resolveRuntimeEndpointBinding } from '@goodvibes/engine/terminal-shell';
import { WEBUI_BINDING_RESULT, WEBUI_ENABLE_RESULT } from '../cli/machine-contracts.js';
import {
  explicitPublicBaseUrl, isLoopbackHost, lanHttpsOriginOf, lanHttpsPort, probeStableHostInputs, publicBaseUrlIsOwnOrigin, resolveControlPlaneOrigin, type StableHostInputs,
} from '@goodvibes/engine/platform/platform/pairing';
import { LAN_HTTPS_INSTALL_WORDS, httpsCertificateSource, readOwnCertificate, type HttpsCertificateSource } from '@goodvibes/engine/platform/platform/daemon/lan-https/page';


export interface WebuiCommandResult {
  readonly exitCode: number;
  readonly lines: readonly string[];
}

export interface WebuiCommandDeps {
  /** Reads and writes the daemon-owned `controlPlane.*` / `web.*` keys. */
  readonly configManager: Pick<ConfigManager, 'get' | 'set' | 'setDaemonValues'>;
  /** True when the path names a directory. Injected in tests. */
  readonly directoryExists?: ((path: string) => boolean) | undefined;
  /** True when the path names a readable file. Injected in tests. */
  readonly fileExists?: ((path: string) => boolean) | undefined;
  /** Resolves a possibly-relative path against this base. Defaults to the cwd. */
  readonly baseDirectory?: string | undefined;
  /**
   * Stable-name probe for the LAN origin. Defaults to the engine's cached,
   * non-blocking probe; a caller that awaited `refreshStableHostInputs` first
   * gets the Tailscale and `.local` rungs. Injected in tests.
   */
  readonly probeStableHost?: (() => StableHostInputs) | undefined;
}

type Posture = 'lan' | 'loopback' | 'unchanged';

interface ParsedWebuiArgs {
  readonly subcommand: 'enable' | 'disable' | 'status' | 'https';
  readonly bundleDir: string | undefined;
  readonly posture: Posture;
  readonly json: boolean;
  /** `enable --https`: also turn the LAN https listener on. */
  readonly https: boolean;
  /** `https off|status`. */
  readonly httpsAction: 'off' | 'status' | undefined;
  /** `https off --forget-certificate`: remove the certificate authority too. */
  readonly forgetCertificate: boolean;
  /** `enable --https --certificate <which>` and its inputs: the Secure address for scripts. */
  readonly certificate: HttpsCertificateSource | undefined;
  readonly domain: string | undefined;
  readonly certFile: string | undefined;
  readonly keyFile: string | undefined;
  readonly errors: readonly string[];
}

const CERTIFICATE_CHOICES: readonly HttpsCertificateSource[] = ['local-authority', 'own-files', 'lets-encrypt'];

function parseWebuiArgs(argv: readonly string[]): ParsedWebuiArgs {
  const errors: string[] = [];
  let subcommand: 'enable' | 'disable' | 'status' | 'https' = 'status';
  let bundleDir: string | undefined;
  let lan = false;
  let loopback = false;
  let sawSubcommand = false;
  let json = false;
  let https = false;
  let httpsAction: 'off' | 'status' | undefined;
  let forgetCertificate = false;
  let certificate: HttpsCertificateSource | undefined;
  let domain: string | undefined;
  let certFile: string | undefined;
  let keyFile: string | undefined;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index] ?? '';
    const valued = ['--certificate', '--domain', '--cert-file', '--key-file'].find((flag) => arg === flag || arg.startsWith(`${flag}=`));
    if (valued) {
      const inline = arg.startsWith(`${valued}=`) ? arg.slice(valued.length + 1) : undefined;
      const value = inline ?? argv[index + 1];
      if (inline === undefined) index += 1;
      if (value === undefined || value === '' || value.startsWith('-')) { errors.push(`${valued} needs a value`); continue; }
      if (valued === '--certificate') {
        if (CERTIFICATE_CHOICES.includes(value as HttpsCertificateSource)) certificate = value as HttpsCertificateSource;
        else errors.push(`--certificate must be one of ${CERTIFICATE_CHOICES.join(', ')}`);
      } else if (valued === '--domain') domain = value.trim().toLowerCase().replace(/\.$/, '');
      else if (valued === '--cert-file') certFile = value;
      else keyFile = value;
      continue;
    }
    if (arg === '--json') {
      json = true;
      continue;
    }
    if (arg === '--lan') {
      lan = true;
      continue;
    }
    if (arg === '--https') {
      https = true;
      continue;
    }
    if (arg === '--forget-certificate') {
      forgetCertificate = true;
      continue;
    }
    if (subcommand === 'https' && sawSubcommand && httpsAction === undefined && (arg === 'off' || arg === 'status')) {
      httpsAction = arg;
      continue;
    }
    if (arg === '--loopback') {
      loopback = true;
      continue;
    }
    if (arg === '--bundle-dir') {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith('-')) {
        errors.push('--bundle-dir needs a directory path');
        continue;
      }
      bundleDir = value;
      index += 1;
      continue;
    }
    if (arg.startsWith('--bundle-dir=')) {
      const value = arg.slice('--bundle-dir='.length);
      if (!value) {
        errors.push('--bundle-dir needs a directory path');
        continue;
      }
      bundleDir = value;
      continue;
    }
    if (arg.startsWith('-')) {
      errors.push(`unknown option: ${arg}`);
      continue;
    }
    if (sawSubcommand) {
      errors.push(`unexpected argument: ${arg}`);
      continue;
    }
    sawSubcommand = true;
    if (arg === 'enable' || arg === 'disable' || arg === 'status' || arg === 'https') {
      subcommand = arg;
    } else {
      errors.push(`unknown subcommand: ${arg} (expected enable, disable, status or https)`);
    }
  }
  if (https && subcommand !== 'enable') errors.push(`--https only applies to 'webui enable', not '${subcommand}'`);
  if (https && loopback) errors.push('--https serves your network over https, so it cannot go with --loopback');
  if (subcommand === 'https' && httpsAction === undefined) errors.push("webui https needs 'off' or 'status' (turn it on with: goodvibes-daemon webui enable --lan --https)");
  if (forgetCertificate && !(subcommand === 'https' && httpsAction === 'off')) errors.push("--forget-certificate only applies to 'webui https off'");
  if ((certificate || domain || certFile || keyFile) && !https) errors.push('--certificate, --domain, --cert-file and --key-file go with \'webui enable --lan --https\'');
  if (certificate === 'lets-encrypt' && !domain) errors.push('--certificate lets-encrypt needs --domain <a name under a domain you own, such as gv.example.com>');
  if (domain !== undefined && !/^(?!-)[a-z0-9-]{1,63}(?<!-)(\.(?!-)[a-z0-9-]{1,63}(?<!-))+$/.test(domain)) errors.push('--domain must be a DNS name such as gv.example.com (no scheme, no port, no *)');
  if (certificate === 'own-files' && (!certFile || !keyFile)) errors.push('--certificate own-files needs --cert-file <certificate with its chain> and --key-file <its private key>');

  if (lan && loopback) {
    errors.push('--lan and --loopback ask for opposite things; pass one of them');
  }
  const posture: Posture = lan ? 'lan' : loopback ? 'loopback' : 'unchanged';
  if (subcommand !== 'enable') {
    // Only `enable` writes a bundle or a listener posture; accepting the flags
    // elsewhere would let a user believe exposure had been narrowed.
    if (lan) errors.push(`--lan only applies to 'webui enable', not '${subcommand}'`);
    if (loopback) errors.push(`--loopback only applies to 'webui enable', not '${subcommand}'`);
    if (bundleDir !== undefined) errors.push(`--bundle-dir only applies to 'webui enable', not '${subcommand}'`);
  }
  if (json && subcommand === 'disable') {
    errors.push('--json applies to \'webui status\' and \'webui enable\', not \'disable\'');
  }
  return { subcommand, bundleDir, posture, json, https, httpsAction, forgetCertificate, certificate, domain, certFile, keyFile, errors };
}

function readString(config: Pick<ConfigManager, 'get'>, key: 'controlPlane.webui.bundleDir' | 'web.publicBaseUrl' | 'web.staticAssetsDir'): string {
  const raw = config.get(key);
  return typeof raw === 'string' ? raw.trim() : '';
}

/**
 * The origin a browser opens to reach the web UI: the CONTROL-PLANE origin,
 * because that is the listener serving the bundle, from the engine's one owner
 * of it (bind host through the stable-name ladder, port, and the scheme the
 * listener really speaks). A name comes with the routable address as
 * `alternate`.
 */
function servingOrigin(
  config: Pick<ConfigManager, 'get'>,
  probe: () => StableHostInputs,
): { readonly origin: string; readonly alternate?: string | undefined; readonly loopback: boolean; readonly recognized: boolean } {
  const served = resolveControlPlaneOrigin(config, probe);
  return {
    origin: served.origin,
    alternate: served.alternateOrigin,
    loopback: isLoopbackHost(served.resolvedHost.host),
    recognized: served.recognized,
  };
}

/** A bundle directory is usable only when it exists and holds the app shell. */
function describeBundleProblem(
  bundleDir: string,
  directoryExists: (path: string) => boolean,
  fileExists: (path: string) => boolean,
): string | null {
  if (!directoryExists(bundleDir)) {
    return `no directory at ${bundleDir}`;
  }
  if (!fileExists(join(bundleDir, 'index.html'))) {
    return `${bundleDir} holds no index.html, so it is not a built web UI bundle`;
  }
  return null;
}

function postureLines(origin: string, loopback: boolean, servesOtherMachines: boolean, alternate?: string): string[] {
  if (loopback) {
    return [
      '  reachable from this machine only (the control-plane listener is bound to loopback).',
      '  To reach it from another device on your network:  goodvibes-daemon webui enable --lan',
    ];
  }
  if (!servesOtherMachines) {
    return [
      `  bound to your network at ${origin}, but only this machine is served: controlPlane.enabled is off, so other devices are refused.`,
      '  To serve other devices on your network:  goodvibes-daemon webui enable --lan',
    ];
  }
  return [
    `  reachable from your network at ${origin}; the control-plane listener uses its configured binding.`,
    ...(alternate ? [`  a device that cannot resolve that name can use ${alternate}`] : []),
    '  To take it back to this machine only:  goodvibes-daemon webui enable --loopback',
  ];
}

/**
 * Run the command and report it. Never throws for an ordinary refusal, a bad
 * argument, a missing bundle, an unwritable settings file all come back as an
 * exit code and lines, because the caller is often an installer reading both.
 */
export function runWebuiCommand(argv: readonly string[], deps: WebuiCommandDeps): WebuiCommandResult {
  const answer = runWebui(argv, deps);
  if (!argv.includes('--json') || answer.exitCode === 0) return answer;
  // A --json caller gets every refusal and failure as the one {ok:false, code, error, fix} document.
  const [first = 'webui: the command failed', ...rest] = answer.lines.map((line) => line.trim()).filter((line) => line !== '');
  return {
    exitCode: answer.exitCode,
    lines: [JSON.stringify({
      ok: false,
      code: answer.exitCode === 2 ? 'WEBUI_REFUSED' : 'WEBUI_FAILED',
      error: first.replace(/^webui: /, ''),
      fix: rest.length > 0 ? rest.join(' ') : 'run goodvibes-daemon webui status',
    }, null, 2)],
  };
}

function runWebui(argv: readonly string[], deps: WebuiCommandDeps): WebuiCommandResult {
  const parsed = parseWebuiArgs(argv);
  if (parsed.errors.length > 0) {
    return {
      exitCode: 2,
      lines: [
        ...parsed.errors.map((error) => `webui: ${error}`),
        'Usage: goodvibes-daemon webui [enable|disable|status] [--bundle-dir <dir>] [--lan|--loopback] [--https] [--json]',
        '       goodvibes-daemon webui enable --lan --https --certificate local-authority|own-files|lets-encrypt [--domain <name>] [--cert-file <path> --key-file <path>]',
        '       goodvibes-daemon webui https off|status [--forget-certificate] [--json]',
      ],
    };
  }

  const config = deps.configManager;
  const directoryExists = deps.directoryExists ?? ((path: string) => existsSync(path) && statSync(path).isDirectory());
  const fileExists = deps.fileExists ?? ((path: string) => existsSync(path) && statSync(path).isFile());
  const base = deps.baseDirectory ?? process.cwd();
  const probe = deps.probeStableHost ?? probeStableHostInputs;
  const absolute = (path: string): string => (isAbsolute(path) ? path : resolve(base, path));

  if (parsed.subcommand === 'https') return runHttps(parsed, config, probe);

  if (parsed.subcommand === 'status') {
    if (parsed.json) {
      // Vite needs the declared web endpoint for its own development listener.
      // The daemon's served bundle uses controlPlane instead; claiming that
      // listener as the dev port would make the two processes compete for it.
      const binding = resolveRuntimeEndpointBinding(config, 'web');
      if (!binding.recognized) return { exitCode: 2, lines: ['webui: unrecognized configured web host mode'] };
      return {
        exitCode: 0,
        lines: [JSON.stringify({
          ...WEBUI_BINDING_RESULT,
          enabled: config.get('web.enabled') === true,
          hostMode: binding.hostMode,
          configuredHost: binding.configuredHost,
          host: binding.host,
          port: binding.port,
          url: readString(config, 'web.publicBaseUrl'),
          // Whether the daemon serves the bundle, and the directory it was told to serve:
          // an installer keeps serving off when the owner turned it off.
          serve: config.get('controlPlane.webui.serve') === true,
          bundleDir: readString(config, 'controlPlane.webui.bundleDir'),
        })],
      };
    }
    return renderStatus(config, { directoryExists, fileExists, absolute, probe });
  }

  if (parsed.subcommand === 'disable') {
    // `enable` declares the web surface too, so `disable` withdraws it in the
    // same write; otherwise status keeps reporting it enabled. A saved web
    // address that is only this daemon's own origin (what `enable` stores) is
    // cleared with it, judged while the settings still serve: pairing and
    // notification links read it first and would keep pointing at a daemon
    // that no longer serves the app. A tunnel or proxy URL the owner set is kept.
    const values: { -readonly [K in keyof DaemonConfigPatch]: DaemonConfigPatch[K] } = {
      'controlPlane.webui.serve': false,
      'web.enabled': false,
    };
    const savedPublic = explicitPublicBaseUrl(config);
    const hasSavedPublic = savedPublic !== '';
    const clearPublic = hasSavedPublic && publicBaseUrlIsOwnOrigin(config, undefined, probe).own;
    if (clearPublic) values['web.publicBaseUrl'] = '';
    try {
      config.setDaemonValues(values);
    } catch (error) {
      return { exitCode: 1, lines: [`webui: could not write settings: ${message(error)}`] };
    }
    const kept = readString(config, 'controlPlane.webui.bundleDir');
    return {
      exitCode: 0,
      lines: [
        'web UI: no longer served by the daemon.',
        ...(clearPublic ? [`  the saved web address (web.publicBaseUrl ${savedPublic}) was this daemon's own and is cleared, so pairing and notification links no longer point at it`] : []),
        ...(hasSavedPublic && !clearPublic ? [`  web.publicBaseUrl is still ${savedPublic}; pairing and notification links keep using it`] : []),
        ...(kept ? [`  the bundle is left on disk at ${kept}; 'goodvibes-daemon webui enable' serves it again`] : []),
        '  A running daemon stops serving it within about a second; no restart is needed.',
      ],
    };
  }

  // enable
  const requested = parsed.bundleDir ?? readString(config, 'controlPlane.webui.bundleDir');
  if (!requested) {
    return {
      exitCode: 2,
      lines: [
        'webui: no bundle directory to serve.',
        '  Pass one:  goodvibes-daemon webui enable --bundle-dir <dir>',
      ],
    };
  }
  const bundleDir = absolute(requested);
  const problem = describeBundleProblem(bundleDir, directoryExists, fileExists);
  if (problem) {
    return {
      exitCode: 1,
      lines: [
        `webui: refusing to serve ${bundleDir}: ${problem}.`,
        '  Nothing was changed.',
      ],
    };
  }

  // Prepare one complete daemon-file transition before any write, including
  // the requested listener posture and the pairing URL derived from it.
  const values: { -readonly [K in keyof DaemonConfigPatch]: DaemonConfigPatch[K] } = {
    'controlPlane.webui.bundleDir': bundleDir,
    'controlPlane.webui.serve': true,
    'web.enabled': true,
  };
  if (parsed.posture !== 'unchanged') {
    const mode = parsed.posture === 'lan' ? 'network' : 'local';
    values['controlPlane.hostMode'] = mode;
    values['web.hostMode'] = mode;
    // Binding the LAN serves it only with this on; --loopback leaves it, since a loopback bind already keeps others out.
    if (parsed.posture === 'lan') values['controlPlane.enabled'] = true;
  }
  const getCurrent = (config.get as (key: keyof DaemonConfigPatch) => unknown).bind(config);
  const projected = { get: ((key: keyof DaemonConfigPatch) =>
    Object.hasOwn(values, key) ? values[key] : getCurrent(key)) as ConfigManager['get'] };
  if (parsed.https) {
    // https on the network is a second listener beside the plain one; it needs the web UI served to the network.
    if (projected.get('controlPlane.hostMode') === 'local') {
      return { exitCode: 2, lines: ['webui: --https serves your network over https, but the web UI is served to this machine only. Nothing was changed.', '  Add --lan:  goodvibes-daemon webui enable --lan --https'] };
    }
    values['controlPlane.lanHttps.enabled'] = true;
    // Which certificate (the Secure address): checked here first, so a pair that cannot be served changes nothing.
    if (parsed.certificate === 'own-files') {
      const check = readOwnCertificate({ certFile: absolute(parsed.certFile!), keyFile: absolute(parsed.keyFile!) });
      if (!check.ok) return { exitCode: 2, lines: [`webui: ${check.problem ?? 'these files cannot be served'} Nothing was changed.`] };
      values['secureAddress.certFile'] = absolute(parsed.certFile!);
      values['secureAddress.keyFile'] = absolute(parsed.keyFile!);
    }
    if (parsed.domain) values['secureAddress.domain'] = parsed.domain;
    if (parsed.certificate) values['secureAddress.certificate'] = parsed.certificate;
  }
  let hostInputs: StableHostInputs | undefined;
  const stableProbe = () => hostInputs ??= probe();
  const serving = servingOrigin(projected, stableProbe);
  // web.publicBaseUrl holds only what a person set: links are derived live from
  // the settings. A stored value that is empty, the old placeholder or this
  // daemon's own derived origin (judged against the settings before this
  // change) is cleared, so a later posture or port change moves every link.
  const storedPublic = readString(config, 'web.publicBaseUrl');
  const currentPublic = explicitPublicBaseUrl(config);
  if (storedPublic !== '' && publicBaseUrlIsOwnOrigin(config, undefined, stableProbe).own) {
    values['web.publicBaseUrl'] = '';
  }
  try {
    config.setDaemonValues(values);
  } catch (error) {
    return { exitCode: 1, lines: [`webui: could not write settings: ${message(error)}`] };
  }
  const lines: string[] = [
    `web UI: served by the daemon from ${bundleDir}`,
    `  ${serving.origin}`,
  ];

  if (!Object.hasOwn(values, 'web.publicBaseUrl') && currentPublic !== '' && currentPublic !== serving.origin) {
    lines.push(`  note: web.publicBaseUrl is set to ${currentPublic}; links use that, the bundle is served at the URL above.`);
  }

  if (!serving.recognized) {
    lines.push('  note: controlPlane.hostMode is not one of local|network|custom; the daemon cannot bind until that is corrected.');
  }
  lines.push(...postureLines(serving.origin, serving.loopback, projected.get('controlPlane.enabled') === true, serving.alternate));
  if (parsed.https) lines.push(...httpsOnLines(projected, serving.origin));
  // The daemon reads the serving settings per request and rebinds its listener on a host or port change.
  lines.push('  A running daemon applies this within about a second; no restart is needed.');
  if (parsed.json) {
    // The receipt an installer reads: the URL, and the lines it prints as they are.
    return {
      exitCode: 0,
      lines: [JSON.stringify({
        ...WEBUI_ENABLE_RESULT,
        ok: true,
        url: serving.origin,
        ...(serving.alternate ? { alternateUrl: serving.alternate } : {}),
        lines,
      }, null, 2)],
    };
  }
  return { exitCode: 0, lines };
}

/** What `enable --https` (and `https status`) say: the https address, and where each phone trusts it once. */
function httpsOnLines(config: Pick<ConfigManager, 'get'>, plainOrigin: string): string[] {
  const port = lanHttpsPort(config);
  const sameHost = port === undefined ? undefined : lanHttpsOriginOf(plainOrigin, port);
  if (!sameHost) return ['  https on your network: on, once the web UI is served to your network.'];
  const source = httpsCertificateSource(config);
  const domain = String(config.get('secureAddress.domain') ?? '');
  const secure = source === 'lets-encrypt' && domain ? `https://${domain}:${port}` : sameHost;
  const trust = source === 'local-authority'
    ? [`  Certificate: GoodVibes' own. Each phone trusts it once: open the link for phones that goodvibes-daemon pair prints (or System, Secure address in the web UI on this computer shows) and follow the page (iPhone and Android; it also says how to remove it). The link carries the certificate's fingerprint, and the page offers the certificate only when it matches; it is never given over ${plainOrigin}.`]
    : source === 'lets-encrypt'
      ? [`  Certificate: Let's Encrypt for ${domain} and every name under it, asked for and renewed by the daemon (its DNS records written with the Cloudflare token in cloudflare.apiTokenRef, CLOUDFLARE_API_TOKEN or the stored secret). Nothing is installed on the phones.`,
        '  Let\'s Encrypt publishes the name in public logs. The daemon reports the outcome, the address record and the router check on the Secure address screen (Settings, General, Secure address).']
      : [`  Certificate: yours (${String(config.get('secureAddress.certFile') ?? '')}), read again when the file changes; you are told a fortnight before it ends. Nothing is installed on the phones that trust its signer.`];
  return [
    `  https on your network: ${secure} (a second listener; ${plainOrigin} keeps working as before)`,
    ...trust,
    '  Pairing now gives phones the https address: goodvibes-daemon pair',
    `  The https address is for browsers. GoodVibes' own programs (the terminal app, the Agent) keep using ${plainOrigin}.`,
  ];
}

/** `webui https off` and `webui https status`. */
function runHttps(parsed: ParsedWebuiArgs, config: WebuiCommandDeps['configManager'], probe: () => StableHostInputs): WebuiCommandResult {
  const served = servingOrigin(config, probe);
  if (parsed.httpsAction === 'status') {
    const on = lanHttpsPort(config) !== undefined;
    const lines = on ? ['https on your network: on', ...httpsOnLines(config, served.origin)] : ['https on your network: off', '  Turn it on:  goodvibes-daemon webui enable --lan --https'];
    const source = httpsCertificateSource(config);
    const domain = String(config.get('secureAddress.domain') ?? '');
    const httpsUrl = on ? (source === 'lets-encrypt' && domain ? `https://${domain}:${lanHttpsPort(config)!}` : lanHttpsOriginOf(served.origin, lanHttpsPort(config)!)) : undefined;
    return { exitCode: 0, lines: parsed.json ? [JSON.stringify({ ok: true, enabled: on, certificate: source, port: Number(config.get('controlPlane.lanHttps.port')), plainUrl: served.origin, ...(httpsUrl ? { httpsUrl } : {}) })] : lines };
  }
  try {
    config.setDaemonValues({ 'controlPlane.lanHttps.enabled': false });
  } catch (error) {
    return { exitCode: 1, lines: [`webui: could not write settings: ${message(error)}`] };
  }
  return {
    exitCode: 0,
    lines: [
      'https on your network: off. The https listener stops within about a second; the plain listener is unchanged.',
      ...(parsed.forgetCertificate ? [] : ['  The certificate authority is kept, so turning it on again needs nothing new on the phones; remove it too with: goodvibes-daemon webui https off --forget-certificate']),
      '  To remove the certificate from a phone:',
      `    iPhone and iPad: ${LAN_HTTPS_INSTALL_WORDS.iphone[3]!.replace(/^To remove it later: /, '')}`,
      `    Android: ${LAN_HTTPS_INSTALL_WORDS.android[2]!.replace(/^To remove it later: /, '')}`,
    ],
  };
}

function renderStatus(
  config: Pick<ConfigManager, 'get'>,
  deps: {
    readonly directoryExists: (path: string) => boolean;
    readonly fileExists: (path: string) => boolean;
    readonly absolute: (path: string) => string;
    readonly probe: () => StableHostInputs;
  },
): WebuiCommandResult {
  const serve = config.get('controlPlane.webui.serve') === true;
  const configured = readString(config, 'controlPlane.webui.bundleDir');
  const fallback = readString(config, 'web.staticAssetsDir');
  const source = configured ? 'controlPlane.webui.bundleDir' : fallback ? 'web.staticAssetsDir' : '';
  const directory = configured || fallback;

  if (!serve) {
    return {
      exitCode: 0,
      lines: [
        'web UI: not served by this daemon (controlPlane.webui.serve is off).',
        ...(directory ? [`  a bundle directory is configured (${source}): ${directory}`] : []),
        '  Serve it:  goodvibes-daemon webui enable --bundle-dir <dir>',
      ],
    };
  }

  const serving = servingOrigin(config, deps.probe);
  const lines = [`web UI: served by the daemon at ${serving.origin}`];
  if (!directory) {
    lines.push('  no bundle directory is configured, so every request falls through to the API routes.');
  } else {
    const absoluteDir = deps.absolute(directory);
    const problem = describeBundleProblem(absoluteDir, deps.directoryExists, deps.fileExists);
    lines.push(problem ? `  bundle (${source}): ${absoluteDir} (UNUSABLE: ${problem})` : `  bundle (${source}): ${absoluteDir}`);
  }
  const currentPublic = explicitPublicBaseUrl(config);
  if (currentPublic && currentPublic !== serving.origin) {
    lines.push(`  note: web.publicBaseUrl is ${currentPublic}; links use that, the bundle is served at the URL above.`);
  }
  lines.push(...postureLines(serving.origin, serving.loopback, config.get('controlPlane.enabled') === true, serving.alternate));
  return { exitCode: 0, lines };
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
