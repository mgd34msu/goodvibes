import ts from 'typescript';

/** Canonicalize literal alternatives and unordered property-only type shapes. */
export function normalizeLiteralTypeOrder(text: string): string {
  if (!text.includes('|') && !text.includes('{')) return text;
  let invalid = false;
  const scanner = ts.createScanner(ts.ScriptTarget.Latest, true, ts.LanguageVariant.Standard, text, () => { invalid = true; });
  const masks: Array<{ start: number; end: number }> = [];
  const nesting: ts.SyntaxKind[] = [];
  let previous = ts.SyntaxKind.Unknown;
  let previousEnd = -1;
  const opening = new Map([
    [ts.SyntaxKind.OpenBraceToken, ts.SyntaxKind.CloseBraceToken],
    [ts.SyntaxKind.OpenParenToken, ts.SyntaxKind.CloseParenToken],
    [ts.SyntaxKind.OpenBracketToken, ts.SyntaxKind.CloseBracketToken],
  ]);
  const closing = new Set(opening.values());
  for (let kind = scanner.scan(); kind !== ts.SyntaxKind.EndOfFileToken; kind = scanner.scan()) {
    const start = scanner.getTokenPos();
    const end = scanner.getTextPos();
    // Template interpolation needs scanner rescans. Leave that uncommon shape exact.
    if (kind === ts.SyntaxKind.TemplateHead || kind === ts.SyntaxKind.TemplateMiddle || kind === ts.SyntaxKind.TemplateTail) return text;
    if (nesting.length === 0 && kind === ts.SyntaxKind.SemicolonToken
      && previous === ts.SyntaxKind.SemicolonToken && previousEnd === start) {
      // Reports append local definitions as " ;; via Name = export type ...".
      // Only token-level metadata is masked for parsing; quoted text stays opaque.
      const label = /^\s+(?:via )?[A-Za-z_$][A-Za-z0-9_$]* = (?=(?:export )?(?:declare )?(?:type|interface)\b)/.exec(text.slice(end));
      if (label) masks.push({ start: end, end: end + label[0].length });
    }
    const close = opening.get(kind);
    if (close !== undefined) nesting.push(close);
    else if (closing.has(kind) && nesting.pop() !== kind) return text;
    previous = kind;
    previousEnd = end;
  }
  if (invalid || nesting.length !== 0) return text;
  let parsed = text;
  for (const mask of masks.reverse()) parsed = parsed.slice(0, mask.start) + ' '.repeat(mask.end - mask.start) + parsed.slice(mask.end);
  // VariableDeclaration.getText() omits the surrounding const declaration.
  const prefix = /^\s*[A-Za-z_$][A-Za-z0-9_$]*\s*[:=]/.test(parsed) ? 'declare const ' : '';
  parsed = prefix + parsed;
  const diagnostics = ts.transpileModule(parsed, {
    fileName: 'surface.ts', reportDiagnostics: true,
    compilerOptions: { target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.ESNext },
  }).diagnostics ?? [];
  if (diagnostics.some(item => item.category === ts.DiagnosticCategory.Error)) return text;
  const source = ts.createSourceFile('surface.ts', parsed, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  type Edit = { start: number; end: number; value: string };
  const rewrite = (start: number, end: number, edits: readonly Edit[]): string => {
    let result = text.slice(start, end);
    for (const edit of [...edits].sort((a, b) => b.start - a.start)) {
      if (edit.start < start || edit.end > end) continue;
      result = result.slice(0, edit.start - start) + edit.value + result.slice(edit.end - start);
    }
    return result;
  };
  const visit = (node: ts.Node): Edit[] => {
    const children: Edit[] = [];
    ts.forEachChild(node, child => { children.push(...visit(child)); });
    const start = node.getStart(source) - prefix.length, end = node.end - prefix.length;
    if (ts.isUnionTypeNode(node) && node.types.every(ts.isLiteralTypeNode)) {
      const original = node.types.map(member => member.getText(source));
      const sorted = [...original].sort();
      if (original.some((member, index) => member !== sorted[index])) {
        return [{ start, end, value: sorted.join(' | ') }];
      }
    }
    // Unique ordinary properties describe an unordered shape. In particular,
    // inferred return objects and Zod maps may be emitted in compiler-dependent
    // order. Keep overloads and every other member kind in their original order.
    if (ts.isTypeLiteralNode(node) && node.members.every(member => ts.isPropertySignature(member)
      && (ts.isIdentifier(member.name) || ts.isStringLiteral(member.name) || ts.isNumericLiteral(member.name)))) {
      const members = node.members as ts.NodeArray<ts.PropertySignature>;
      let previous = start + 1;
      for (const member of members) {
        const gap = text.slice(previous, member.getStart(source) - prefix.length);
        // getStart skips leading JSDoc. Preserve a documented container rather
        // than dropping or moving comments when its members are reordered.
        if (gap.includes('/*') || gap.includes('//')) return children;
        previous = member.end - prefix.length;
      }
      const tail = text.slice(previous, end - 1);
      if (tail.includes('/*') || tail.includes('//')) return children;
      const names = members.map(member => ts.isNumericLiteral(member.name)
        ? String(Number(member.name.text)) : (member.name as ts.Identifier | ts.StringLiteral).text);
      if (new Set(names).size === names.length) {
        const sorted = members.map((member, index) => ({ name: names[index]!,
          text: rewrite(member.getStart(source) - prefix.length, member.end - prefix.length, children).replace(/[;,]$/, '') + ';' }))
          .sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
        // Child edits are rendered into each member before replacing this whole
        // container. Explicit separators keep newline-only shapes valid after
        // joining members and make a second normalization identical.
        return [{ start, end, value: '{ ' + sorted.map(member => member.text).join(' ') + ' }' }];
      }
    }
    return children;
  };
  const edits = visit(source);
  let result = text;
  for (const edit of edits.sort((a, b) => b.start - a.start)) {
    if (edit.start < 0 || edit.end > text.length) return text;
    result = result.slice(0, edit.start) + edit.value + result.slice(edit.end);
  }
  return result;
}
