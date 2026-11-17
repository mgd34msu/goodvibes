/**
 * The languages `repl` evaluates beyond JavaScript and TypeScript, and how each
 * one runs. Python and SQL run as one command in the same sandbox as a
 * JavaScript eval (Python by the contained interpreter, SQL by Bun's SQLite on
 * an in-memory database), so nothing of the host is reached that a JavaScript
 * eval could not reach. GraphQL is only parsed, printed in normal form and,
 * given a schema, validated; nothing is executed, so it runs in process.
 */

export type ReplRuntime = 'javascript' | 'typescript' | 'python' | 'sql' | 'graphql';

export const REPL_RUNTIMES: readonly ReplRuntime[] = ['javascript', 'typescript', 'python', 'sql', 'graphql'];

export function isReplRuntime(value: unknown): value is ReplRuntime {
  return typeof value === 'string' && (REPL_RUNTIMES as readonly string[]).includes(value);
}

/**
 * A Python program that sets each binding as a global, runs the snippet and
 * prints the `repr` of its last expression, as the interactive interpreter does.
 * Run with `python3 -I` (no user site directory, no PYTHON* environment).
 */
export function pythonReplScript(source: string, bindings: string): string {
  return [
    'import ast as __gv_ast, json as __gv_json',
    `globals().update(__gv_json.loads(${JSON.stringify(bindings)}))`,
    `__gv_tree = __gv_ast.parse(${JSON.stringify(source)}, '<repl>', 'exec')`,
    '__gv_last = None',
    'if __gv_tree.body and isinstance(__gv_tree.body[-1], __gv_ast.Expr):',
    '    __gv_last = __gv_ast.Expression(__gv_tree.body.pop().value)',
    "exec(compile(__gv_tree, '<repl>', 'exec'), globals())",
    'if __gv_last is not None:',
    "    __gv_value = eval(compile(__gv_last, '<repl>', 'eval'), globals())",
    '    if __gv_value is not None: print(repr(__gv_value))',
    '',
  ].join('\n');
}

/**
 * Splits SQL into statements at top-level semicolons: not inside a quoted
 * string or identifier, a comment, or a trigger body (`CREATE TRIGGER ... END`).
 */
export function splitSqlStatements(source: string): string[] {
  const statements: string[] = [];
  let start = 0;
  let depth = 0;
  let index = 0;
  const word = (at: number): string => /^[A-Za-z_]+/.exec(source.slice(at))?.[0]?.toUpperCase() ?? '';
  const push = (end: number): void => {
    const text = source.slice(start, end).trim();
    if (text.replace(/--[^\n]*|\/\*[\s\S]*?\*\//g, '').trim()) statements.push(text);
  };
  while (index < source.length) {
    const char = source[index]!;
    if (char === "'" || char === '"' || char === '`' || char === '[') {
      const close = char === '[' ? ']' : char;
      index += 1;
      while (index < source.length) {
        if (source[index] === close) {
          if (close !== ']' && source[index + 1] === close) { index += 2; continue; }
          break;
        }
        index += 1;
      }
      index += 1;
      continue;
    }
    if (char === '-' && source[index + 1] === '-') {
      const end = source.indexOf('\n', index);
      index = end === -1 ? source.length : end + 1;
      continue;
    }
    if (char === '/' && source[index + 1] === '*') {
      const end = source.indexOf('*/', index + 2);
      index = end === -1 ? source.length : end + 2;
      continue;
    }
    if (/[A-Za-z_]/.test(char) && (index === 0 || !/[A-Za-z0-9_$]/.test(source[index - 1]!))) {
      const token = word(index);
      if (token === 'BEGIN' && /^\s*CREATE\s+(TEMP\s+|TEMPORARY\s+)?TRIGGER\b/i.test(source.slice(start, index))) depth += 1;
      else if (token === 'END' && depth > 0) depth -= 1;
      index += token.length;
      continue;
    }
    if (char === ';' && depth === 0) {
      push(index);
      start = index + 1;
    }
    index += 1;
  }
  push(source.length);
  return statements;
}

/**
 * A Bun program that runs the statements on a fresh in-memory SQLite database
 * and prints, as JSON, the rows of the last statement that returns rows, or
 * the changes and last inserted row id of a last statement that does not.
 * A binding is passed to each statement that names it (`$name`, `:name` or
 * `@name`).
 */
export function sqlReplScript(source: string, bindings: string): string {
  const statements = splitSqlStatements(source);
  return [
    "import { Database } from 'bun:sqlite';",
    `const statements = JSON.parse(${JSON.stringify(JSON.stringify(statements))});`,
    `const bindings = JSON.parse(${JSON.stringify(bindings)});`,
    "const db = new Database(':memory:', { strict: true });",
    "const escape = (key) => key.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&');",
    'let last = { rows: [] };',
    'for (const sql of statements) {',
    '  const statement = db.query(sql);',
    "  const params = Object.fromEntries(Object.entries(bindings).filter(([key]) => new RegExp('[$:@]' + escape(key) + '(?![A-Za-z0-9_])').test(sql)));",
    '  const rows = statement.all(params);',
    '  if (statement.columnNames.length > 0) { last = { rows }; continue; }',
    "  const done = db.query('SELECT changes() AS changes, last_insert_rowid() AS lastInsertRowid').get();",
    '  last = { changes: done.changes, lastInsertRowid: done.lastInsertRowid };',
    '}',
    "console.log(JSON.stringify(last, (_key, value) => typeof value === 'bigint' ? value.toString() : value, 2));",
    '',
  ].join('\n');
}

/** A GraphQL evaluation's answer: the normal form and operations, or why the document is not valid. */
export interface GraphqlReplResult {
  readonly success: boolean;
  readonly result: string;
  readonly error?: string | undefined;
}

/**
 * Parses a GraphQL document and prints its normal form with each operation's
 * type and name. With a `schema` binding (SDL text) the document is also
 * validated against it, and every validation error is listed.
 */
export async function evaluateGraphql(source: string, bindings: Record<string, unknown>): Promise<GraphqlReplResult> {
  const graphql = await import('graphql');
  let document: import('graphql').DocumentNode;
  try {
    document = graphql.parse(source);
  } catch (error) {
    return { success: false, result: '', error: `The GraphQL document does not parse: ${error instanceof Error ? error.message : String(error)}` };
  }
  const operations = document.definitions.flatMap((definition) => definition.kind === graphql.Kind.OPERATION_DEFINITION
    ? [{ operation: definition.operation, name: definition.name?.value ?? null, variables: (definition.variableDefinitions ?? []).map((variable) => variable.variable.name.value) }]
    : []);
  const fragments = document.definitions.flatMap((definition) => definition.kind === graphql.Kind.FRAGMENT_DEFINITION ? [definition.name.value] : []);
  const answer: Record<string, unknown> = { normalized: graphql.print(document), operations, fragments };
  const schemaSource = bindings.schema;
  if (schemaSource !== undefined) {
    if (typeof schemaSource !== 'string') return { success: false, result: '', error: 'The schema binding must be the schema as SDL text.' };
    let schema: import('graphql').GraphQLSchema;
    try {
      schema = graphql.buildSchema(schemaSource);
    } catch (error) {
      return { success: false, result: '', error: `The schema binding does not build: ${error instanceof Error ? error.message : String(error)}` };
    }
    const errors = graphql.validate(schema, document).map((entry) => entry.message);
    answer.valid = errors.length === 0;
    if (errors.length > 0) answer.errors = errors;
  }
  const result = JSON.stringify(answer, null, 2);
  return answer.valid === false
    ? { success: false, result, error: `The document is not valid against the schema: ${(answer.errors as string[]).join('; ')}` }
    : { success: true, result };
}
