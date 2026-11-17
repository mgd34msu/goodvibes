/**
 * Writes platform/src/events/contracts/event-rules.generated.ts: the field
 * rules `validateKnownEvent` checks, read from the runtime event unions in
 * platform/src/events (the one description of every event) with the
 * TypeScript checker. Every event type gets its rules; nothing is written by
 * hand.
 *
 * The generated table is typed against the unions, so a field added, removed
 * or made optional fails to compile until this is run again; `--check` fails
 * when the file on disk differs from what the unions say (a changed field
 * type or enum value, which the compiler cannot see).
 *
 *   bun packages/engine/scripts/generate-event-rules.ts [--check]
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const ENGINE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PLATFORM_ROOT = resolve(ENGINE_ROOT, 'platform');
const DOMAIN_MAP = resolve(PLATFORM_ROOT, 'src/events/domain-map.ts');
const OUTPUT = resolve(PLATFORM_ROOT, 'src/events/contracts/event-rules.generated.ts');
const CHECK_ONLY = process.argv.includes('--check');
/** Nested object fields are described this deep; deeper objects are checked as objects only. */
const MAX_DEPTH = 3;

interface Rule {
  readonly kind: string;
  readonly values?: readonly string[];
  readonly fields?: readonly (Rule & { readonly key: string })[];
  readonly optional?: true;
  readonly allowUndefined?: true;
}

function loadProgram(): ts.Program {
  const configPath = resolve(PLATFORM_ROOT, 'tsconfig.json');
  const parsed = ts.getParsedCommandLineOfConfigFile(configPath, {}, {
    ...ts.sys,
    onUnRecoverableConfigFileDiagnostic: (diagnostic) => {
      throw new Error(ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'));
    },
  });
  if (!parsed) throw new Error(`cannot read ${configPath}`);
  return ts.createProgram({ rootNames: [DOMAIN_MAP], options: { ...parsed.options, noEmit: true, composite: false, incremental: false } });
}

const program = loadProgram();
const checker = program.getTypeChecker();

function anyRuntimeEventType(): ts.Type {
  const source = program.getSourceFile(DOMAIN_MAP);
  if (!source) throw new Error(`cannot load ${DOMAIN_MAP}`);
  for (const statement of source.statements) {
    if (ts.isTypeAliasDeclaration(statement) && statement.name.text === 'AnyRuntimeEvent') {
      return checker.getTypeAtLocation(statement.name);
    }
  }
  throw new Error('AnyRuntimeEvent is not declared in domain-map.ts');
}

const isUndefined = (type: ts.Type): boolean => (type.flags & ts.TypeFlags.Undefined) !== 0 || (type.flags & ts.TypeFlags.Void) !== 0;
const isNull = (type: ts.Type): boolean => (type.flags & ts.TypeFlags.Null) !== 0;
const isStringLike = (type: ts.Type): boolean => (type.flags & (ts.TypeFlags.String | ts.TypeFlags.TemplateLiteral | ts.TypeFlags.StringMapping)) !== 0;
const isNumberLike = (type: ts.Type): boolean => (type.flags & (ts.TypeFlags.Number | ts.TypeFlags.NumberLiteral)) !== 0;
const isBooleanLike = (type: ts.Type): boolean => (type.flags & (ts.TypeFlags.Boolean | ts.TypeFlags.BooleanLiteral)) !== 0;
const isStringLiteral = (type: ts.Type): type is ts.StringLiteralType => (type.flags & ts.TypeFlags.StringLiteral) !== 0;

function members(type: ts.Type): readonly ts.Type[] {
  // `boolean` is the union `true | false`; keep it whole.
  if (type.isUnion() && !(type.flags & ts.TypeFlags.Boolean)) return type.types;
  return [type];
}

function arrayElement(type: ts.Type): ts.Type | null {
  if (checker.isArrayType(type) || checker.isTupleType(type)) {
    const args = checker.getTypeArguments(type as ts.TypeReference);
    if (checker.isTupleType(type)) return args.length > 0 ? checker.getUnionType([...args]) : null;
    return args[0] ?? null;
  }
  return null;
}

function isPlainObject(type: ts.Type): boolean {
  if ((type.flags & ts.TypeFlags.Object) === 0 && !type.isIntersection()) return false;
  if (arrayElement(type) !== null) return false;
  return type.getCallSignatures().length === 0;
}

function objectFields(type: ts.Type, depth: number): (Rule & { key: string })[] | undefined {
  if (depth >= MAX_DEPTH) return undefined;
  if (checker.getIndexInfosOfType(type).length > 0) return undefined;
  const properties = checker.getPropertiesOfType(type);
  if (properties.length === 0) return undefined;
  return properties.map((property) => ({ key: property.getName(), ...propertyRule(property, depth + 1) }));
}

/** The rule for a value of `type` (undefined and, for optional fields, absence already handled). */
function valueRule(type: ts.Type, depth: number): Rule {
  const parts = members(type).filter((member) => !isUndefined(member));
  if (parts.length === 0) return { kind: 'unknown' };
  if (parts.some((part) => (part.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) !== 0)) return { kind: 'unknown' };
  const withoutNull = parts.filter((part) => !isNull(part));
  const hasNull = withoutNull.length !== parts.length;
  if (withoutNull.length === 0) return { kind: 'unknown' };
  if (withoutNull.every(isStringLiteral)) {
    if (hasNull) return { kind: 'string|null' };
    return { kind: 'enum', values: [...new Set(withoutNull.map((part) => (part as ts.StringLiteralType).value))].sort() };
  }
  if (withoutNull.every((part) => isStringLike(part) || isStringLiteral(part))) return { kind: hasNull ? 'string|null' : 'string' };
  if (hasNull) return { kind: 'unknown' };
  if (withoutNull.every(isNumberLike)) return { kind: 'number' };
  if (withoutNull.every(isBooleanLike)) return { kind: 'boolean' };
  if (withoutNull.length === 1) {
    const only = withoutNull[0]!;
    const element = arrayElement(only);
    if (element !== null) {
      const inner = valueRule(element, depth);
      if (inner.kind === 'string') return { kind: 'string[]' };
      if (inner.kind === 'enum') return { kind: 'enum[]', values: inner.values ?? [] };
      if (inner.kind === 'object') return inner.fields ? { kind: 'object[]', fields: inner.fields } : { kind: 'object[]' };
      return { kind: 'array' };
    }
    if (isPlainObject(only)) {
      const fields = objectFields(only, depth);
      return fields ? { kind: 'object', fields } : { kind: 'object' };
    }
    return { kind: 'unknown' };
  }
  if (withoutNull.every((part) => arrayElement(part) !== null)) return { kind: 'array' };
  if (withoutNull.every(isPlainObject)) return { kind: 'object' };
  return { kind: 'unknown' };
}

function propertyRule(property: ts.Symbol, depth: number): Rule {
  const declaration = property.valueDeclaration ?? property.declarations?.[0];
  const type = declaration ? checker.getTypeOfSymbolAtLocation(property, declaration) : checker.getTypeOfSymbol(property);
  const optional = (property.flags & ts.SymbolFlags.Optional) !== 0;
  const rule = valueRule(type, depth);
  if (optional) return { ...rule, optional: true };
  if (rule.kind !== 'unknown' && members(type).some(isUndefined)) return { ...rule, allowUndefined: true };
  return rule;
}

function collectEvents(): Map<string, Rule & { fields: (Rule & { key: string })[] }> {
  const events = new Map<string, Rule & { fields: (Rule & { key: string })[] }>();
  for (const member of members(anyRuntimeEventType())) {
    const typeSymbol = member.getProperty('type');
    if (!typeSymbol) throw new Error(`a runtime event has no 'type': ${checker.typeToString(member)}`);
    const discriminant = checker.getTypeOfSymbol(typeSymbol);
    if (!isStringLiteral(discriminant)) throw new Error(`a runtime event's 'type' is not one string: ${checker.typeToString(member)}`);
    if (events.has(discriminant.value)) throw new Error(`two runtime events share the type ${discriminant.value}`);
    const fields = checker.getPropertiesOfType(member)
      .filter((property) => property.getName() !== 'type')
      .map((property) => ({ key: property.getName(), ...propertyRule(property, 0) }));
    events.set(discriminant.value, { kind: 'object', fields });
  }
  return events;
}

const quote = (value: string): string => `'${value.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
const propertyKey = (key: string): string => (/^[A-Za-z_$][\w$]*$/.test(key) ? key : quote(key));

function renderRuleBody(rule: Rule, indent: string): string {
  const parts = [`kind: ${quote(rule.kind)}`];
  if (rule.values) parts.push(`values: [${rule.values.map(quote).join(', ')}]`);
  if (rule.optional) parts.push('optional: true');
  if (rule.allowUndefined) parts.push('allowUndefined: true');
  if (rule.fields) {
    const inner = `${indent}  `;
    parts.push(`fields: [\n${rule.fields.map((field) => `${inner}{ key: ${quote(field.key)}, ${renderRuleBody(field, inner)} },`).join('\n')}\n${indent}]`);
  }
  return parts.join(', ');
}

function render(events: Map<string, Rule & { fields: (Rule & { key: string })[] }>): string {
  const lines = [
    '// Generated by packages/engine/scripts/generate-event-rules.ts from the runtime',
    '// event unions in platform/src/events. Do not edit: change the event and run',
    '// `bun packages/engine/scripts/generate-event-rules.ts`.',
    "import type { EventFieldRulesTable } from './rules.js';",
    '',
    'export const EVENT_FIELD_RULES: EventFieldRulesTable = {',
  ];
  for (const type of [...events.keys()].sort()) {
    const fields = events.get(type)!.fields;
    if (fields.length === 0) {
      lines.push(`  ${type}: {},`);
      continue;
    }
    lines.push(`  ${type}: {`);
    for (const field of fields) lines.push(`    ${propertyKey(field.key)}: { ${renderRuleBody(field, '    ')} },`);
    lines.push('  },');
  }
  lines.push('};', '');
  return lines.join('\n');
}

const output = render(collectEvents());
let current: string | null = null;
try {
  current = readFileSync(OUTPUT, 'utf8');
} catch {
  current = null;
}
if (current === output) {
  console.log('event rules are in step with the event unions');
} else if (CHECK_ONLY) {
  console.error(`${OUTPUT} is out of step with the event unions; run bun packages/engine/scripts/generate-event-rules.ts`);
  process.exit(1);
} else {
  writeFileSync(OUTPUT, output);
  console.log(`wrote ${OUTPUT}`);
}
