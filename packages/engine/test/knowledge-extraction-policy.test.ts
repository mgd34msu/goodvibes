import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { installJudgmentPort } from '@goodvibes-jev/engine/errors';
import type { JudgmentPort } from '@goodvibes-jev/judgment';
import { fakePort, noulAnswer } from '@goodvibes-jev/judgment/testing';
import {
  KNOWLEDGE_EXTRACTOR_VERSION,
  hasUsefulKnowledgeExtractionText,
  knowledgeExtractionNeedsRefresh,
} from '../platform/src/platform/knowledge/extraction-policy.js';
import { extractionReadability } from '../platform/src/platform/knowledge/batteries/extraction-readability.js';
import { registry } from '../platform/src/platform/knowledge/extraction/judgment-registry.js';
import type { KnowledgeExtractionRecord } from '../platform/src/platform/knowledge/types.js';

let previous: JudgmentPort | undefined;
beforeEach(() => { previous = installJudgmentPort(undefined); });
afterEach(() => { installJudgmentPort(previous); });

function answer(p: number) {
  const fake = fakePort(() => noulAnswer(p));
  installJudgmentPort(fake.port);
  return fake;
}

function extraction(overrides: Partial<KnowledgeExtractionRecord>): KnowledgeExtractionRecord {
  return {
    id: 'extract-test', sourceId: 'source-test', extractorId: 'pdfjs', format: 'pdf',
    sections: [], links: [], estimatedTokens: 1, structure: {},
    metadata: { extractorVersion: KNOWLEDGE_EXTRACTOR_VERSION }, createdAt: 1, updatedAt: 1,
    ...overrides,
  };
}

describe('knowledge extraction refresh policy', () => {
  test('registers the readability decision and runs the synthetic labelled readability fixtures', async () => {
    expect(registry.list()).toContain(extractionReadability);
    for (const fixture of extractionReadability.fixtures) {
      const sample = (fixture.state as { sample: string }).sample;
      const fake = answer(fixture.expect.readable === 'yes' ? 0.99 : 0.01);
      expect(await hasUsefulKnowledgeExtractionText(sample)).toBe(fixture.expect.readable === 'yes');
      expect(fake.requests[0]?.context?.battery).toBe(extractionReadability.name);
      expect(fake.requests[0]?.context?.site).toBe('knowledge.extraction.readability');
    }
  });

  test('whether an extraction needs refreshing is read from its stored fields: decision-model requests 0', () => {
    const fake = answer(0.01);
    expect(knowledgeExtractionNeedsRefresh(extraction({ summary: 'The display supports HDMI eARC.', metadata: { extractorVersion: KNOWLEDGE_EXTRACTOR_VERSION, readable: true } }))).toBe(false);
    expect(knowledgeExtractionNeedsRefresh(extraction({ summary: 'Decoding noise', metadata: { extractorVersion: KNOWLEDGE_EXTRACTOR_VERSION, readable: false } }))).toBe(true);
    expect(knowledgeExtractionNeedsRefresh(extraction({ summary: 'Current text' }), KNOWLEDGE_EXTRACTOR_VERSION + 1)).toBe(true);
    expect(knowledgeExtractionNeedsRefresh(extraction({ summary: 'PDF extraction produced limited text; OCR is not used in-core.' }))).toBe(true);
    expect(knowledgeExtractionNeedsRefresh(null)).toBe(true);
    expect(fake.requests).toHaveLength(0);
  });
});
