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
// pairing address or `tailscale serve` uses it. This command therefore reports,
// and, when it is still sitting on the shipped placeholder, writes,
// `web.publicBaseUrl` as the origin that actually answers, so the printed URL,
// the pairing deep link and the running server all agree.
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
import { SHIPPED_PUBLIC_BASE_URL } from '../config/webui-bundle.js';
import { WEBUI_BINDING_RESULT } from '../cli/machine-contracts.js';
import { isLoopbackHost, probeStableHostInputs, resolveControlPlaneOrigin, type StableHostInputs } from '@goodvibes/engine/platform/platform/pairing';


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
  readonly subcommand: 'enable' | 'disable' | 'status';
  readonly bundleDir: string | undefined;
  readonly posture: Posture;
  readonly json: boolean;
  readonly errors: readonly string[];
}

function parseWebuiArgs(argv: readonly string[]): ParsedWebuiArgs {
  const errors: string[] = [];
  let subcommand: 'enable' | 'disable' | 'status' = 'status';
  let bundleDir: string | undefined;
  let lan = false;
  let loopback = false;
  let sawSubcommand = false;
  let json = false;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index] ?? '';
    if (arg === '--json') {
      json = true;
      continue;
    }
    if (arg === '--lan') {
      lan = true;
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
    if (arg === 'enable' || arg === 'disable' || arg === 'status') {
      subcommand = arg;
    } else {
      errors.push(`unknown subcommand: ${arg} (expected enable, disable or status)`);
    }
  }

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
  if (json && (subcommand !== 'status' || posture !== 'unchanged' || bundleDir !== undefined)) {
    errors.push('--json only supports the read-only status query, without bundle or exposure flags');
  }
  return { subcommand, bundleDir, posture, json, errors };
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
  const parsed = parseWebuiArgs(argv);
  if (parsed.errors.length > 0) {
    return {
      exitCode: 2,
      lines: [
        ...parsed.errors.map((error) => `webui: ${error}`),
        'Usage: goodvibes-daemon webui [enable|disable|status] [--bundle-dir <dir>] [--lan|--loopback]',
      ],
    };
  }

  const config = deps.configManager;
  const directoryExists = deps.directoryExists ?? ((path: string) => existsSync(path) && statSync(path).isDirectory());
  const fileExists = deps.fileExists ?? ((path: string) => existsSync(path) && statSync(path).isFile());
  const base = deps.baseDirectory ?? process.cwd();
  const probe = deps.probeStableHost ?? probeStableHostInputs;
  const absolute = (path: string): string => (isAbsolute(path) ? path : resolve(base, path));

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
        })],
      };
    }
    return renderStatus(config, { directoryExists, fileExists, absolute, probe });
  }

  if (parsed.subcommand === 'disable') {
    try {
      // `enable` declares the web surface too, so `disable` withdraws it in the
      // same write; otherwise status keeps reporting it enabled.
      config.setDaemonValues({ 'controlPlane.webui.serve': false, 'web.enabled': false });
    } catch (error) {
      return { exitCode: 1, lines: [`webui: could not write settings: ${message(error)}`] };
    }
    const kept = readString(config, 'controlPlane.webui.bundleDir');
    return {
      exitCode: 0,
      lines: [
        'web UI: no longer served by the daemon.',
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
  let hostInputs: StableHostInputs | undefined;
  const stableProbe = () => hostInputs ??= probe();
  const serving = servingOrigin(projected, stableProbe);
  const currentPublic = readString(config, 'web.publicBaseUrl');
  // Equality with the prior computed serving origin is a documented default-
  // continuation rule only during an explicit posture change, not provenance.
  // A distinct operator-selected URL remains authoritative.
  const followsPriorOrigin = parsed.posture !== 'unchanged'
    && currentPublic.replace(/\/+$/, '') === servingOrigin(config, stableProbe).origin;
  if (!currentPublic || currentPublic === SHIPPED_PUBLIC_BASE_URL || followsPriorOrigin) {
    values['web.publicBaseUrl'] = serving.origin;
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

  if (!Object.hasOwn(values, 'web.publicBaseUrl') && currentPublic !== serving.origin) {
    lines.push(`  note: web.publicBaseUrl is set to ${currentPublic}; links use that, the bundle is served at the URL above.`);
  }

  if (!serving.recognized) {
    lines.push('  note: controlPlane.hostMode is not one of local|network|custom; the daemon cannot bind until that is corrected.');
  }
  lines.push(...postureLines(serving.origin, serving.loopback, projected.get('controlPlane.enabled') === true, serving.alternate));
  // The daemon reads the serving settings per request and rebinds its listener on a host or port change.
  lines.push('  A running daemon applies this within about a second; no restart is needed.');
  return { exitCode: 0, lines };
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
  const currentPublic = readString(config, 'web.publicBaseUrl');
  if (currentPublic && currentPublic !== serving.origin) {
    lines.push(`  note: web.publicBaseUrl is ${currentPublic}; links use that, the bundle is served at the URL above.`);
  }
  lines.push(...postureLines(serving.origin, serving.loopback, config.get('controlPlane.enabled') === true, serving.alternate));
  return { exitCode: 0, lines };
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
