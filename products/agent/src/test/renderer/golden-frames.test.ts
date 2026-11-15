import { settleSyntaxHighlighting } from '../../renderer/code-block.ts';
// ---------------------------------------------------------------------------
// golden-frames.test.ts, deterministic whole-screen snapshots of every Agent
// surface, each one run through the design's layout audit.
//
// Every fixture in helpers/agent-frame-fixtures.ts (the base screen, the home
// splash, every modal, popup, bar and block) is rendered with frozen inputs
// under two themes:
//
//   golden-frames/                  the default `goodvibes` theme
//   golden-frames-goodvibes-neon/   the same surfaces under goodvibes-neon
//
// and then
//   1. audited (helpers/frame-audit.ts: nothing past the screen edge, text
//      2 columns from every fill's sides, an empty first and last row in
//      every filled block, every ┃ bar running its block's full height), and
//   2. compared against the committed snapshot.
//
// Snapshot format:
//   Line 1:  # GV_GOLDEN surface=<name> width=<W> height=<H>
//   Lines 2..H+1:  |<chars padded to W>|
//   Then:    @STYLES, one record per non-default attribute: <row> <col> <attr>=<value>
//
// Update path:
//   GOODVIBES_UPDATE_GOLDENS=1 on a local run of this file (refused when CI is set).
//   Without the variable a mismatch (or a missing snapshot) fails.
// ---------------------------------------------------------------------------

import { describe, expect, test } from 'bun:test';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { activeTokens, setActiveThemeMode, setActiveThemeName } from '../../renderer/theme.ts';
import { auditFrame } from '../helpers/frame-audit.ts';
import { frameFixtures } from '../helpers/agent-frame-fixtures.ts';
import { assertGoldenIn } from '../helpers/golden-snapshot.ts';
import { STACK_GOLDEN_NAMES } from '../helpers/golden-stack-names.ts';
import { SESSION_VIEW_GOLDEN_NAMES } from './golden-frames-session-views-cases.ts';
import { workTreeGoldenNames } from './golden-frames-work-tree-cases.ts';

const SETS: ReadonlyArray<{ readonly theme: string; readonly dir: string }> = [
  { theme: 'goodvibes', dir: new URL('./golden-frames/', import.meta.url).pathname },
  { theme: 'goodvibes-neon', dir: new URL('./golden-frames-goodvibes-neon/', import.meta.url).pathname },
];

for (const set of SETS) {
  describe(`golden frames : ${set.theme}`, () => {
    for (const fixture of frameFixtures()) {
      test(fixture.name, async () => {
        setActiveThemeName(set.theme);
        setActiveThemeMode('dark');
        try {
          fixture.render();
          await settleSyntaxHighlighting();
          const lines = fixture.render();
          expect(lines).toHaveLength(fixture.height);
          expect(lines.every((line) => line.length === fixture.width)).toBe(true);
          // The layout audit runs on every frame before it is compared.
          const issues = auditFrame(lines, fixture.width, activeTokens());
          expect(issues.map((i) => `${i.kind} row ${i.row}: ${i.detail}`)).toEqual([]);
          assertGoldenIn(set.dir, fixture.name, lines);
        } finally {
          setActiveThemeName('goodvibes');
          setActiveThemeMode('dark');
        }
      });
    }
  });
}

describe('golden frames : no stale snapshots', () => {
  // The layout audit reads whatever is on disk, so a snapshot whose fixture was
  // renamed or removed would stay audited and never be compared.
  const known = new Set<string>([
    ...frameFixtures().map((fixture) => fixture.name),
    ...SESSION_VIEW_GOLDEN_NAMES,
    ...workTreeGoldenNames(),
    ...STACK_GOLDEN_NAMES,
  ]);
  for (const set of SETS) {
    test(`every ${set.theme} snapshot on disk belongs to a fixture`, () => {
      const stale = readdirSync(set.dir).filter((f) => f.endsWith('.txt') && !known.has(f.slice(0, -'.txt'.length)));
      expect(stale).toEqual([]);
    });
  }
});

describe('golden frames : chrome height', () => {
  test('chrome at rest is 7 rows: header 1, input area 5 (caps and padding around the text), status line 1', async () => {
    const { UIFactory } = await import('../../renderer/ui-factory.ts');
    const { fixtureFooter } = await import('../helpers/agent-frame-fixtures.ts');
    expect(UIFactory.createHeader(120, 'claude-opus-4')).toHaveLength(1);
    expect(fixtureFooter(120)).toHaveLength(6);
  });
});
