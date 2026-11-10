/** Real native mirror input provenance for synthetic triage-model fixtures. */
import { afterEach } from 'bun:test';
import { InboxCursorStore } from '../../platform/src/platform/intake/cursor-store.js';
import type { TriageInput, TriageReceiptScope } from '../../platform/src/platform/intake/triage/types.js';
import { makeProjectTempDir } from './project-temp.ts';

const mirrors: InboxCursorStore[] = [];
afterEach(async () => { for (const mirror of mirrors.splice(0).reverse()) await mirror.close(); });

export async function triageSource(items: readonly TriageInput[], scope: TriageReceiptScope = { providerId: 'synthetic', accountScopeId: 'original-unit-account' }) {
  const directory = makeProjectTempDir('triage-native-input-');
  const mirror = new InboxCursorStore(directory, 'mirror.sqlite', { sweepIntervalMs: 0, triageScope: scope });
  mirrors.push(mirror); await mirror.init();
  const update = (current: readonly TriageInput[]) => mirror.upsertItems(current.map(item => ({
    id: item.id, provider: item.surface, kind: item.conversationKind === 'direct' ? 'dm' as const : item.conversationKind === 'thread' ? 'thread' as const : 'mention' as const,
    fromDigest: 'redacted-unit-sender', subjectPreview: item.subject ?? '', bodyPreview: item.snippet ?? '', unread: item.unread ?? false, receivedAt: Date.now(),
  })));
  update(items);
  return { mirror, directory, scope, options: { receiptScope: scope, receiptSource: mirror }, update };
}
