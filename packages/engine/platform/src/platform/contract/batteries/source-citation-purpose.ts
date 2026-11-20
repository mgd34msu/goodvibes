import { defineBattery, yesNo, STAKES_BANDS } from '@goodvibes/judgment';

/** Select primary evidence without confusing a read ledger with a claim. */
export const sourceCitationPurpose = defineBattery({
  name: 'contract.source-citation-purpose',
  version: 3,
  description: 'Whether an identified source citation is a returned-read receipt rather than claim evidence.',
  accuracyFloor: 0.95,
  items: {
    receipt_only: yesNo(
      'In the report text around it (its `context`), is the identified citation occurrence (its `path`, `start` and `end`) used ONLY to account for which source was read, rather than to support a substantive finding, behavioral claim or assessment? Classify this occurrence, not the whole passage: a passage may contain a read ledger citation and a different claim citation. If this occurrence supports both, retain it. Do not judge review completeness or correctness.',
      { yes: STAKES_BANDS.medium.confidence, no: STAKES_BANDS.high.confidence },
      { true: 'This occurrence is only returned-read accounting. Other occurrences may separately support findings.',
        false: 'This occurrence supports a finding, behavioral claim or assessment, or its own use mixes that support with read accounting.' },
    ),
  },
  fixtures: [
    { name: 'read ledger', state: { citation: { path: 'src/parser.ts', start: 1, end: 900, offset: 31,
      context: 'Actual read receipts follow.\n- src/parser.ts:1-900 — returned 1-300, 301-600, 601-900; endpoints present.\n- src/handler.ts:1-120 — returned 1-120.' } }, expect: { receipt_only: 'yes' } },
    { name: 'finding', state: { citation: { path: 'src/parser.ts', start: 47, end: 53, offset: 38,
      context: 'The review found an unchecked decode. src/parser.ts:47-53 calls decodeURIComponent before the handler, so a malformed percent escape throws outside the recovery boundary.' } }, expect: { receipt_only: 'no' } },
    { name: 'mixed receipt and finding', state: { citation: { path: 'src/parser.ts', start: 1, end: 900, offset: 21,
      context: 'Review details. Read src/parser.ts:1-900 completely; at lines 47-53 an unchecked decode can throw before recovery.' } }, expect: { receipt_only: 'no' } },
  ],
});

/** Fixed semantic question per identified occurrence, batched in one request. */
export function sourceCitationBatch(count: number) {
  return defineBattery({ name: 'contract.source-citation-purpose', version: sourceCitationPurpose.version,
    description: sourceCitationPurpose.description, accuracyFloor: sourceCitationPurpose.accuracyFloor,
    items: Object.fromEntries(Array.from({ length: count }, (_, index) => [`citation_${index}`, yesNo(
      `Evaluate ONLY citations[${index}] in the state, identified by its path, start, end and offset. Other citation occurrences in the same paragraph may have different purposes. ${String(sourceCitationPurpose.items.receipt_only.question.instructions ?? '')}`,
      sourceCitationPurpose.items.receipt_only.band,
      sourceCitationPurpose.items.receipt_only.question.criteria ?? undefined,
    )])), fixtures: sourceCitationPurpose.fixtures.map(fixture => {
      const state = fixture.state as { citation: Record<string, string | number> };
      return { name: fixture.name, state: { citations: Array.from({ length: count }, () => state.citation) },
        expect: Object.fromEntries(Array.from({ length: count }, (_, index) => [`citation_${index}`, fixture.expect.receipt_only ?? 'no'])) };
    }),
  });
}
