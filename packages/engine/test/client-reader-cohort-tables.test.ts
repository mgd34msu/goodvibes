/**
 * The installed-member to published-asset mapping is declared twice: in the
 * release scripts (publication) and here (producer and reader). They must name
 * the same members for every program and platform, or a cohort change that the
 * producer accepts fails only on release day.
 */
import { expect, test } from 'bun:test';
import { join } from 'node:path';
import {
  clientReaderAsset, clientReaderMemberAsset, clientReaderPayloadPaths, parseClientReaderArtifact,
  type ClientReaderPackage, type ClientReaderTarget,
} from '../platform/src/platform/runtime/client-reader-artifact.ts';
import { resolveDaemonNativePayloads } from '../platform/src/platform/runtime/daemon-native-cohort.ts';
import { nativeReaderCapabilities } from '../platform/src/platform/runtime/native-reader-compatibility.ts';

const scripts = join(import.meta.dir, '..', '..', '..', '.github', 'scripts');
const packages: readonly ClientReaderPackage[] = ['@goodvibes-jev/tui', '@goodvibes-jev/agent', '@goodvibes-jev/daemon'];
const targets: readonly ClientReaderTarget[] = ['linux-x64', 'linux-arm64', 'darwin-x64', 'darwin-arm64'];

/** What the release script says each program's evidence file must pin, keyed by evidence file name. */
function publishedMembers(names: readonly string[]): Record<string, Record<string, string>> {
  const program = [
    'import json, sys',
    'sys.path.insert(0, sys.argv[1])',
    'from release_asset_pins import reader_member_assets',
    'print(json.dumps({name: reader_member_assets(name) for name in sys.argv[2:]}))',
  ].join('\n');
  const run = Bun.spawnSync(['python3', '-I', '-B', '-c', program, scripts, ...names]);
  if (run.exitCode !== 0) throw new Error(`the release script could not be read: ${run.stderr.toString()}`);
  return JSON.parse(run.stdout.toString()) as Record<string, Record<string, string>>;
}

function producerMembers(packageName: ClientReaderPackage, target: ClientReaderTarget): Record<string, string> {
  if (packageName === '@goodvibes-jev/daemon' && target.startsWith('linux-')) {
    const payloads = resolveDaemonNativePayloads('linux', target.slice('linux-'.length));
    return Object.fromEntries((payloads ?? []).map((payload) => [payload.relativePath, payload.assetName]));
  }
  return Object.fromEntries(clientReaderPayloadPaths(packageName, target).map((path) => [path, clientReaderMemberAsset({ packageName, target }, path)]));
}

test('the release script and the producer name the same cohort members for every program and platform', () => {
  const cases = packages.flatMap((packageName) => targets.map((target) => ({
    packageName, target, evidence: `${clientReaderAsset(packageName, target)}.reader-ci-artifact.json`,
  })));
  const published = publishedMembers(cases.map((entry) => entry.evidence));
  for (const { packageName, target, evidence } of cases) {
    expect({ evidence, members: published[evidence] }).toEqual({ evidence, members: producerMembers(packageName, target) });
  }
});

test('reader evidence that names fewer members than its cohort is refused', () => {
  const packageName = '@goodvibes-jev/tui' as const;
  const target = 'linux-x64' as const;
  const [launcher] = clientReaderPayloadPaths(packageName, target);
  const raw = {
    schema: 1, packageName, target, version: '3.1.2',
    sourceCommit: 'a'.repeat(40), sourceTree: 'b'.repeat(40), headCommit: 'a'.repeat(40),
    readers: nativeReaderCapabilities('3.1.2'),
    files: [{ path: launcher!, sha256: 'c'.repeat(64), size: 64, mode: 0o755 }],
  };
  expect(() => parseClientReaderArtifact(raw)).toThrow();
});
