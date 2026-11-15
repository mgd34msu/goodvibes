import { commandJsonOrText as formatJsonOrText } from '@goodvibes-jev/engine/terminal-shell/cli-output';
import { readFileSync } from 'node:fs';
import {
  parseMarketplaceIndex,
  fetchAndVerifyBundle,
  readBundleArchive,
  validateCapabilityBundleManifest,
  planBundleActivation,
  installVerifiedBundle,
  listInstalledEcosystemEntries,
  BundlePinRefusal,
  type PinnedBundleSource,
  type PinnedMarketplaceIndexEntry,
  type BundleActivationPlan,
  type EcosystemInstallReceipt,
} from '@goodvibes-jev/engine/platform/platform/runtime/ecosystem';
import { summarizeError } from '@goodvibes-jev/engine/platform/platform/utils';
import type { CliCommandOutput, CliCommandRuntime } from '@goodvibes-jev/engine/terminal-shell';

// ---------------------------------------------------------------------------
// `goodvibes plugin bundles browse|install|list`, the capability-bundle
// marketplace surface. Extends the existing plugin-command.ts family with the
// platform's SHA-256-pinned bundle distribution (platform/runtime/ecosystem):
// parseMarketplaceIndex, fetchAndVerifyBundle, planBundleActivation. There is
// deliberately NO flag that bypasses a pin mismatch, `install` either
// verifies or refuses; `--yes` only confirms an ALREADY-verified activation
// plan, it never substitutes for the pin. A confirmed install unpacks the
// verified archive into the same install directories, receipts, backups and
// rollback `/marketplace` uses; the receipt carries the pin and the grant.
// ---------------------------------------------------------------------------

/** A source is a git remote when a ref is given, an http(s) URL, or a file path. */
function inferSourceKind(ref: string, gitRef: string | undefined): PinnedBundleSource['kind'] {
  if (gitRef !== undefined) return 'git';
  return ref.startsWith('http://') || ref.startsWith('https://') ? 'url' : 'file';
}

function ecosystemPaths(runtime: CliCommandRuntime): { cwd: string; homeDir: string } {
  return { cwd: runtime.workingDirectory, homeDir: runtime.homeDirectory };
}

async function readIndexBytes(ref: string): Promise<string> {
  if (inferSourceKind(ref, undefined) === 'url') {
    const res = await fetch(ref);
    if (!res.ok) throw new Error(`URL '${ref}' returned HTTP ${res.status}`);
    return res.text();
  }
  return readFileSync(ref, 'utf-8');
}

function summarizeCapabilities(summary: PinnedMarketplaceIndexEntry['capabilities']): string {
  const parts = [
    `tools:${summary.toolCount}`,
    `hooks:${summary.hookCount}`,
    `configDomains:${summary.configDomainCount}`,
    `channels:${summary.channelCount}`,
  ];
  if (summary.runtime.length > 0) parts.push(`runtime:${summary.runtime.join('+')}`);
  if (summary.highRisk) parts.push('HIGH-RISK');
  return parts.join(' ');
}

async function handleBrowse(runtime: CliCommandRuntime, ref: string | undefined): Promise<CliCommandOutput> {
  if (!ref) return { output: 'Usage: goodvibes plugin bundles browse <index-url-or-file>', exitCode: 2 };
  let raw: string;
  try {
    raw = await readIndexBytes(ref);
  } catch (error) {
    return { output: `Could not read marketplace index '${ref}': ${summarizeError(error)}`, exitCode: 1 };
  }
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch (error) {
    return { output: `Marketplace index at '${ref}' is not valid JSON: ${summarizeError(error)}`, exitCode: 1 };
  }
  const result = parseMarketplaceIndex(value);
  if (!result.ok) {
    return {
      output: formatJsonOrText(
        runtime,
        result,
        [
          `Marketplace index at '${ref}' was refused (a governed index requires a SHA-256 pin + capability summary on every entry):`,
          ...result.errors.map((e) => `  - ${e}`),
        ].join('\n'),
      ),
      exitCode: 1,
    };
  }
  const { bundles } = result.index;
  if (bundles.length === 0) {
    return { output: formatJsonOrText(runtime, result.index, `Marketplace index at '${ref}': no bundles listed.`), exitCode: 0 };
  }
  const lines = [`Marketplace index at '${ref}' (${bundles.length} bundle${bundles.length === 1 ? '' : 's'}):`];
  for (const entry of bundles) {
    lines.push(
      `  ${entry.id}: ${entry.name} v${entry.version} (${entry.kind})`,
      `    ${entry.summary}`,
      `    capabilities: ${summarizeCapabilities(entry.capabilities)}`,
      `    pin: sha256:${entry.source.sha256} (${entry.source.kind}: ${entry.source.location})`,
    );
  }
  return { output: formatJsonOrText(runtime, result.index, lines.join('\n')), exitCode: 0 };
}

/** Render an activation plan (granted capabilities, withheld/quarantined ones) for confirmation. */
function renderPlan(plan: BundleActivationPlan, committed: boolean): string {
  const lines = [
    `${committed ? 'Installed' : 'Activation plan (preview; re-run with --yes to install it)'}: ${plan.manifest.id} v${plan.manifest.version} (${plan.manifest.kind})`,
    `  trust tier: ${plan.trustTier}`,
    `  declared runtime capabilities: ${plan.manifest.capabilities.runtime.join(', ') || 'none'}`,
    `  declared tools: ${plan.manifest.capabilities.tools.join(', ') || 'none'}`,
    `  declared hooks: ${plan.manifest.capabilities.hooks.join(', ') || 'none'}`,
    `  declared configDomains: ${plan.manifest.capabilities.configDomains.join(', ') || 'none'}`,
    `  declared channels: ${plan.manifest.capabilities.channels.join(', ') || 'none'}`,
    `  granted capabilities: ${plan.capabilityManifest.granted.join(', ') || 'none'}`,
  ];
  if (plan.quarantine.required) {
    lines.push(
      `  QUARANTINED: yes; ${plan.quarantine.reason ?? 'over-reached its trust tier'}`,
      `  withheld capabilities: ${plan.quarantine.revokedCapabilities.join(', ')}`,
    );
  } else {
    lines.push('  quarantined: no; every declared capability fit the trust tier');
  }
  return lines.join('\n');
}

async function handleInstall(runtime: CliCommandRuntime, ref: string | undefined, sha256: string | undefined, gitRef: string | undefined): Promise<CliCommandOutput> {
  if (!ref || !sha256) {
    return {
      output: 'Usage: goodvibes plugin bundles install <ref> --sha256 <pin> [--ref <git-ref>]  (the pin is required; there is no unpinned install path)',
      exitCode: 2,
    };
  }
  const kind = inferSourceKind(ref, gitRef);
  const source: PinnedBundleSource = { kind, location: ref, sha256, ...(gitRef === undefined ? {} : { ref: gitRef }) };
  let bytes: Uint8Array;
  try {
    const fetched = await fetchAndVerifyBundle(source);
    bytes = fetched.bytes;
  } catch (error) {
    if (error instanceof BundlePinRefusal) {
      return {
        output: formatJsonOrText(runtime, { ok: false, source, verification: error.verification }, `Refused: ${error.message}`),
        exitCode: 1,
      };
    }
    return { output: `Could not fetch bundle from '${ref}': ${summarizeError(error)}`, exitCode: 1 };
  }
  let archive: ReturnType<typeof readBundleArchive>;
  try {
    archive = readBundleArchive(bytes);
  } catch (error) {
    return { output: `Bundle at '${ref}' was refused: ${summarizeError(error)}`, exitCode: 1 };
  }
  const validation = validateCapabilityBundleManifest(archive.manifest);
  if (!validation.ok) {
    return {
      output: formatJsonOrText(
        runtime,
        validation,
        [`Bundle manifest at '${ref}' was refused:`, ...validation.errors.map((e) => `  - ${e}`)].join('\n'),
      ),
      exitCode: 1,
    };
  }
  const plan = planBundleActivation(validation.manifest);
  // --yes installs the plan as shown, quarantine included: the withheld
  // capabilities stay withheld in the receipt, so a script or agent that
  // passed --yes gets the same install a person at a terminal would.
  const committed = runtime.cli.flags.yes;
  if (!committed) return { output: formatJsonOrText(runtime, { ok: true, committed, plan }, renderPlan(plan, false)), exitCode: 0 };
  const { manifest } = plan;
  const installed = installVerifiedBundle({
    id: manifest.id, kind: manifest.kind, name: manifest.name, version: manifest.version, description: manifest.description,
    ...(manifest.author ? { author: manifest.author } : {}),
    files: archive.files,
    grant: {
      source,
      trustTier: plan.trustTier,
      granted: [...plan.capabilityManifest.granted],
      withheld: [...plan.quarantine.revokedCapabilities],
      quarantined: plan.quarantine.required,
      tools: [...manifest.capabilities.tools],
      hooks: [...manifest.capabilities.hooks],
      configDomains: [...manifest.capabilities.configDomains],
      channels: [...manifest.capabilities.channels],
    },
  }, ecosystemPaths(runtime));
  if (!installed.ok) return { output: formatJsonOrText(runtime, { ok: false, error: installed.error }, installed.error), exitCode: 1 };
  const text = `${renderPlan(plan, true)}\n  installed at: ${installed.receipt.targetPath}\n  undo: /marketplace rollback ${manifest.kind} ${manifest.id} ${installed.receipt.scope} (or uninstall)`;
  return { output: formatJsonOrText(runtime, { ok: true, committed, plan, receipt: installed.receipt }, text), exitCode: 0 };
}

function installedBundles(runtime: CliCommandRuntime): EcosystemInstallReceipt[] {
  const paths = ecosystemPaths(runtime);
  return (['plugin', 'skill', 'hook-pack', 'policy-pack'] as const)
    .flatMap((kind) => listInstalledEcosystemEntries(kind, paths))
    .filter((receipt) => receipt.bundle !== undefined);
}

function handleList(runtime: CliCommandRuntime): CliCommandOutput {
  const receipts = installedBundles(runtime);
  if (receipts.length === 0) {
    return { output: formatJsonOrText(runtime, receipts, 'No capability bundles installed.'), exitCode: 0 };
  }
  const lines = [`Installed capability bundles (${receipts.length}):`];
  for (const receipt of receipts) {
    const grant = receipt.bundle!;
    lines.push(
      `  ${receipt.entry.id}: ${receipt.entry.name} v${receipt.entry.version ?? '?'} (${receipt.kind}, ${receipt.scope})`,
      `    installedAt: ${new Date(receipt.installedAt).toISOString()} at ${receipt.targetPath}`,
      `    source: ${grant.source.kind}:${grant.source.location}${grant.source.ref ? `@${grant.source.ref}` : ''} (sha256:${grant.source.sha256})`,
      `    granted: ${grant.granted.join(', ') || 'none'}; quarantined: ${grant.quarantined ? `yes (withheld: ${grant.withheld.join(', ')})` : 'no'}`,
    );
  }
  return { output: formatJsonOrText(runtime, receipts, lines.join('\n')), exitCode: 0 };
}

export async function handlePluginBundlesCommand(runtime: CliCommandRuntime, args: readonly string[]): Promise<CliCommandOutput> {
  const [sub, ...rest] = args;
  if (sub === 'browse') return handleBrowse(runtime, rest[0]);
  if (sub === 'install') {
    const valueFlags = new Set<number>();
    const flag = (name: string): string | undefined => {
      const index = rest.indexOf(name);
      if (index < 0) return undefined;
      valueFlags.add(index).add(index + 1);
      return rest[index + 1];
    };
    const sha256 = flag('--sha256');
    const gitRef = flag('--ref');
    const ref = rest.find((token, i) => !valueFlags.has(i) && !token.startsWith('-'));
    return handleInstall(runtime, ref, sha256, gitRef);
  }
  if (sub === 'list') return handleList(runtime);
  return { output: 'Usage: goodvibes plugin bundles browse <index-url-or-file>|install <ref> --sha256 <pin> [--ref <git-ref>]|list', exitCode: 2 };
}
