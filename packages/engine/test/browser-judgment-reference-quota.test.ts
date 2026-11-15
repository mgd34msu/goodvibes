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
  test('one principal filling the store cannot starve another, and loses only its own oldest', () => {
    const references = new BrowserJudgmentReferences(() => NOW);
    try {
      const flood = Array.from({ length: 64 }, () => issue(references, 'noisy'));
      // A single principal keeps every reference up to the store's bound.
      expect(flood.every((id) => resolves(references, id, 'noisy'))).toBe(true);
      const other = issue(references, 'quiet');
      expect(resolves(references, other, 'quiet')).toBe(true);
      expect(resolves(references, flood[63]!, 'noisy')).toBe(true);
      expect(resolves(references, flood[0]!, 'noisy')).toBe(false);
      // At the bound the issuer drops its own oldest, never the smaller holder's.
      issue(references, 'noisy');
      expect(resolves(references, other, 'quiet')).toBe(true);
      expect(resolves(references, flood[1]!, 'noisy')).toBe(false);
    } finally { references.close(); }
  });
});
