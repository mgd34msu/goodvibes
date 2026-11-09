/** Build-time evidence from an already produced native terminal. End-user
 * installers consume the pinned descriptor; they never build or guess support
 * by executing an older application's unknown command. */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { clientReaderPayloadPaths, clientReaderAsset, nativeReaderCapabilities, parseClientReaderArtifact, parseNativeReaderCapabilities,
  type ClientReaderArtifact, type ClientReaderPackage, type ClientReaderTarget } from '@goodvibes-jev/engine/platform/platform/runtime/self-update';
import { fileObservationIdentity } from '@goodvibes-jev/engine/platform/platform/utils';
import { writeFileAtomic } from '@goodvibes-jev/engine/platform/platform/utils';

export interface TerminalReaderSource {
  readonly sourceCommit: string;
  readonly sourceTree: string;
  readonly headCommit: string;
  readonly target: ClientReaderTarget;
}
export interface TerminalReaderArtifactInput extends TerminalReaderSource {
  readonly packageName: ClientReaderPackage;
  readonly version: string;
  /** Actual native output directory containing the already inspected cohort. */
  readonly directory: string;
  /** Pins already computed by this producer's artifact admission. */
  readonly files: ClientReaderArtifact['files'];
  /** Captured before this producer read or pinned the native payloads. */
  readonly assertCurrent: () => void;
}

export function retainTerminalReaderCohort(directory: string, packageName: ClientReaderPackage, target: ClientReaderTarget): () => void {
  const names = clientReaderPayloadPaths(packageName, target);
  const files = names.map(name => ({ path: join(directory, name), identity: fileObservationIdentity(join(directory, name)) }));
  return () => { for (const file of files) if (fileObservationIdentity(file.path) !== file.identity) throw new Error('Native terminal cohort changed'); };
}

/** Execute only the known current CI/release build on its native builder.
 * This never serves as a probe of arbitrary user-installed historical files. */
export function inspectTerminalReaderArtifact(input: TerminalReaderArtifactInput): ClientReaderArtifact {
  input.assertCurrent();
  if (input.target !== `${process.platform}-${process.arch}`) throw new Error('Compiled reader evidence requires its native build host');
  const asset = clientReaderAsset(input.packageName, input.target);
  const expectedPaths = clientReaderPayloadPaths(input.packageName, input.target);
  const files = expectedPaths.map(path => {
    const file = input.files.find(file => file.path === path);
    if (!file) throw new Error('Native terminal reader cohort is incomplete');
    return { ...file };
  });
  const expected = parseClientReaderArtifact({ schema: 1, packageName: input.packageName, version: input.version, target: input.target,
    sourceCommit: input.sourceCommit, sourceTree: input.sourceTree, headCommit: input.headCommit, files,
    readers: nativeReaderCapabilities(input.version) });
  const before = files.map(file => ({ path: join(input.directory, file.path), identity: fileObservationIdentity(join(input.directory, file.path)) }));
  const current = () => { for (const file of before) if (fileObservationIdentity(file.path) !== file.identity) throw new Error('Native terminal changed while recording its readers'); };
  current(); input.assertCurrent();
  const output = execFileSync(join(input.directory, asset), ['check-install-reader', '--describe'], {
    encoding: 'utf8', timeout: 15_000, maxBuffer: 32 * 1024, stdio: ['ignore', 'pipe', 'pipe'],
    env: { PATH: process.env['PATH'] ?? '/usr/bin:/bin', HOME: input.directory, LANG: 'C' },
  });
  current(); input.assertCurrent();
  const readers = parseNativeReaderCapabilities(JSON.parse(output));
  if (!isDeepStrictEqual(readers, expected.readers)) throw new Error('Compiled terminal readers differ from the release source');
  return expected;
}

export function recordTerminalReaderArtifact(input: TerminalReaderArtifactInput): void {
  const artifact = inspectTerminalReaderArtifact(input);
  writeFileAtomic(join(input.directory, 'reader-ci-artifact.json'), `${JSON.stringify(artifact, null, 2)}\n`, { mode: 0o644, assertCurrent: input.assertCurrent });
}

export function verifyTerminalReaderArtifact(input: TerminalReaderArtifactInput): ClientReaderArtifact {
  const stored = parseClientReaderArtifact(JSON.parse(readFileSync(join(input.directory, 'reader-ci-artifact.json'), 'utf8')));
  const actual = inspectTerminalReaderArtifact(input);
  if (!isDeepStrictEqual(stored, actual)) throw new Error('Restored terminal reader evidence differs from its source or native cohort');
  return stored;
}
