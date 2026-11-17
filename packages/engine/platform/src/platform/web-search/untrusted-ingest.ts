/**
 * untrusted-ingest.ts, telling the ledger what a web search brought back.
 *
 * A result's title and snippet, and an instant answer, are written by whoever
 * wrote the page (or the provider summarising it), so they are untrusted text
 * like a fetched page, a browser read, a message or an MCP result. They are
 * recorded with their text, under the origin of the page each came from, so a
 * later send that repeats them is held and the refusal names a page a person
 * can check. Fetched evidence is recorded by the fetch runtime that read it.
 */

import { getProcessUntrustedContentLedger, originOf } from '../security/untrusted-content.js';
import type { WebSearchResponse } from './types.js';

/** The text of each result and of the instant answer, recorded as untrusted. Empty text records nothing. */
export function recordSearchResultsAsUntrusted(response: Pick<WebSearchResponse, 'providerLabel' | 'results' | 'instantAnswer'>): void {
  const ledger = getProcessUntrustedContentLedger();
  const at = new Date().toISOString();
  for (const result of response.results) {
    const content = [result.title, result.snippet].filter((part): part is string => typeof part === 'string' && part.trim().length > 0).join('\n');
    if (!content) continue;
    ledger.record({ surface: 'web-page', origin: originOf(result.url), at, content });
  }
  const answer = response.instantAnswer;
  if (answer) {
    const content = [answer.heading, answer.answer, answer.abstract, ...answer.related.map((topic) => topic.text)]
      .filter((part): part is string => typeof part === 'string' && part.trim().length > 0).join('\n');
    if (content) ledger.record({ surface: 'web-page', origin: answer.url ? originOf(answer.url) : `the ${response.providerLabel} instant answer`, at, content });
  }
}
