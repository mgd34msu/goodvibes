import { expect, test } from 'bun:test';
import { normalizeLiteralTypeOrder } from '../scripts/literal-type-order.ts';
import { diffSnapshots, sameApiSurface, type ExportEntry, type Snapshot } from '../scripts/subpath-api-surface-rule.ts';

const entry = (text: string, overrides: Partial<ExportEntry> = {}): ExportEntry => ({ name: 'Example', kind: 'type', text, ...overrides });
const snapshot = (value: ExportEntry): Snapshot => ({ '.': [value] });
const same = (before: string, after: string) => sameApiSurface(snapshot(entry(before)), snapshot(entry(after)));

test('equivalent emitted literal alternatives compare equally, including referenced definitions', () => {
  const before = 'export declare const ownerReply: ReplyReader<"approve" | "amend" | "reject">;';
  const after = 'export declare const ownerReply: ReplyReader<"approve" | "reject" | "amend">;';
  expect(same(before, after)).toBe(true);
  expect(diffSnapshots(snapshot(entry(before)), snapshot(entry(after)))).toEqual([]);
  expect(same('export type Example = -1 | 0 | 2 | false | true | null;', 'export type Example = true | 2 | null | false | -1 | 0;')).toBe(true);
  expect(same('catalog: Readonly<{ word: "z" | "a"; }> ;; via Extra = export type Extra = "two" | "one";',
    'catalog: Readonly<{ word: "a" | "z"; }> ;; via Extra = export type Extra = "one" | "two";')).toBe(true);
});

test('literal member edits and multiplicity remain visible', () => {
  const baseline = 'export type Example = "a" | "b" | "a";';
  expect(same(baseline, 'export type Example = "a" | "a" | "b";')).toBe(true);
  for (const changed of ['"a" | "b"', '"a" | "a"', '"a" | "a" | "b" | "c"', '"a" | "a" | "B"']) {
    expect(same(baseline, `export type Example = ${changed};`)).toBe(false);
    expect(diffSnapshots(snapshot(entry(baseline)), snapshot(entry(`export type Example = ${changed};`))).length).toBeGreaterThan(0);
  }
});

test('type operators, nonliteral alternatives, declaration structure and report metadata stay exact', () => {
  const pairs = [
    ['export type Example = A | B;', 'export type Example = B | A;'],
    ['export type Example = keyof A | B;', 'export type Example = A | keyof B;'],
    ['export type Example = ("a" | "b")[];', 'export type Example = "a" | "b"[];'],
    ['export declare function f(a: string): void;', 'export declare function f(a?: string): void;'],
    ['export declare function f(a: string): 1; export declare function f(a: number): 2;', 'export declare function f(a: number): 2; export declare function f(a: string): 1;'],
    ['export type Example = "a  b" | "z";', 'export type Example = "a b" | "z";'],
  ];
  for (const [before, after] of pairs) expect(same(before!, after!)).toBe(false);
  const original = entry('export interface Example { member: "b" | "a"; }', { kind: 'interface', required: ['member'], publicMembers: ['member'] });
  for (const delta of [{ name: 'Renamed' }, { kind: 'class' }, { required: [] }, { publicMembers: [] }]) {
    expect(sameApiSurface(snapshot(original), snapshot({ ...original, ...delta }))).toBe(false);
  }
  expect(sameApiSurface(snapshot(original), {})).toBe(false);
  expect(sameApiSurface(snapshot(original), { '.': [] })).toBe(false);
});

test('quoted metadata, malformed declarations and template interpolation are never rewritten as structure', () => {
  const quoted = 'export type Example = " ;; via Alias = export type Alias = b | a" | "x";';
  expect(normalizeLiteralTypeOrder(quoted)).toContain('" ;; via Alias = export type Alias = b | a"');
  for (const unknown of ['export type Example = "b" | ;', 'export type Example = { a: "b" | "a";', 'export type Example = `prefix${"b" | "a"}`;']) {
    expect(normalizeLiteralTypeOrder(unknown)).toBe(unknown);
  }
});

test('compiler-reordered enum maps compare equally while actual schema and overload edits stay visible', () => {
  const before = 'schema: z.ZodEnum<{ decision: "decision"; artifact: "artifact"; test: "test"; commit: "commit"; }>';
  const after = 'schema: z.ZodEnum<{ commit: "commit"; test: "test"; decision: "decision"; artifact: "artifact"; }>';
  expect(same(before, after)).toBe(true);
  expect(diffSnapshots(snapshot(entry(before)), snapshot(entry(after)))).toEqual([]);
  for (const changed of [after.replace('test: "test";', ''), after.replace('test: "test";', 'test: "changed";'),
    after.replace('test: "test";', 'test?: "test";'), after.replace('test: "test";', 'readonly test: "test";')]) expect(same(before, changed)).toBe(false);
  expect(same('schema: z.ZodEnum<{ a: "x"; a: "y"; }>', 'schema: z.ZodEnum<{ a: "y"; a: "x"; }>')).toBe(false);
  expect(same('schema: z.ZodEnum<{ f(x: string): 1; f(x: number): 2; }>',
    'schema: z.ZodEnum<{ f(x: number): 2; f(x: string): 1; }>')).toBe(false);
});

test('compiler-reordered property-only return shapes compare equally without hiding contract edits', () => {
  const before = 'export declare function capture(): { readonly phase: "pending" | "complete"; value?: string; count: number; };';
  const after = 'export declare function capture(): { count: number; value?: string; readonly phase: "complete" | "pending"; };';
  expect(same(before, after)).toBe(true);
  expect(diffSnapshots(snapshot(entry(before)), snapshot(entry(after)))).toEqual([]);
  for (const changed of [after.replace('count: number', 'count: string'), after.replace('value?: string;', ''),
    after.replace('value?: string', 'value: string'), after.replace('readonly phase:', 'phase:'),
    after.replace('count: number;', 'count: number; added: boolean;')]) {
    expect(same(before, changed)).toBe(false);
    expect(diffSnapshots(snapshot(entry(before)), snapshot(entry(changed))).length).toBeGreaterThan(0);
  }
  // Import types are how declaration emit spells Zod schema members; they are
  // not ordinary TypeReference nodes and used to miss the enum-only exception.
  expect(same('schema: import("zod").ZodObject<{ value: import("zod").ZodEnum<{ a: "a"; b: "b"; }>; count: number; }>;',
    'schema: import("zod").ZodObject<{ count: number; value: import("zod").ZodEnum<{ b: "b"; a: "a"; }>; }>;')).toBe(true);
});

test('nested property normalization survives a parent reorder and referenced declaration labels', () => {
  const before = 'catalog: { z: { y: { last: number; first: "z" | "a"; }; x: string; }; a: boolean; } ;; via Extra = export type Extra = { two: number; one: string; };';
  const after = 'catalog: { a: boolean; z: { x: string; y: { first: "a" | "z"; last: number; }; }; } ;; via Extra = export type Extra = { one: string; two: number; };';
  expect(same(before, after)).toBe(true);
  expect(normalizeLiteralTypeOrder(before)).toBe(normalizeLiteralTypeOrder(after));
  expect(same(before, after.replace('last: number', 'last: boolean'))).toBe(false);
  expect(normalizeLiteralTypeOrder(normalizeLiteralTypeOrder(before))).toBe(normalizeLiteralTypeOrder(before));
});

test('ambiguous keys and ordered member or type sequences remain observable', () => {
  const ordered = [
    ['export type Example = { x: string; x: number; };', 'export type Example = { x: number; x: string; };'],
    ['export type Example = { 1: string; "1": number; };', 'export type Example = { "1": number; 1: string; };'],
    ['export type Example = { f(x: string): 1; f(x: number): 2; };', 'export type Example = { f(x: number): 2; f(x: string): 1; };'],
    ['export type Example = { (x: string): 1; (x: number): 2; };', 'export type Example = { (x: number): 2; (x: string): 1; };'],
    ['export type Example = { new(x: string): A; new(x: number): B; };', 'export type Example = { new(x: number): B; new(x: string): A; };'],
    ['export type Example = { [key: string]: number; fixed: number; };', 'export type Example = { fixed: number; [key: string]: number; };'],
    ['export type Example = { get value(): string; set value(next: string); };', 'export type Example = { set value(next: string); get value(): string; };'],
    ['export type Example = { [Symbol.iterator]: A; value: string; };', 'export type Example = { value: string; [Symbol.iterator]: A; };'],
    ['export type Example = [first: string, second: number];', 'export type Example = [second: number, first: string];'],
    ['export type Example = A & B;', 'export type Example = B & A;'],
  ];
  for (const [before, after] of ordered) expect(same(before!, after!), before).toBe(false);
  expect(same('export type Example = { 2: string; "first": number; };', 'export type Example = { "first": number; 2: string; };')).toBe(true);
});


test('newline-only property shapes remain valid and idempotent after normalization', () => {
  const before = 'export type Example = {\n  last: number\n  first: {\n    two: string\n    one: boolean\n  }\n};';
  const after = 'export type Example = { first: { one: boolean; two: string; }; last: number; };';
  expect(same(before, after)).toBe(true);
  const normalized = normalizeLiteralTypeOrder(before);
  expect(normalized).toBe(after);
  expect(normalizeLiteralTypeOrder(normalized)).toBe(normalized);
  expect(same(before, after.replace('last: number;', 'last: boolean;'))).toBe(false);
  expect(normalizeLiteralTypeOrder('export type Example = { last: number, first: string, };'))
    .toBe('export type Example = { first: string; last: number; };');
});

test('member-gap documentation stays intact and documentation changes remain visible', () => {
  for (const documented of [
    'export type Example = { /** first meaning */ last: number; first: string; };',
    'export type Example = { last: number; /** first meaning */ first: string; };',
    'export type Example = { last: number; first: string; /** first meaning */ };',
    'export type Example = { last: number; // first meaning\n first: string; };',
  ]) {
    expect(normalizeLiteralTypeOrder(documented)).toBe(documented);
    expect(same(documented, documented.replace('first meaning', 'different meaning'))).toBe(false);
  }
});
