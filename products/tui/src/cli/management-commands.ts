import { createCliSubscriptionView } from '@goodvibes-jev/engine/terminal-shell/cli-subscription-view';
import { findSessionCandidates } from '@goodvibes-jev/engine/sdk/platform/sessions';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { SecretsManager } from '../config/secrets.ts';
import {
  BUILTIN_SECRET_PROVIDER_SOURCES,
  describeSecretRef,
  isSecretRefInput,
  resolveSecretRef,
} from '@goodvibes-jev/engine/sdk/platform/config';
import '@goodvibes-jev/engine/sdk/platform/config';
import '@goodvibes-jev/engine/sdk/platform/config';
import '@/runtime/index.ts';
import {
  generateQrMatrix,
  renderQrToString,
  PAIRING_HANDOFF_OFFER_KINDS,
  type PairingHandoffOfferKind,
} from '@goodvibes-jev/engine/sdk/platform/pairing';
import { ensurePublicBaseUrl } from '@goodvibes-jev/engine/sdk/platform/pairing';
import { formatPairingOffers, formatPostureCapabilities, pairingPostureNotice } from '@goodvibes-jev/engine/sdk/platform/pairing';
import { defaultPairingTokenName } from '@goodvibes-jev/engine/sdk/platform/pairing';
import { stableUrlHostForBindHost } from '@goodvibes-jev/engine/sdk/platform/pairing';
import { formatRuntimeEndpointBinding, resolveRuntimeEndpointBinding } from '@goodvibes-jev/engine/terminal-shell';
import { classifyBindPosture, isNetworkFacing } from './network-posture.ts';
import type { CliCommandRuntime } from '@goodvibes-jev/engine/terminal-shell';
import type { RuntimeServices } from '../runtime/services.ts';
import {
  formatJsonOrText,
  openBrowser,
  probeTcp,
  readAuthPaths,
  readOptionValue,
  runNonInteractiveAgent,
  withRuntimeServices,
  yesNo,
} from './management-utils.ts';

export async function handleSecrets(runtime: CliCommandRuntime): Promise<string> {
  const secrets = new SecretsManager({
    projectRoot: runtime.workingDirectory,
    globalHome: runtime.homeDirectory,
    configManager: runtime.configManager,
  });
  const [sub = 'list', ...rest] = runtime.cli.commandArgs;
  if (sub === 'providers') {
    const value = { providers: BUILTIN_SECRET_PROVIDER_SOURCES };
    return formatJsonOrText(runtime.cli)(
      value,
      [
        'GoodVibes secret providers',
        ...BUILTIN_SECRET_PROVIDER_SOURCES.map((provider) => `  ${provider}`),
        '',
        'Secret refs use goodvibes://secrets/<source>/... and never embed secret values.',
      ].join('\n'),
    );
  }
  if (sub === 'test') {
    const ref = rest.join(' ').trim();
    if (!ref || !ref.startsWith('goodvibes://secrets/') || !isSecretRefInput(ref)) {
      return 'Usage: goodvibes secrets test goodvibes://secrets/<source>/...';
    }
    const resolved = await resolveSecretRef(ref, { resolveLocalSecret: (key) => secrets.get(key) });
    const value = { ref: describeSecretRef(ref), resolved: Boolean(resolved.value) };
    return formatJsonOrText(runtime.cli)(value, `[secrets] ${value.ref}: ${value.resolved ? 'resolved <redacted>' : 'missing'}`);
  }
  if (sub === 'set' || sub === 'link') {
    const flags = new Set(rest.filter((arg) => arg.startsWith('--')));
    const values = rest.filter((arg) => !arg.startsWith('--'));
    const [key, ...rawValueParts] = values;
    const value = rawValueParts.join(' ');
    if (!key || !value) return `Usage: goodvibes secrets ${sub} <KEY> <value> [--user|--project] [--secure|--plaintext]`;
    if (sub === 'link' && (!value.startsWith('goodvibes://secrets/') || !isSecretRefInput(value))) {
      return 'Invalid secret reference. Use goodvibes://secrets/<source>/...';
    }
    await secrets.set(key, value, {
      scope: flags.has('--user') ? 'user' : 'project',
      medium: flags.has('--plaintext') ? 'plaintext' : 'secure',
    });
    return `[secrets] ${sub === 'link' ? 'Linked' : 'Stored'}: ${key}`;
  }
  if (sub === 'delete') {
    const key = rest.find((arg) => !arg.startsWith('--'));
    if (!key) return 'Usage: goodvibes secrets delete <KEY> [--user|--project] [--secure|--plaintext]';
    const flags = new Set(rest.filter((arg) => arg.startsWith('--')));
    await secrets.delete(key, {
      scope: flags.has('--user') ? 'user' : flags.has('--project') ? 'project' : undefined,
      medium: flags.has('--secure') ? 'secure' : flags.has('--plaintext') ? 'plaintext' : undefined,
    });
    return `[secrets] Deleted: ${key}`;
  }
  const [records, review] = await Promise.all([secrets.listDetailed(), secrets.inspect()]);
  const stored = records.filter((record) => record.source !== 'env');
  const value = { policy: review.policy, records: stored, warnings: review.warnings };
  return formatJsonOrText(runtime.cli)(
    value,
    [
      'GoodVibes secrets',
      `  policy: ${review.policy}`,
      `  secure available: ${yesNo(review.secureAvailable)}`,
      `  stored keys: ${stored.length}`,
      ...stored.map(
        (record) =>
          `    ${record.key} (${record.source}${record.refSource ? `, ref:${record.refSource}` : ''}${record.overriddenByEnv ? ', env override' : ''})`,
      ),
      ...review.warnings.map((warning) => `  warning: ${warning}`),
    ].join('\n'),
  );
}

export async function handleSessions(runtime: CliCommandRuntime): Promise<string | null> {
  return await withRuntimeServices(runtime, (services) => {
    const [sub = 'list', ...rest] = runtime.cli.commandArgs;
    const sessions = services.sessionManager.list();
    if (sub === 'list') {
      const value = sessions;
      return formatJsonOrText(runtime.cli)(
        value,
        [
          `GoodVibes sessions (${sessions.length})`,
          ...sessions
            .slice(0, 50)
            .map(
              (session) =>
                `  ${session.name}  messages=${session.messageCount}  ${new Date(session.timestamp).toISOString()}  ${session.title || '(untitled)'}`,
            ),
        ].join('\n'),
      );
    }
    if (sub === 'show' || sub === 'info') {
      const target = rest.join(' ').trim();
      if (!target) return 'Usage: goodvibes sessions show <id|name>';
      const candidates = findSessionCandidates(sessions, target);
      if (candidates.length > 1)
        return `Ambiguous session: ${target}. Use an exact ID: ${candidates.map((session) => session.name).join(', ')}`;
      const found = candidates[0];
      if (!found) return `Session not found: ${target}`;
      return formatJsonOrText(runtime.cli)(
        found,
        [
          `Session ${found.name}`,
          `  title: ${found.title || '(untitled)'}`,
          `  messages: ${found.messageCount}`,
          `  provider/model: ${found.provider}/${found.model}`,
          `  updated: ${new Date(found.timestamp).toISOString()}`,
          `  file: ${found.filePath}`,
        ].join('\n'),
      );
    }
    if (sub === 'export') {
      const target = rest[0];
      const outputPath = rest[1];
      if (!target) return 'Usage: goodvibes sessions export <id|name> [path]';
      const candidates = findSessionCandidates(sessions, target);
      if (candidates.length > 1)
        return `Ambiguous session: ${target}. Use an exact ID: ${candidates.map((session) => session.name).join(', ')}`;
      const found = candidates[0];
      if (!found) return `Session not found: ${target}`;
      const data = services.sessionManager.load(found.name);
      const text = JSON.stringify({ name: found.name, ...data }, null, 2) + '\n';
      if (outputPath) {
        const targetPath = services.shellPaths.resolveWorkspacePath(outputPath);
        mkdirSync(dirname(targetPath), { recursive: true });
        writeFileSync(targetPath, text, 'utf-8');
        return `Session exported: ${targetPath}`;
      }
      return text.trimEnd();
    }
    if (sub === 'resume') {
      const target = rest.join(' ').trim();
      return target ? null : 'Usage: goodvibes sessions resume <id|name>';
    }
    return 'Usage: goodvibes sessions list|show <id>|export <id> [path]|resume <id>';
  });
}

export async function handleTasks(runtime: CliCommandRuntime): Promise<string> {
  const [sub = 'list', ...rest] = runtime.cli.commandArgs;
  if (sub === 'submit') {
    const prompt = rest.join(' ').trim();
    if (!prompt) return 'Usage: goodvibes tasks submit <prompt>';
    const runCli = {
      ...runtime.cli,
      command: 'run' as const,
      flags: { ...runtime.cli.flags, prompt },
      positionals: [prompt],
    };
    const code = await runNonInteractiveAgent({ ...runtime, cli: runCli });
    return code === 0 ? '' : `Task submit failed with exit code ${code}`;
  }
  return await withRuntimeServices(runtime, (services) => {
    const tasks = [...services.runtimeStore.getState().tasks.tasks.values()];
    if (sub === 'list') {
      return tasks.length === 0
        ? 'GoodVibes tasks\n  No in-process runtime tasks are currently recorded.'
        : ['GoodVibes tasks', ...tasks.map((task) => `  ${task.id} ${task.status} ${task.kind} ${task.title}`)].join('\n');
    }
    if (sub === 'show') {
      if (!rest[0]) return 'Usage: goodvibes tasks show <taskId>';
      const task = tasks.find((candidate) => candidate.id === rest[0]);
      return task ? JSON.stringify(task, null, 2) : `Unknown task: ${rest[0] ?? ''}`;
    }
    return 'Usage: goodvibes tasks list|show <taskId>|submit <prompt>';
  });
}

export interface ControlPlaneStatusResult {
  readonly enabled: unknown;
  readonly hostMode: string;
  readonly configuredHost: string;
  readonly host: string;
  readonly port: number;
  readonly recognized: boolean;
  readonly posture: ReturnType<typeof classifyBindPosture>;
  /** undefined = NOT PROBED (unrecognized host mode), a tri-state, never coerced to false. */
  readonly reachable: boolean | undefined;
  readonly auth: ReturnType<typeof readAuthPaths>;
  readonly service: {
    readonly enabled: unknown;
    readonly autostart: unknown;
    readonly restartOnFailure: unknown;
  };
  readonly issues: readonly string[];
}

export async function buildControlPlaneStatusResult(runtime: CliCommandRuntime): Promise<ControlPlaneStatusResult> {
  const binding = resolveRuntimeEndpointBinding(runtime.configManager, 'controlPlane');
  const enabled = runtime.configManager.get('controlPlane.enabled');
  // Never TCP-probe the fallback endpoint of an unrecognized hostMode, a
  // probe asserts a binding that does not exist. Not-probed is its own state
  // (undefined), NEVER coerced to a definite false: a daemon launched with
  // flag overrides can be serving healthily regardless of the stored mode.
  const reachable = enabled === true ? (binding.recognized ? await probeTcp(binding.host, binding.port) : undefined) : false;
  const auth = readAuthPaths(runtime);
  const service = {
    enabled: runtime.configManager.get('service.enabled'),
    autostart: runtime.configManager.get('service.autostart'),
    restartOnFailure: runtime.configManager.get('service.restartOnFailure'),
  };
  const issues: string[] = [];
  if (!binding.recognized)
    issues.push(
      `controlPlane.hostMode '${binding.hostMode}' is not a recognized mode (local|network|custom); the daemon cannot bind until it is corrected.`,
    );
  if (enabled === true && binding.recognized && !reachable)
    issues.push(`Control plane is enabled but not reachable on ${binding.host}:${binding.port}.`);
  if (enabled === true && service.enabled !== true) issues.push('Control plane is enabled but service mode is off.');
  if (enabled === true && service.autostart !== true) issues.push('Control plane is enabled but service autostart is off.');
  if (enabled === true && service.restartOnFailure !== true) issues.push('Control plane is enabled but service restart-on-failure is off.');
  if (isNetworkFacing(enabled, binding) && !auth.userStorePresent)
    issues.push('Network-facing control plane has no local auth user store.');
  if (isNetworkFacing(enabled, binding) && auth.bootstrapCredentialPresent)
    issues.push('Network-facing control plane still has a bootstrap credential file.');
  return {
    enabled,
    ...binding,
    posture: classifyBindPosture(binding),
    reachable,
    auth,
    service,
    issues,
  };
}

export function formatControlPlaneStatus(runtime: CliCommandRuntime, value: ControlPlaneStatusResult): string {
  return formatJsonOrText(runtime.cli)(
    value,
    [
      'GoodVibes control-plane status',
      `  enabled: ${yesNo(value.enabled)}`,
      `  bind: ${formatRuntimeEndpointBinding(value)}`,
      `  bind posture: ${value.recognized ? value.posture.label : 'unknown (unrecognized host mode)'}`,
      `  reachable: ${value.reachable === undefined ? 'not probed (unrecognized host mode)' : yesNo(value.reachable)}`,
      `  service: enabled=${yesNo(value.service.enabled)} autostart=${yesNo(value.service.autostart)} restartOnFailure=${yesNo(value.service.restartOnFailure)}`,
      `  local auth users: ${value.auth.userStorePresent ? 'present' : 'missing'}`,
      `  bootstrap credential: ${value.auth.bootstrapCredentialPresent ? 'present' : 'missing'}`,
      `  operator tokens: ${value.auth.operatorTokenPresent ? 'present' : 'missing'}`,
      value.issues.length === 0 ? '  readiness: ready' : '  readiness: needs attention',
      ...value.issues.map((issue) => `    - ${issue}`),
    ].join('\n'),
  );
}

export async function renderControlPlaneStatus(runtime: CliCommandRuntime): Promise<string> {
  return formatControlPlaneStatus(runtime, await buildControlPlaneStatusResult(runtime));
}

interface PairingHandoffCreateResult {
  readonly token: { readonly id: string; readonly name: string; readonly token: string };
  readonly offers: readonly { readonly kind: PairingHandoffOfferKind }[];
  readonly fragment: string;
  readonly deepLink?: string | undefined;
  /** The honest TLS/capability posture of the origin the QR points at (SDK-computed). */
  readonly posture?: import('@goodvibes-jev/engine/sdk/platform/pairing').OriginPosture | undefined;
}

export async function renderPairing(runtime: CliCommandRuntime): Promise<string> {
  return await withRuntimeServices(runtime, async (services) => {
    // Freeze a stable web origin once (never clobbering a user-set value) so the
    // printed link and the daemon's own handoff origin agree and survive a DHCP
    // lease change where a stable name exists. The verb re-derives the same origin
    // and returns its honest posture, so this call is a persistence side effect.
    ensurePublicBaseUrl(runtime.configManager);
    const name = readOptionValue(runtime.cli.commandArgs, '--name') ?? defaultPairingTokenName();
    // Mint through the canonical hand-off verb ON THE DAEMON: the deep link
    // pairs a device to the daemon-hosted web app, and the offer set (push,
    // relay, passkey) is the daemon's to filter to what it can satisfy. The
    // local `services.gatewayMethods` catalog is deliberately empty in this
    // surface (see runtime/services.ts), so invoking it answered
    // "no internal handler" for every verb; the daemon verb caller is the
    // canonical route and refuses honestly when no daemon is reachable.
    const result = await services.daemonVerbs.invoke<PairingHandoffCreateResult>('pairing.handoff.create', {
      name,
      offers: [...PAIRING_HANDOFF_OFFER_KINDS],
    });
    const link = result.deepLink ?? result.fragment;
    const qr = renderQrToString(generateQrMatrix(link));
    const lines: string[] = [
      'Scan to pair a device; the QR opens the web app already signed in:',
      '',
      `  ${link}`,
      `  Token name: ${result.token.name}  (rename or revoke later in /settings → security → devices)`,
    ];
    if (result.offers.length > 0) {
      lines.push(
        '',
        'Offers carried in this pairing (each declinable in the web app):',
        ...formatPairingOffers(result.offers.map((o) => o.kind)),
      );
    }
    // The labeled browser-capability list and the one honest LAN line both render
    // from the SDK posture the verb returned, never a locally-authored string.
    const capabilities = formatPostureCapabilities(result.posture);
    if (capabilities.length > 0) lines.push('', 'This device will get:', ...capabilities);
    const notice = pairingPostureNotice(result.posture);
    if (notice) lines.push('', notice);
    // Tailscale detection is read-only here (the interactive serve lives in the
    // pairing modal); when detected with an https MagicDNS URL, name the encrypted
    // path. Absence stays quiet.
    lines.push(...(await renderPairingTailscaleLines(services)));
    lines.push('', qr);
    return lines.join('\n');
  });
}

interface TailscaleGetResult {
  readonly available: boolean;
  readonly httpsUrl?: string | undefined;
  readonly detail: string;
}

/**
 * Read-only tailscale detection for the `gv pair` block: when tailscale is
 * available with a served https MagicDNS URL, name the encrypted path (the
 * interactive one-action serve lives in the pairing modal). Quiet, an empty
 * array, when tailscale is absent or the probe fails.
 */
async function renderPairingTailscaleLines(services: RuntimeServices): Promise<string[]> {
  try {
    const ts = await services.daemonVerbs.invoke<TailscaleGetResult>('tailscale.get', {});
    if (!ts.available) return [];
    if (ts.httpsUrl) return ['', `Encrypted access (Tailscale): ${ts.httpsUrl}`];
    return ['', 'Tailscale detected: run it as a serve target for encrypted https access (see the pairing modal).'];
  } catch {
    return [];
  }
}

export async function renderRemote(runtime: CliCommandRuntime, label: 'remote' | 'bridge'): Promise<string> {
  return await withRuntimeServices(runtime, (services) => {
    const pools = services.remoteRunnerRegistry.listPools?.() ?? [];
    const contracts = services.remoteRunnerRegistry.listContracts();
    const artifacts = services.remoteRunnerRegistry.listArtifacts();
    const value = {
      pools: pools.length,
      contracts: contracts.length,
      artifacts: artifacts.length,
      remoteFetchPrivateHosts: runtime.configManager.get('network.remoteFetch.allowPrivateHosts'),
    };
    return formatJsonOrText(runtime.cli)(
      value,
      [
        `GoodVibes ${label} status`,
        `  runner pools: ${value.pools}`,
        `  contracts: ${value.contracts}`,
        `  review artifacts: ${value.artifacts}`,
        `  private-host remote fetch: ${yesNo(value.remoteFetchPrivateHosts)}`,
      ].join('\n'),
    );
  });
}

export function renderWeb(runtime: CliCommandRuntime): string {
  const binding = resolveRuntimeEndpointBinding(runtime.configManager, 'web');
  const publicBaseUrl = String(runtime.configManager.get('web.publicBaseUrl') ?? '');
  const hasEndpointOverride = runtime.cli.flags.hostname !== undefined || runtime.cli.flags.port !== undefined;
  // Prefer the stable-name resolution over the raw first-non-internal IPv4 so the
  // printed URL survives a DHCP lease change where a stable name exists.
  const url =
    !hasEndpointOverride && publicBaseUrl ? publicBaseUrl : `http://${stableUrlHostForBindHost(binding.host).host}:${binding.port}`;
  const value = {
    enabled: runtime.configManager.get('web.enabled'),
    ...binding,
    url,
  };
  return formatJsonOrText(runtime.cli)(
    value,
    [
      'GoodVibes web',
      `  enabled: ${yesNo(value.enabled)}`,
      `  bind: ${formatRuntimeEndpointBinding(value)}`,
      `  url: ${value.url}`,
      ...(runtime.cli.flags.open ? [`  open: ${openBrowser(value.url)}`] : []),
    ].join('\n'),
  );
}

export const { renderSubscriptions } = createCliSubscriptionView<CliCommandRuntime, RuntimeServices>(withRuntimeServices, {
  inline: true,
  manualOnly: false,
  binary: () => 'goodvibes',
  source: (source) => source,
  time: (timestamp) => new Date(timestamp).toISOString(),
});
