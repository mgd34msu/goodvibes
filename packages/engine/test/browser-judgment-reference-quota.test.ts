import { describe, expect, test } from 'bun:test';
import type { AuthenticatedPrincipal } from '../daemon-api/src/index.js';
import { BrowserJudgmentReferences } from '../platform/src/platform/judgment-browser/references.js';

const BATTERY = 'webui.errors.daemon-refusal';
const NOW = 1_000_000;

function principal(id: string): AuthenticatedPrincipal {
  return { principalId: id, principalKind: 'user', admin: false, scopes: ['write:judgment'] } as unknown as AuthenticatedPrincipal;
}

function issue(references: BrowserJudgmentReferences, principalId: string): string {
  return references.issue({
    principalId, battery: BATTERY, revision: crypto.randomUUID(), expiresAt: NOW + 300_000,
    snapshot: { methodId: 'x', status: 500, message: 'failed' }, assertCurrent: () => {}, mayRead: () => true,
  });
}

function resolves(references: BrowserJudgmentReferences, id: string, actor: string): boolean {
  try { references.resolve(id, () => principal(actor), BATTERY, (value) => value); return true; } catch { return false; }
}

describe('browser judgment reference quota', () => {
  test('one principal filling its slots cannot starve another principal', () => {
    const references = new BrowserJudgmentReferences(() => NOW);
    try {
      const flood = Array.from({ length: 64 }, () => issue(references, 'noisy'));
      expect(() => issue(references, 'quiet')).not.toThrow();
      const other = issue(references, 'quiet');
      expect(resolves(references, other, 'quiet')).toBe(true);
      // The noisy principal keeps its most recent references and loses its oldest.
      expect(resolves(references, flood[63]!, 'noisy')).toBe(true);
      expect(resolves(references, flood[0]!, 'noisy')).toBe(false);
    } finally { references.close(); }
  });

  test('a store full of other principals still admits one more of a principal that holds a slot', () => {
    const references = new BrowserJudgmentReferences(() => NOW);
    try {
      for (let principalIndex = 0; principalIndex < 8; principalIndex += 1) {
        for (let count = 0; count < 8; count += 1) issue(references, `p${principalIndex}`);
      }
      const added = issue(references, 'p0');
      expect(resolves(references, added, 'p0')).toBe(true);
      expect(() => issue(references, 'newcomer')).toThrow();
    } finally { references.close(); }
  });
});
