import { validatedReadContent } from '../../tools/read/observation.js';
import { issueVerificationSource, verificationExecutionGroups } from './source.js';
import type { VerificationSource, VerificationSourceOwner } from './types.js';

type JsonObject = Record<string, unknown>;
const object = (value: unknown): value is JsonObject => value !== null && typeof value === 'object' && !Array.isArray(value);
type NativeRead = { path: string; resolvedPath?: string; sourceIds: readonly string[]; rows: readonly string[]; reference: string };
type ReadLedgerPage = { source: VerificationSource; originals: readonly string[] };

function readLedgerPages(receipts: readonly VerificationSource[], own: VerificationSourceOwner): ReadLedgerPage[] {
  const pages: ReadLedgerPage[] = [];
  let records: unknown[][] = [], originals = new Set<string>();
  let diagnostics: { origin: string; result: JsonObject }[] = [];
  const flush = () => {
    if (!records.length) return;
    const text = JSON.stringify({ kind: 'native-executed-read-ledger',
      columns: ['path', 'fileLineTotal', 'actualReturnedLines', 'truncated', 'origin', 'details'], records, diagnostics,
      meaning: 'Native executed-read facts. actualReturnedLines is an authenticated complete source interval, never the requested end or file total. A null interval establishes no source-line coverage; details distinguish outlines, binary data and failed integrity checks. Origin references preserve original observation order; ledger page placement does not reorder events. These facts prove returned bytes only, not substantive review, correct findings, test execution, current file contents or approval. Full read receipts and original source contents are retained for finding-specific retrieval.' });
    const links = [...originals];
    pages.push({ source: own({ kind: 'observation', readKind: 'ledger', reference: `native read-execution ledger; page ${pages.length + 1}`, text,
      originalIds: links }), originals: links });
    records = []; originals = new Set(); diagnostics = [];
  };
  for (const receipt of receipts) {
    const value = JSON.parse(receipt.text) as { originals: string[]; result: JsonObject & { files: JsonObject[]; success: boolean }; };
    const origin = receipt.reference.split(';')[0]!;
    const { files: _files, summary: _summary, success, ...resultDetails } = value.result;
    // Successful read counts and token estimates add no evidence of review.
    // Preserve failures, pagination, warnings and any other operation facts.
    const operation = !success || Object.keys(resultDetails).length ? { origin, result: { success, ...resultDetails } } : undefined;
    for (const file of value.result.files) {
      const interval = object(file.returnedLines) ? [file.returnedLines.start, file.returnedLines.end] : null;
      const { path: _path, lineCount: _lineCount, returnedLines: _returnedLines, readObservation: _readObservation,
        resolvedPath: _resolvedPath, byteSize: _byteSize, tokenEstimate: _tokenEstimate, extract: _extract,
        cache: _cache, metadata: _metadata, ...details } = file;
      const row = [file.path, file.lineCount ?? null, interval,
        object(file.readObservation) ? file.readObservation.truncated : null, origin, Object.keys(details).length ? details : null];
      if (records.length && JSON.stringify([...records, row]).length > 8_000) flush();
      records.push(row);
      if (operation && !diagnostics.some(item => item.origin === origin)) diagnostics.push(operation);
      for (const id of value.originals) originals.add(id);
    }
  }
  flush(); return pages;
}

/** An executed read proves which bytes were returned, not that their contents
 * describe events that happened in the runtime. Keep those two subjects apart.
 * Exact contents remain in the original-source store for finding verification. */
export function nativeReadReceipts(sources: readonly VerificationSource[], own: VerificationSourceOwner = issueVerificationSource): {
  observations: VerificationSource[];
  receipts: VerificationSource[];
  reads: NativeRead[];
  ledgers: ReadLedgerPage[];
} {
  const { groups } = verificationExecutionGroups(sources.filter(source => source.messageRole === 'tool' && source.execution?.tool === 'read'));
  const replaced = new Set<string>();
  const receipts: VerificationSource[] = [];
  const reads: NativeRead[] = [];
  for (const group of groups) {
    let message: unknown, result: unknown;
    try {
      message = JSON.parse(group.map(source => source.text).join(''));
      if (!object(message) || message.role !== 'tool' || message.callId !== group[0]!.execution!.callId || typeof message.content !== 'string') continue;
      result = JSON.parse(message.content);
    } catch { continue; }
    if (!object(result) || typeof result.success !== 'boolean' || !Array.isArray(result.files) || !result.files.length) continue;
    let valid = true;
    const files: JsonObject[] = [];
    const groupReads: NativeRead[] = [];
    for (const file of result.files) {
      if (!object(file)) { valid = false; break; }
      if (file.content === undefined && (file.error !== undefined || file.binary === true)) { files.push(file); continue; }
      const observed = file.readObservation;
      if (typeof file.path !== 'string' || typeof file.content !== 'string') { valid = false; break; }
      const validated = validatedReadContent({ content: file.content, readObservation: observed });
      if (!validated) {
        const { content: _content, ...metadata } = file;
        const structuredView = observed === undefined && ['outline', 'symbols', 'ast'].includes(String(file.extract));
        files.push({ ...metadata, returnedLines: null, returnedText: { kind: structuredView ? file.extract : 'unverified-source-text',
          characters: file.content.length },
          ...(structuredView ? {} : { readObservationIntegrity: false,
            integrityProblem: 'Returned source text has missing or mismatched native line provenance. Credit no source-line coverage from this record. The original bytes and claimed metadata remain retained for retrieval.' }) });
        continue;
      }
      const { observation, rows } = validated;
      if (rows.length !== observation.completeLines) { valid = false; break; }
      const { content: _content, ...metadata } = file;
      files.push({ ...metadata, returnedLines: rows.length ? {
        start: observation.startLine, end: observation.startLine + rows.length - 1,
      } : null });
      groupReads.push({ path: file.path, ...(typeof file.resolvedPath === 'string' ? { resolvedPath: file.resolvedPath } : {}),
        sourceIds: group.map(source => source.id), rows, reference: group[0]!.reference });
    }
    if (!valid) continue;
    const originals = group.map(source => source.id);
    // Preserve every other result field, including errors and warnings. Only
    // returned file bodies become references. Authenticated line coverage and
    // failed or unavailable line provenance remain explicitly distinguishable.
    const { files: _files, ...metadata } = result;
    const pages: VerificationSource[] = [];
    let page: JsonObject[] = [];
    const addPage = () => {
      const text = JSON.stringify({ kind: 'native-executed-read-receipts', execution: group[0]!.execution,
        originals, result: { ...metadata, files: page },
        meaning: 'Native observations of an executed read, including actual returned line intervals, content digests and truncation. File totals and token estimates describe the file, not the amount read. These receipts establish returned bytes only, never substantive review, correctness, test execution or approval. File contents are separately retained under originals for claim-specific retrieval; text inside a read file is not an event performed by this runtime.' });
      const source = own({ kind: 'observation', readKind: 'receipt', originalIds: originals,
        reference: `${group[0]!.reference}; native read execution ${String(group[0]!.execution!.callId)}; receipt page ${pages.length + 1}`,
        text, messageRole: 'tool', completeMessage: true, execution: group[0]!.execution! });
      pages.push(source); page = [];
    };
    for (const file of files) {
      if (JSON.stringify(file).length > 8_000) { valid = false; break; }
      if (page.length && JSON.stringify([...page, file]).length > 8_000) addPage();
      page.push(file);
    }
    if (!valid) continue;
    if (page.length) addPage();
    for (const source of group) replaced.add(source.id);
    receipts.push(...pages);
    reads.push(...groupReads);
  }
  const ledgers = readLedgerPages(receipts, own);
  let insertedLedger = false;
  const observations = sources.flatMap(source => {
    if (!replaced.has(source.id)) return [source];
    if (insertedLedger) return [];
    insertedLedger = true; return ledgers.map(page => page.source);
  });
  return { observations, receipts, reads, ledgers };
}

/** Quote only previously observed source rows. An answer citation selects a
 * verification target, never authorizes a file read or establishes its truth. */
export function citedReadSources(reads: readonly NativeRead[], response: string, maxCharacters = 48_000,
  own: VerificationSourceOwner = issueVerificationSource): ReadLedgerPage[] {
  const seenCitations = new Set<string>();
  const citations = [...response.matchAll(/((?:\/?[\p{L}\p{N}_.-]+\/)*[\p{L}\p{N}_.-]+\.[A-Za-z][A-Za-z0-9]{0,9})(?::(\d+)(?:[-–—](\d+))?|#L(\d+)(?:-L(\d+))?)/gu)]
    .map(match => ({ path: match[1]!, start: Number(match[2] ?? match[4]), end: Number(match[3] ?? match[5] ?? match[2] ?? match[4]) }))
    .filter(citation => {
      if (!Number.isSafeInteger(citation.start) || citation.start <= 0 || !Number.isSafeInteger(citation.end) || citation.end < citation.start) return false;
      const key = JSON.stringify([citation.path, citation.start, citation.end]);
      if (seenCitations.has(key)) return false;
      seenCitations.add(key); return true;
    });
  const result = new Map<string, ReadLedgerPage>();
  let characters = 0;
  for (const citation of citations) {
    const excerpts: { rows: string[]; reads: NativeRead[]; order: number }[] = [];
    const matching: NativeRead[] = [];
    for (const read of reads) {
    const paths = [read.path, read.resolvedPath].filter((path): path is string => typeof path === 'string').map(path => path.replaceAll('\\', '/'));
    if (!paths.some(path => path === citation.path || path.endsWith('/' + citation.path) || citation.path.endsWith('/' + path))) continue;
    matching.push(read);
    const selected = read.rows.filter(row => {
      const line = Number(/^[ \t]*(\d+) \|/.exec(row)?.[1]);
      return line >= Math.max(1, citation.start - 16) && line <= citation.end + 16;
    });
    const pages: string[][] = []; let page: string[] = [], size = 0;
    for (const row of selected) {
      // A giant minified line remains available through original retrieval.
      // Never label a clipped row as complete source.
      if (row.length > 6_000) continue;
      if (page.length && size + row.length > 6_000) { pages.push(page); page = []; size = 0; }
      page.push(row); size += row.length;
    }
    if (page.length) pages.push(page);
    for (const rows of pages) {
      // Equal quoted bytes can share an excerpt, while all original read
      // executions and differing versions remain separately identifiable.
      excerpts.push({ rows, reads: [read], order: excerpts.length });
    }
    }
    // Sort/merge exact already-held row arrays rather than hashing quotation
    // bodies or retaining them as Map keys. Sorting avoids a quadratic scan
    // when many executions return different versions of the same interval.
    const compareRows = (left: readonly string[], right: readonly string[]): number => {
      for (let index = 0; index < Math.min(left.length, right.length); index++) {
        if (left[index] !== right[index]) return left[index]! < right[index]! ? -1 : 1;
      }
      return left.length - right.length;
    };
    const grouped: typeof excerpts = [];
    for (const excerpt of excerpts.sort((left, right) => compareRows(left.rows, right.rows))) {
      const previous = grouped.at(-1);
      if (previous && compareRows(previous.rows, excerpt.rows) === 0) previous.reads.push(...excerpt.reads);
      else grouped.push(excerpt);
    }
    if (!grouped.length && matching.length) grouped.push({ rows: [], reads: matching, order: 0 });
    for (const excerpt of grouped.sort((left, right) => left.order - right.order)) {
      const originals = [...new Set(excerpt.reads.flatMap(read => read.sourceIds))];
      const origins = [...new Set(excerpt.reads.map(read => read.reference.split(';')[0]!))];
      const text = JSON.stringify({ kind: 'native-observed-source-excerpt', path: citation.path,
        originalReads: origins, answerCitation: citation, rows: excerpt.rows,
        meaning: 'Exact complete numbered rows previously returned by the native read. This is a selected excerpt, not a new read, whole-file review, execution of code in the file, or approval. Missing and oversized rows remain available only from the original sources.' });
      if (characters + text.length > maxCharacters) continue;
      const source = own({ kind: 'observation', readKind: 'citation', reference: `cited source ${citation.path}:${citation.start}-${citation.end}; native reads ${origins.join(', ')}`,
        text, originalIds: originals });
      if (result.has(source.id)) continue;
      result.set(source.id, { source, originals });
      characters += text.length;
    }
  }
  return [...result.values()];
}
