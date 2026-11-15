/**
 * setInterval .unref() invariant.
 *
 * Enumerates all setInterval call sites in the platform platform source and
 * verifies the interval reference is passed to .unref?.() so that Node.js /
 * Bun processes can exit cleanly without dangling intervals keeping the event
 * loop alive.
 * Uses an AST walk to find setInterval(...) call expressions and verify
 * .unref?.() is chained on the result within the enclosing scope.
 */

import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { glob } from 'node:fs/promises';
import { resolve } from 'node:path';
import { Lang, parse, type SgNode } from '@ast-grep/napi';

/** `.unref()`, `.unref?.()` or `.unref?()`-style calls. */
const UNREF_CALL = /\.unref\s*(?:\?\.)?\s*\(\)/;

/** Callee text of an interval-starting call: `setInterval`, `x.setInterval`, `this.setIntervalImpl`. */
const INTERVAL_CALLEE = /(?:^|\.)setInterval(?:Impl)?$/;

const ENGINE_SRC = resolve(import.meta.dir, '../platform/src/platform');

/** True when the interval call is directly `.unref`-ed or passed to `unrefHandle(...)`. */
function isUnrefedInline(call: SgNode): boolean {
  let node: SgNode = call;
  let parent = node.parent();
  // Look through `(call)` and `call as T` wrappers.
  while (parent && (parent.kind() === 'parenthesized_expression' || parent.kind() === 'as_expression')) {
    node = parent;
    parent = node.parent();
  }
  if (!parent) return false;
  if (parent.kind() === 'member_expression') {
    return parent.field('object')?.id() === node.id() && parent.field('property')?.text() === 'unref';
  }
  if (parent.kind() === 'arguments') {
    const outer = parent.parent();
    return outer?.kind() === 'call_expression' && outer.field('function')?.text() === 'unrefHandle';
  }
  return false;
}

/**
 * For a given source file, find all `setInterval(...)` call expressions using
 * the AST and check that .unref?.() is called on the result within the same
 * statement or the immediately following statements.
 *
 * Strategy:
 * 1. Parse the file with @ast-grep/napi using the TypeScript language.
 * 2. Find all nodes matching `setInterval($$$ARGS)`.
 * 3. For each match, inspect the parent statement:
 *    - If the call is directly chained: `setInterval(...).unref?.()`, OK.
 *    - If the call is assigned: check the enclosing block for a `.unref?.()` call
 *      on the same variable name within the next 25 lines.
 * 4. Return a list of violations (setInterval sites without .unref).
 */
function findUnrefViolations(
  filePath: string,
  content: string,
): { line: number; snippet: string }[] {
  const violations: { line: number; snippet: string }[] = [];

  const root = parse(Lang.TypeScript, content).root();

  // Find all setInterval call expressions
  // findAll() returns SgNode[] directly, each element IS the node
  // Direct, member-style and injected (`this.setIntervalImpl`) interval sites.
  const matches = root
    .findAll({ rule: { kind: 'call_expression' } })
    .filter((call) => INTERVAL_CALLEE.test(call.field('function')?.text() ?? ''));

  for (const match of matches) {
    const range = match.range();
    const startLine = range.start.line; // 0-indexed

    // Get the text of the matched setInterval call
    const callText = match.text();

    // Case 1: the call itself is the receiver of .unref, or the argument of unrefHandle(...).
    // Only the immediate parents count; an unref elsewhere in the statement is a different timer.
    if (isUnrefedInline(match)) {
      continue;
    }

    // Case 2: Assignment, find the variable name being assigned
    // Walk up to the variable declarator or expression statement
    let assignTarget: string | null = null;
    let cursor = match.parent();
    while (cursor) {
      const kind = cursor.kind();
      if (kind === 'variable_declarator') {
        // const/let/var x = setInterval(...)
        const nameNode = cursor.field('name');
        if (nameNode) {
          assignTarget = nameNode.text();
        }
        break;
      }
      if (kind === 'assignment_expression') {
        // this.x = setInterval(...) or x = setInterval(...)
        const leftNode = cursor.field('left');
        if (leftNode) {
          assignTarget = leftNode.text();
        }
        break;
      }
      if (kind === 'expression_statement' || kind === 'return_statement') {
        break;
      }
      cursor = cursor.parent();
    }

    if (assignTarget) {
      // Search the remaining file text from this line forward (up to 30 lines)
      const lines = content.split('\n');
      const windowEnd = Math.min(startLine + 30, lines.length);
      const windowLines = lines.slice(startLine, windowEnd);
      const windowText = windowLines.join('\n');

      // Build a pattern matching the assigned variable followed by .unref
      // Escape dots in member expressions (e.g., this.interval)
      const escapedTarget = assignTarget.replace(/\./g, '\\.');
      const unrefPattern = new RegExp(`(?<![\\w$.])${escapedTarget}\\s*(?:as\\s[^;]*?\\)\\s*)?(?:\\?\\s*)?\\.\\s*unref\\s*(?:\\?\\.)?\\s*\\(\\)`);
      const unrefHelper = new RegExp(`unrefHandle\\(\\s*(?<![\\w$.])${escapedTarget}\\s*\\)`);
      if (unrefPattern.test(windowText) || unrefHelper.test(windowText)) {
        continue; // found .unref call on the assigned variable
      }
    }

    // Case 3: not chained and no matching unref on the assigned handle. An unref on
    // some other timer in the scope does not count.
    violations.push({
      line: startLine + 1, // convert to 1-indexed
      snippet: callText.slice(0, 120),
    });
  }

  return violations;
}

describe('setInterval .unref() coverage (AST walk)', () => {
  test('reports an interval that is stored but never unref-ed', () => {
    const source = 'class A { start() { this.t = setInterval(() => {}, 1); } }';
    expect(findUnrefViolations('a.ts', source)).toHaveLength(1);
  });

  test('reports an injected interval that is never unref-ed', () => {
    const source = 'class A { start() { this.t = this.setIntervalImpl(() => {}, 1); } }';
    expect(findUnrefViolations('a.ts', source)).toHaveLength(1);
  });

  test('does not accept an unref on a different timer', () => {
    const source = 'class A { start() { this.a = setInterval(() => {}, 1); this.b.unref?.(); } }';
    expect(findUnrefViolations('a.ts', source)).toHaveLength(1);
  });

  test('does not accept an unrelated unref earlier in the same block', () => {
    const source = 'function f() { other.unref(); setInterval(() => {}, 1); }';
    expect(findUnrefViolations('a.ts', source)).toHaveLength(1);
  });

  test('does not accept an unref of a suffix-named handle', () => {
    expect(findUnrefViolations('a.ts', 'function f() { const t = setInterval(() => {}, 1); next.unref(); }')).toHaveLength(1);
    expect(findUnrefViolations('a.ts', 'function f() { const timer = setInterval(() => {}, 1); flushTimer.unref(); }')).toHaveLength(1);
    expect(findUnrefViolations('a.ts', 'function f() { const timer = setInterval(() => {}, 1); timer.unref(); }')).toHaveLength(0);
  });

  test('does not accept an unref of another handle inside the callback', () => {
    const source = 'class A { start() { this.t = setInterval(() => { x.unref(); }, 1); } }';
    expect(findUnrefViolations('a.ts', source)).toHaveLength(1);
  });

  test('accepts an immediate .unref and an unrefHandle wrapper', () => {
    expect(findUnrefViolations('a.ts', 'setInterval(() => {}, 1).unref();')).toHaveLength(0);
    expect(findUnrefViolations('a.ts', 'unrefHandle(setInterval(() => {}, 1));')).toHaveLength(0);
  });

  test('accepts chained and later-unref-ed intervals', () => {
    expect(findUnrefViolations('a.ts', 'setInterval(() => {}, 1).unref?.();')).toHaveLength(0);
    expect(
      findUnrefViolations('a.ts', 'class A { start() { this.t = this.setIntervalImpl(() => {}, 1); this.t?.unref?.(); } }'),
    ).toHaveLength(0);
    expect(
      findUnrefViolations('a.ts', 'class A { start() { this.t = setInterval(() => {}, 1); this.t.unref?.(); } }'),
    ).toHaveLength(0);
  });

  test('all setInterval sites in platform/ have .unref?.() (real AST walk)', async () => {
    const files: string[] = [];
    for await (const entry of glob('**/*.ts', { cwd: ENGINE_SRC })) {
      files.push(resolve(ENGINE_SRC, entry));
    }

    const allViolations: { file: string; line: number; snippet: string }[] = [];

    for (const file of files) {
      const content = readFileSync(file, 'utf8');
      // Skip files with no setInterval at all (fast path)
      if (!content.includes('setInterval')) continue;

      const violations = findUnrefViolations(file, content);
      for (const v of violations) {
        allViolations.push({
          file: file.replace(ENGINE_SRC + '/', ''),
          line: v.line,
          snippet: v.snippet,
        });
      }
    }

    if (allViolations.length > 0) {
      const details = allViolations
        .map((v) => `  ${v.file}:${v.line}: ${v.snippet}`)
        .join('\n');
      throw new Error(
        `${allViolations.length} setInterval site(s) missing .unref?.(), add .unref?.() to keep process exit clean:\n${details}`,
      );
    }

    expect(allViolations.length).toBe(0);
  });
});
