/**
 * page-reading.ts, the fetch tool's `readable` and `summary` modes: Jev reads
 * which parts of a page are its main content (`engine.tools.page-content`)
 * and which paragraph says what it is about (`engine.tools.page-summary`).
 * Carving the page into blocks and paragraphs is the HTML grammar
 * (page-blocks.ts); listing its headings is too. A failed reading throws, and
 * the fetch reports it as that URL's error.
 */
import { judgmentPort } from '@goodvibes-jev/engine/errors';
import type { Candidate } from '@goodvibes-jev/judgment';
import { pageContent } from '../batteries/page-content.js';
import { pageSummary, paragraphCandidate } from '../batteries/page-summary.js';
import { pageBlocks, pageTitle, pageUnits } from './page-blocks.js';
import { decisionOrClassic } from '../../runtime/decision-policy.js';

const READABLE_SITE = 'tools.fetch.readable';
const SUMMARY_SITE = 'tools.fetch.summary';

/** Stated when Jev reads no paragraph as saying what the page is about. */
export const NO_SUMMARY_NOTE = 'No paragraph on this page reads as saying what the page is about.';

/** The page's main content: every block except those read, with a no that acts, as not main content. */
export async function readReadable(html: string): Promise<string> {
  return decisionOrClassic(() => readDecisionReadable(html), () => pageBlocks(pageUnits(html)).map(block => block.text).join('\n\n'));
}

async function readDecisionReadable(html: string): Promise<string> {
  const blocks = pageBlocks(pageUnits(html)).map((block, index) => ({ number: index + 1, ...block }));
  const port = judgmentPort(READABLE_SITE);
  const readings = await pageContent.read(port, pageTitle(html), blocks, { site: READABLE_SITE });
  const kept = blocks.filter((block) => {
    const reading = readings.get(block.number);
    return !(reading?.verdict === 'no' && reading.outcome === 'act');
  });
  return kept.map((block) => block.text).join('\n\n');
}

/**
 * The id of the paragraph that best says what the page is about, when the
 * reading acts on one. The selector splits a page larger than one request by
 * the port's own limits and holds the final itself, so every paragraph is
 * offered in one call and the action is recorded once, after the final pick.
 */
async function pickSummary(title: string, candidates: readonly Candidate[]): Promise<string | undefined> {
  if (candidates.length === 0) return undefined;
  const selection = await pageSummary.select(judgmentPort(SUMMARY_SITE), { title }, candidates, { site: SUMMARY_SITE });
  const picked = selection.outcome === 'act' ? selection.chosen : undefined;
  selection.recordAction(picked === undefined ? 'no summary paragraph' : `summarized by ${picked}`);
  return picked;
}

/**
 * The page's summary: the paragraph Jev reads as saying what the page is
 * about, then (for HTML) the page's headings as an outline.
 */
export async function readSummary(body: string, isHtml: boolean): Promise<string> {
  return decisionOrClassic(() => readDecisionSummary(body, isHtml), () => {
    const units = isHtml ? pageUnits(body) : body.split(/\n{2,}/).map(text => ({ text: text.trim(), headingLevel: undefined })).filter(unit => unit.text);
    const first = units.find(unit => unit.headingLevel === undefined)?.text ?? '';
    const headings = units.filter(unit => unit.headingLevel !== undefined).map(unit => `${'#'.repeat(unit.headingLevel!)} ${unit.text}`);
    return ['[Classic page excerpt and outline; no semantic summary was generated.]', first,
      ...(headings.length ? [`Headings:\n${headings.join('\n')}`] : [])].filter(Boolean).join('\n\n');
  });
}

async function readDecisionSummary(body: string, isHtml: boolean): Promise<string> {
  const units = isHtml ? pageUnits(body) : body.split(/\n{2,}/).map((text) => ({ text: text.trim(), headingLevel: undefined })).filter((unit) => unit.text);
  const paragraphs = units.filter((unit) => unit.headingLevel === undefined).map((unit) => unit.text);
  const candidates = paragraphs.map((text, index) => paragraphCandidate(`p${index + 1}`, text));
  const picked = await pickSummary(isHtml ? pageTitle(body) : '', candidates);
  const summary = picked === undefined ? undefined : paragraphs[Number(picked.slice(1)) - 1];
  const headings = units.filter((unit) => unit.headingLevel !== undefined).map((unit) => `${'#'.repeat(unit.headingLevel!)} ${unit.text}`);
  const parts = [summary ?? NO_SUMMARY_NOTE];
  if (headings.length > 0) parts.push(`Headings:\n${headings.join('\n')}`);
  return parts.join('\n\n');
}
