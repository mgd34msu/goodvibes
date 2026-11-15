import ts from 'typescript';

/**
 * Names a module re-exports from `specifier`, read from its export
 * declarations. `null` means `export * from` that specifier: every name.
 * A name that only appears in a comment, an import or another identifier is not
 * a re-export.
 */
export function reexportedNames(text: string, specifier: string): ReadonlySet<string> | null {
  const source = ts.createSourceFile('index.ts', text, ts.ScriptTarget.Latest, true);
  const names = new Set<string>();
  for (const statement of source.statements) {
    if (!ts.isExportDeclaration(statement) || statement.moduleSpecifier === undefined || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
    if (statement.moduleSpecifier.text !== specifier) continue;
    if (statement.exportClause === undefined) return null;
    if (ts.isNamedExports(statement.exportClause)) for (const element of statement.exportClause.elements) names.add(element.name.text);
  }
  return names;
}
