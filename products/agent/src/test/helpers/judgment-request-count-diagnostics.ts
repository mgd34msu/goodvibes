import { types } from 'node:util';
import { installJudgmentPort as nativeInstallJudgmentPort, judgmentPort } from '@goodvibes-jev/engine/errors';
import type { fakePort } from '@goodvibes-jev/judgment/testing';

type Fake = ReturnType<typeof fakePort>;
type Port = Parameters<typeof nativeInstallJudgmentPort>[0];
const identities = new WeakMap<object, number>();
let nextIdentity = 0, nextFixture = 0;
const installationEvents: { readonly fixture: number; readonly before: number | null;
  readonly requested: number | null; readonly after: number | null }[] = [];

// These names identify diagnostic display only. Every request still counts.
const batteryNames = new Set(['engine.tools.registry-rank', 'engine.redaction.field-kind',
  'engine.redaction.credential', 'engine.export.credential', 'engine.redaction.residual-credential',
  'engine.redaction.profile-distinctive', 'engine.gate.side-effect', 'engine.gate.risk-family',
  'engine.gate.boundary', 'engine.gate.autonomous-disposition']);
const questionNames = new Set(['match', 'kind', 'lineHasCredential', 'spanIsCredential', 'credentialRemains',
  'identifying', 'mutates', 'outward', 'secrets', 'obfuscated', 'capability', 'family', 'irreversible',
  'beyondProject', 'weakensSecurity', 'catastrophic', 'cardDetails', 'disposition']);

function identity(value: object | undefined): number | null {
  if (value === undefined) return null;
  let id = identities.get(value);
  if (id === undefined) { id = ++nextIdentity; identities.set(value, id); }
  return id;
}

function installedPort(): Port {
  try { return judgmentPort('agent.test.request-count-diagnostic'); }
  catch { return undefined; }
}

function object(value: unknown): value is object {
  return value !== null && (typeof value === 'object' || typeof value === 'function');
}

function dataField(value: unknown, key: string): unknown {
  if (!object(value) || types.isProxy(value)) return undefined;
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  return descriptor && 'value' in descriptor ? descriptor.value : undefined;
}

/** Diagnostic structure only; no content checksum, private keys or value text. */
function summarizeShape(value: unknown) {
  const seen = new WeakSet<object>();
  const shape = { nodes: 0, objects: 0, arrays: 0, strings: 0, stringCharacters: 0,
    dataSlots: 0, accessors: 0, proxies: 0, functions: 0, complete: true };
  function visit(item: unknown, depth: number): void {
    if (shape.nodes >= 4096 || depth > 64) { shape.complete = false; return; }
    shape.nodes++;
    if (item === null) return;
    if (typeof item === 'string') { shape.strings++; shape.stringCharacters += item.length; return; }
    if (typeof item === 'symbol') shape.complete = false;
    if (!object(item)) return;
    if (types.isProxy(item)) { shape.proxies++; shape.complete = false; return; }
    if (typeof item === 'function') { shape.functions++; shape.complete = false; return; }
    if (seen.has(item)) return;
    seen.add(item); shape.objects++;
    if (Array.isArray(item)) shape.arrays++;
    for (const key of Reflect.ownKeys(item)) {
      if (shape.nodes >= 4096) { shape.complete = false; break; }
      if (typeof key === 'symbol') shape.complete = false;
      const descriptor = Object.getOwnPropertyDescriptor(item, key);
      if (!descriptor) { shape.complete = false; continue; }
      if ('value' in descriptor) { shape.dataSlots++; visit(descriptor.value, depth + 1); }
      else { shape.accessors++; shape.complete = false; }
    }
  }
  visit(value, 0);
  return { shape };
}

function named(value: unknown, known: ReadonlySet<string>) {
  return typeof value === 'string' && known.has(value)
    ? { kind: 'known', id: value } : { kind: 'opaque', ...summarizeShape(value) };
}

function requestSummary(request: unknown) {
  const context = dataField(request, 'context'), questions = dataField(request, 'questions');
  const ids: ReturnType<typeof named>[] = [];
  if (object(questions) && !types.isProxy(questions)) {
    for (const key of Reflect.ownKeys(questions)) ids.push(named(key, questionNames));
  }
  return { battery: named(dataField(context, 'battery'), batteryNames), questionIds: ids,
    context: summarizeShape(context), questions: summarizeShape(questions), state: summarizeShape(dataField(request, 'state')) };
}

/** Attribution only: no reading captures, request wrappers, or answer changes. */
export function createRequestCountDiagnostics(file: string,
  emit: (line: string) => void = line => { process.stderr.write(`${line}\n`); }) {
  let fixture = { id: 0, closed: true };
  const creations = new WeakMap<Fake, { readonly fixture: typeof fixture; readonly creator: string;
    readonly fakeId: number | null; readonly portId: number | null }>();
  return {
    beginFixture() { fixture = { id: ++nextFixture, closed: false }; },
    endFixture() { fixture.closed = true; },
    installPort(port: Port): ReturnType<typeof nativeInstallJudgmentPort> {
      const before = identity(installedPort());
      try { return nativeInstallJudgmentPort(port); }
      finally {
        installationEvents.push({ fixture: fixture.id, before, requested: identity(port), after: identity(installedPort()) });
        if (installationEvents.length > 32) installationEvents.shift();
      }
    },
    track(fake: Fake, creator: string): Fake {
      creations.set(fake, { fixture, creator, fakeId: identity(fake), portId: identity(fake.port) });
      return fake;
    },
    reportUnexpectedCount(fake: Fake, expected: number, assertion: string): void {
      if (fake.requests.length === expected) return;
      try {
        const creation = creations.get(fake);
        const currentPortObjectId = identity(installedPort());
        const lastTrackedAfterPortObjectId = installationEvents.at(-1)?.after ?? null;
        const report = { diagnostic: 'judgment-request-count', file, assertion, expected, actual: fake.requests.length,
          creation: creation ? { fixture: creation.fixture.id, closed: creation.fixture.closed, creator: creation.creator,
            fakeId: creation.fakeId, portObjectId: creation.portId } : { kind: 'untracked' },
          currentFixture: { id: fixture.id, closed: fixture.closed }, currentPortObjectId, lastTrackedAfterPortObjectId,
          portMatchesLastTrackedInstall: installationEvents.length > 0 && currentPortObjectId === lastTrackedAfterPortObjectId,
          installationFacts: 'Observed public port objects and tracked fixture installs only; no native authority lease acquired.',
          installationEvents: [...installationEvents], requests: fake.requests.map(requestSummary) };
        emit(JSON.stringify(report));
      } catch {
        try { emit(JSON.stringify({ diagnostic: 'judgment-request-count-unavailable', file, assertion, expected,
          actual: fake.requests.length })); } catch { /* Preserve the original assertion if diagnostics cannot be written. */ }
      }
    },
  };
}
