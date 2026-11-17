/**
 * gateway-verb-required-conformance.test.ts
 *
 * The gate for one defect class: a gateway verb whose route handler refuses a
 * field its method-catalog descriptor never declared `required`.
 *
 * That pairing is invisible until runtime. `inputSchema.required` is what
 * packages/contracts turns into the typed IO consumers compile against, and
 * what `invoke-input-validation.ts` enforces before dispatch; the handler is
 * what actually decides. When they disagree, every consumer type-checks clean
 * and every consumer gets a 400. The control plane has produced that exact
 * defect three separate times, each caught by a person reading one file, which
 * is why this test exists rather than a fourth reading.
 *
 * It works by INVOKING every handler-registered verb with exactly the fields
 * its descriptor declares required and asserting the handler does not then
 * demand something else. See `_helpers/gateway-verb-required-probe.ts` for why
 * a running probe rather than a static rule, and for what the probe does not
 * claim to cover.
 *
 * Three things make the green here mean something:
 *   - Every probed verb lands in exactly one verdict and the totals are
 *     asserted, so nothing is skipped without the count moving.
 *   - A refusal that names no field is `unattributed-refusal`, and the set of
 *     those is a closed, enumerated list with a stated reason each. A new one
 *     fails the test instead of passing quietly.
 *   - The registrar inventory is checked against the routes directory, so a new
 *     verb family cannot arrive unprobed.
 */
import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { classifyInputSchema } from '../platform/src/platform/control-plane/invoke-input-validation.js';
import { GatewayMethodCatalog } from '../platform/src/platform/control-plane/method-catalog.js';
import { GatewayVerbError } from '../platform/src/platform/control-plane/routes/gateway-verb-error.js';
import {
  EXPECTED_ROUTE_REGISTRARS,
  buildProbeCatalog,
  probeAllHandlerVerbs,
  probeVerb,
  type VerbConformance,
} from './_helpers/gateway-verb-required-probe.js';

const ROUTES_DIR = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../platform/src/platform/control-plane/routes',
);

/** Registrar names follow this shape; the parser decides what is a declaration. */
const REGISTRAR_NAME = /^register\w*(?:GatewayMethods|Verbs|VerbGroups)$/;

/**
 * Every exported `register…` function DECLARED in a directory's TypeScript
 * files, found by parsing each file and walking its top-level statements.
 *
 * The parser is what makes this trustworthy: comments and string literals are
 * not statements, so prose describing a registrar, including a removed one,
 * cannot be mistaken for the real thing.
 */
function collectExportedRegistrars(directory: string): Set<string> {
  const found = new Set<string>();
  for (const file of readdirSync(directory)) {
    if (!file.endsWith('.ts')) continue;
    const path = join(directory, file);
    const source = ts.createSourceFile(
      path,
      readFileSync(path, 'utf8'),
      ts.ScriptTarget.Latest,
      /* setParentNodes */ true,
      ts.ScriptKind.TS,
    );
    for (const statement of source.statements) {
      if (!ts.isFunctionDeclaration(statement) || statement.name === undefined) continue;
      const exported = ts.getModifiers(statement)?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword) ?? false;
      if (!exported) continue;
      const name = statement.name.text;
      if (REGISTRAR_NAME.test(name)) found.add(name);
    }
  }
  return found;
}

/**
 * Input-shaped refusals that legitimately name no field, each with the reason.
 * A refusal about the state of the world is not a statement about the caller's
 * input shape, so there is no field to attribute it to, but the set has to
 * stay closed, or "no field" becomes a way to opt out of the gate.
 */
const ALLOWED_UNATTRIBUTED_REFUSALS: Readonly<Record<string, string>> = {
  'calendar.events.update':
    'Takes any one or more of title, start, end, description, location or attendees. The refusal is that '
    + 'none was sent, a statement about the combination: no single field is missing, and declaring any one '
    + 'of them required would refuse an update that changes only another.',
  'profile.forget':
    'Takes EITHER a fieldId OR a section plus the exact text of the line. The refusal is about the '
    + 'combination, so no single field name is the honest answer and no single entry in the descriptor\'s '
    + 'required array could express it, declaring fieldId required would break the section+text path, '
    + 'which is the one that removes a prose line.',
};

/**
 * Verbs whose handler lets a plain `Error` escape under the probe. A plain
 * `Error` is how a handler words a refusal, and the probe cannot tell whether
 * it is about the caller's input or about the state of the world, so the set
 * is closed: each entry says why the throw is not an input refusal.
 */
const ALLOWED_PLAIN_THROWS: Readonly<Record<string, string>> = {
  'occasions.plans.list':
    'Refuses because the probe invocation carries no authority check for the profile read (native-profile-mutation.ts), not because of the input.',
  'profile.person':
    'Refuses because the stub profile service is not the person source the handler was bound to (owner-profile-policy.ts), not because of the input.',
};

let cachedResults: readonly VerbConformance[] | null = null;
async function results(): Promise<readonly VerbConformance[]> {
  cachedResults ??= await probeAllHandlerVerbs(await buildProbeCatalog());
  return cachedResults;
}

function describeGap(entry: VerbConformance): string {
  return `${entry.id}: handler refuses without "${String(entry.field)}" (${String(entry.code)}: ${String(entry.message)}) `
    + `but its descriptor declares required=[${entry.declaredRequired.join(', ')}]. `
    + 'Add the field to the descriptor\'s required array so consumers get a compile error, not a runtime 400.';
}

describe('gateway verb required-field conformance', () => {
  test('no handler enforces a field its descriptor does not declare required', async () => {
    const gaps = (await results()).filter((entry) => entry.verdict === 'undeclared-requirement');
    expect(gaps.map(describeGap)).toEqual([]);
  });

  test('every input-shaped refusal names the field it is about', async () => {
    const unattributed = (await results()).filter((entry) => entry.verdict === 'unattributed-refusal');
    const undocumented = unattributed
      .filter((entry) => !Object.hasOwn(ALLOWED_UNATTRIBUTED_REFUSALS, entry.id))
      .map((entry) =>
        `${entry.id}: refused with ${String(entry.code)} ("${String(entry.message)}") without setting GatewayVerbError.field. `
        + 'The probe cannot tell whether this is an undeclared required field or a refusal about the state of the world. '
        + 'Pass the field name as the 4th GatewayVerbError argument, or add an entry to ALLOWED_UNATTRIBUTED_REFUSALS saying why there is none.');
    expect(undocumented).toEqual([]);
  });

  test('the allowed-unattributed list has no stale entries', async () => {
    const unattributed = new Set((await results())
      .filter((entry) => entry.verdict === 'unattributed-refusal')
      .map((entry) => entry.id));
    const stale = Object.keys(ALLOWED_UNATTRIBUTED_REFUSALS).filter((id) => !unattributed.has(id));
    expect(stale).toEqual([]);
  });

  test('a plain Error escaping a handler is its own verdict and the set is closed', async () => {
    const catalog = new GatewayMethodCatalog();
    const descriptor = {
      id: 'probe.plain.refusal', title: 'plain refusal', description: 'throws a plain Error for a missing field',
      category: 'probe', source: 'builtin', access: 'authenticated', transport: ['http'], scopes: [],
      inputSchema: { type: 'object', properties: { name: { type: 'string' } } },
    } as const;
    catalog.register(descriptor, async () => { throw new Error('other is required'); });
    const verdict = await probeVerb(catalog, descriptor);
    expect(verdict.verdict).toBe('unclassified-throw');
    expect(verdict.message).toBe('other is required');

    const thrown = (await results()).filter((entry) => entry.verdict === 'unclassified-throw');
    const undocumented = thrown
      .filter((entry) => !Object.hasOwn(ALLOWED_PLAIN_THROWS, entry.id))
      .map((entry) => `${entry.id}: a plain Error ("${String(entry.message)}") escaped the handler. Throw GatewayVerbError with the field for a refused input, or add an entry to ALLOWED_PLAIN_THROWS saying why it is not one.`);
    expect(undocumented).toEqual([]);
    const stale = Object.keys(ALLOWED_PLAIN_THROWS).filter((id) => !thrown.some((entry) => entry.id === id));
    expect(stale).toEqual([]);
  });

  test('a field-naming refusal is attributed whatever its code, and a field-less state refusal is not', async () => {
    const descriptor = (id: string) => ({
      id, title: id, description: id, category: 'probe', source: 'builtin', access: 'authenticated', transport: ['http'], scopes: [],
      inputSchema: { type: 'object', properties: { name: { type: 'string' } } },
    }) as const;
    const catalog = new GatewayMethodCatalog();
    const named = descriptor('probe.coded.field');
    const stateOnly = descriptor('probe.coded.state');
    catalog.register(named, async () => { throw new GatewayVerbError('bad range', 'CALENDAR_BAD_RANGE', 400, 'range'); });
    catalog.register(stateOnly, async () => { throw new GatewayVerbError('gone', 'NOT_FOUND', 404); });
    expect((await probeVerb(catalog, named)).verdict).toBe('undeclared-requirement');
    expect((await probeVerb(catalog, stateOnly)).verdict).toBe('declared-satisfied');
  });

  test('every probed verb lands in exactly one verdict, and the surface is accounted for', async () => {
    const all = await results();
    const counts = new Map<string, number>();
    for (const entry of all) counts.set(entry.verdict, (counts.get(entry.verdict) ?? 0) + 1);
    const total = [...counts.values()].reduce((sum, n) => sum + n, 0);
    expect(total).toBe(all.length);
    // The probe is only worth anything if it is actually reaching handlers.
    // A collapse here (a registrar quietly dropped, an import that stopped
    // attaching) would otherwise read as a clean green over an empty set.
    // 195: the measured floor after the payments registrar became async; a
    // lost `await` in buildProbeCatalog would drop the seven payments verbs
    // and land under it instead of reading as a clean green.
    expect(all.length).toBeGreaterThanOrEqual(195);
    const paymentsVerbs = all.filter((entry) => entry.id.startsWith('payments.'));
    expect(paymentsVerbs.length).toBeGreaterThanOrEqual(7);
  });

  test('a handler verb with no inputSchema is a known, listed exception', async () => {
    // A `required` array is only load-bearing if the invoke gate actually reads
    // it, and `invoke-input-validation.ts` skips any verb whose inputSchema is
    // absent or untyped. Such a verb can grow a handler requirement with no
    // contract to state it in, the defect class with the paperwork removed.
    //
    // The probe still covers them (an undeclared requirement on a verb with no
    // schema is reported like any other), so this is not a hole; it is a list
    // that should not grow silently.
    const catalog = await buildProbeCatalog();
    const ungated = catalog.list()
      .filter((descriptor) => catalog.hasHandler(descriptor.id))
      .filter((descriptor) => classifyInputSchema(descriptor.inputSchema) !== 'validated')
      .map((descriptor) => descriptor.id)
      .sort();
    expect(ungated).toEqual([
      'acp.agents.list',
      'pairing.tokens.list',
      'pairing.tokens.revokeShared',
      'push.subscriptions.list',
      'push.vapid.get',
    ]);
    // Every one of them takes no input today; the probe is what proves it.
    const byId = new Map((await results()).map((entry) => [entry.id, entry]));
    for (const id of ungated) expect(byId.get(id)?.verdict).toBe('declared-satisfied');
  });

  test('every route registrar is either probed or explicitly accounted for', () => {
    // A new register*GatewayMethods in routes/ must be added to the probe's
    // registrar list (and to EXPECTED_ROUTE_REGISTRARS), otherwise its verbs
    // are never invoked and this gate would report green over a family it has
    // never seen.
    //
    // Read with the TypeScript parser rather than a regex over the text. This
    // is the one part of this gate that inspects source instead of running it,
    // and a line-anchored `^export function register…` match cannot tell code
    // from a doc comment, a string literal or a template literal that happens
    // to contain those words at column 0. That is not a hypothetical: a comment
    // reading "this family used to be attached by export function
    // registerLegacyVoiceGatewayMethods" made this test demand that a function
    // which does not exist be added to the probe. A gate that cries wolf gets
    // switched off, so it reads declarations, not characters.
    expect([...collectExportedRegistrars(ROUTES_DIR)].sort()).toEqual([...EXPECTED_ROUTE_REGISTRARS].sort());
  });
});
