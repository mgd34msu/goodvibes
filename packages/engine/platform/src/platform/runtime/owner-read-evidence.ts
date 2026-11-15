import { spawnSync } from 'node:child_process';
import { existsSync, lstatSync, readFileSync, type BigIntStats } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { sourceReadsFromTurns, type ContractTurnRecord, type SourceReadEvidence } from '../contract/evidence.js';
import { readBodyWithHostEvidence, returnedReadRows } from '../tools/read/observation.js';
import type { ToolResult } from '../types/tools.js';
import type { OwnerEvidenceReader } from '../contract/owner-evidence.js';
import { sanitizeSessionName } from '../sessions/manager.js';
import { recoveryFilePath } from './recovery-path.js';
import { logger } from '../utils/logger.js';
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);

/** No owner evidence for this call; one debug line says why, so "none read" and "reader refused" can be told apart. */
function none(reason: string, sessionId?: string): undefined {
  logger.debug('owner read evidence: none', { reason, ...(sessionId ? { sessionId } : {}) });
  return undefined;
}

const sameFile = (before: BigIntStats, after: BigIntStats): boolean => after.dev === before.dev && after.ino === before.ino && after.mode === before.mode
  && after.nlink === 1n && after.size === before.size && after.mtimeNs === before.mtimeNs && after.ctimeNs === before.ctimeNs;

/** Where the owner's read results come from. */
export interface OwnerReadSource {
  /**
   * The owner conversation's stored messages when that session is loaded in
   * this process (the same objects the conversation holds): the one owner of
   * the fact, current to the last tool result, with no disk read.
   */
  readonly liveMessages?: ((sessionId: string) => readonly object[] | undefined) | undefined;
  /** The surface directory (`<project>/.goodvibes/<surface>`), read for a session not loaded here (resume after restart). */
  readonly surfaceDirectory?: string | undefined;
}

/** Reuses actual owner read results only after each numbered line matches
 * the contract's immutable input. Session text cannot certify source or work. */
export function createOwnerReadEvidenceReader(from: string | OwnerReadSource): OwnerEvidenceReader {
  const source: OwnerReadSource = typeof from === 'string' ? { surfaceDirectory: from } : from;
  // Retain only recent exact originals; private journal bytes never become keys
  // or evidence fields. Oversized entries are still read, simply not cached.
  const cacheByteLimit = 16 * 1024 * 1024;
  const cache = new Map<string, { scope: SourceReadEvidence[]; calls: string[];
    rows: Map<string, [number, string][]>; citations: RegExp;
    originals: readonly { path: string; buffer: Buffer }[]; byteLength: number;
    liveStamp?: { readonly count: number; readonly last: unknown } | undefined }>();
  return (contract, citationText) => {
    if (!contract.sessionId) return none('contract has no owner session');
    if (!contract.inputSnapshot || !/^[a-f0-9]{40,64}$/.test(contract.inputSnapshot.inputTree)) return none('contract has no input tree', contract.sessionId);
    const sessionId = contract.sessionId;
    const sources: { path: string; buffer: Buffer; bytes: number; contents: string }[] = [];
    let messages: Record<string, unknown>[] | undefined;
    const live = source.liveMessages?.(contract.sessionId);
    if (live) {
      messages = live.filter(object);
    } else {
      const surfaceDirectory = source.surfaceDirectory;
      if (!surfaceDirectory) return none('session not loaded here and no surface directory', sessionId);
      const within = relative(contract.projectRoot, surfaceDirectory);
      if (isAbsolute(within) || within.split('/').includes('..') || !within.startsWith('.goodvibes/')) return none('surface directory is outside the project .goodvibes directory', sessionId);
      let directory = contract.projectRoot;
      for (const part of within.split('/')) {
        directory = join(directory, part);
        if (existsSync(directory) && (!lstatSync(directory).isDirectory() || lstatSync(directory).isSymbolicLink())) return none('surface directory path is not a plain directory', sessionId);
      }
      // The names the session store and the recovery writer give these files.
      const sessionFiles = [join(surfaceDirectory, 'sessions', `${sanitizeSessionName(contract.sessionId)}.jsonl`)];
      try { sessionFiles.push(recoveryFilePath(join(surfaceDirectory, 'recovery'), contract.sessionId)); } catch { /* no recovery name for this id */ }
      for (const path of sessionFiles) {
        if (!existsSync(path)) continue;
        let bytes: Buffer | undefined;
        // A session save can land between the two stats; one more read then sees the saved file.
        for (let attempt = 0; attempt < 2 && bytes === undefined; attempt++) {
          const info = lstatSync(path, { bigint: true });
          if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1n || lstatSync(join(path, '..')).isSymbolicLink()) return none('session journal is not a single-link regular file', sessionId);
          const read = readFileSync(path);
          if (sameFile(info, lstatSync(path, { bigint: true }))) bytes = read;
        }
        if (bytes === undefined) return none('session journal changed while it was read, twice', sessionId);
        sources.push({ path, buffer: bytes, bytes: bytes.length, contents: bytes.toString('utf8') });
      }
      if (!sources.length) return none('no session journal on disk', sessionId);
    }
    // A live conversation is keyed by its length and last message; files by their bytes.
    const liveStamp = messages ? { count: messages.length, last: messages[messages.length - 1] } : undefined;
    const key = JSON.stringify([contract.projectRoot, contract.inputSnapshot.inputTree,
      messages ? `conversation:${contract.sessionId}` : sources.map(item => item.path)]);
    let saved = cache.get(key);
    const previous = saved;
    if (previous && (liveStamp
      ? previous.liveStamp?.count !== liveStamp.count || previous.liveStamp?.last !== liveStamp.last
      : !sources.every((item, index) => previous.originals[index]?.buffer.equals(item.buffer)))) {
      cache.delete(key); saved = undefined;
    }
    if (!saved) {
      const turns: ContractTurnRecord[] = [], calls: string[] = [];
      const originals = new Map<string, string[] | null>();
      const seen = new Set<string>();
      if (!messages) {
        messages = [];
        for (const item of sources) {
          for (const line of item.contents.split('\n').filter(Boolean)) {
            try { const parsed: unknown = JSON.parse(line); if (object(parsed)) messages.push(parsed); } catch { return none('a session journal line is not JSON', sessionId); }
          }
        }
      }
      const requests = new Map<string, Record<string, unknown>>();
      for (const message of messages) if (message['role'] === 'assistant' && Array.isArray(message['toolCalls'])) {
        for (const call of message['toolCalls']) if (object(call) && call['name'] === 'read' && typeof call['id'] === 'string') requests.set(call['id'], call);
      }
      const pending: { callId: string; arguments: Record<string, unknown>; files: { path: string; content: string; readObservation?: unknown }[] }[] = [];
      for (const message of messages) {
        if (message['role'] !== 'tool' || typeof message['callId'] !== 'string' || typeof message['content'] !== 'string') continue;
        const call = requests.get(message['callId']);
        if (!call) continue;
        const identity = JSON.stringify([message['callId'], message['content']]);
        if (seen.has(identity)) continue;
        seen.add(identity);
        // The read's observations travel beside its text on the stored message; a result stored before that carries them in the text.
        const result = readBodyWithHostEvidence({ output: message['content'], hostEvidence: message['hostEvidence'] as ToolResult['hostEvidence'] });
        if (result === undefined) continue;
        if (result['success'] !== true || !Array.isArray(result['files'])) continue;
        const files: { path: string; content: string; readObservation?: unknown }[] = [];
        for (const file of result['files']) {
          if (!object(file) || typeof file['path'] !== 'string' || typeof file['content'] !== 'string' || file['error'] || file['binary']
            || (file['extract'] !== 'content' && file['extract'] !== 'lines')) continue;
          // One spelling per file: `./src/a.ts`, `src/a.ts` and the absolute path are the same entry.
          const path = relative(contract.projectRoot, resolve(contract.projectRoot, file.path));
          if (isAbsolute(path) || /[\r\n\0]/.test(path) || path.split('/').includes('..') || path.startsWith('.goodvibes/') || path.startsWith('.git/')) continue;
          if (typeof file.resolvedPath === 'string' && file.resolvedPath !== join(contract.projectRoot, path)) continue;
          files.push({ path, content: file.content, readObservation: file['readObservation'] });
        }
        if (files.length) pending.push({ callId: message['callId'], arguments: object(call['arguments']) ? call['arguments'] : {}, files });
      }
      const sourcePaths = [...new Set(pending.flatMap(record => record.files.map(file => file.path)))];
      for (let offset = 0; offset < sourcePaths.length; offset += 64) {
        const batch = sourcePaths.slice(offset, offset + 64);
        const blobs = spawnSync('git', ['-C', contract.projectRoot, 'cat-file', '--batch'], {
          input: batch.map(path => `${contract.inputSnapshot!.inputTree}:${path}\n`).join(''), maxBuffer: 32 * 1024 * 1024,
        });
        if (blobs.status !== 0) return none('git cat-file failed on the input tree', sessionId);
        let position = 0;
        for (const path of batch) {
          const end = blobs.stdout.indexOf(10, position);
          if (end < 0) return none('git cat-file output ended early', sessionId);
          const header = blobs.stdout.subarray(position, end).toString('utf8');
          const match = /^[a-f0-9]{40,64} (\w+) (\d+)$/.exec(header);
          if (!match) {
            if (!header.endsWith(' missing')) return none('git cat-file returned an unreadable header', sessionId);
            originals.set(path, null); position = end + 1; continue;
          }
          const size = Number(match[2]);
          if (!Number.isSafeInteger(size) || end + 1 + size >= blobs.stdout.length) return none('git cat-file output ended early', sessionId);
          originals.set(path, match[1] === 'blob' ? blobs.stdout.subarray(end + 1, end + 1 + size).toString('utf8').split(/\r?\n/) : null);
          position = end + 1 + size + 1;
        }
      }
      const returned = new Map<string, Map<number, string>>();
      for (const record of pending) {
        const files: { path: string; extract: 'lines'; content: string }[] = [];
        for (const file of record.files) {
          const path = file.path;
          const original = originals.get(path);
          if (!original) continue;
          const rows = returnedReadRows(file).filter((row: string) => {
            const match = /^[ \t]*(\d+) \| ?(.*)$/.exec(row);
            return match !== null && Number.isSafeInteger(Number(match[1])) && Number(match[1]) > 0 && original[Number(match[1]) - 1] === match[2];
          });
          if (rows.length) {
            files.push({ path, extract: 'lines', content: rows.join('\n') });
            const numbered = returned.get(path) ?? new Map<number, string>();
            for (const row of rows) numbered.set(Number(/^[ \t]*(\d+) \|/.exec(row)![1]), row);
            returned.set(path, numbered);
          }
        }
        if (!files.length) continue;
        calls.push(record.callId);
        turns.push({ turn: turns.length + 1, assistantText: '', toolCalls: [{ name: 'read', arguments: record.arguments }],
          results: [{ callId: record.callId, success: true, output: JSON.stringify({ success: true, files }) }] });
      }
      const scope = sourceReadsFromTurns(turns);
      const names = scope.map(read => read.path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).sort((a, b) => b.length - a.length);
      saved = { scope, calls, rows: new Map([...returned].map(([path, rows]) => [path, [...rows].sort(([a], [b]) => a - b)])),
        citations: new RegExp('(?<![\\w./-])(' + (names.join('|') || '(?!)') + ')(?::|#L)(\\d+)(?:[-–]L?(\\d+))?', 'g'),
        originals: sources.map(({ path, buffer }) => ({ path, buffer })), byteLength: sources.reduce((total, item) => total + item.bytes, 0),
        ...(liveStamp ? { liveStamp } : {}) };
      if (saved.byteLength <= cacheByteLimit) {
        let retainedBytes = [...cache.values()].reduce((total, entry) => total + entry.byteLength, 0);
        while (cache.size >= 8 || retainedBytes + saved.byteLength > cacheByteLimit) {
          const oldest = cache.entries().next().value;
          if (!oldest) break;
          retainedBytes -= oldest[1].byteLength; cache.delete(oldest[0]);
        }
        cache.set(key, saved);
      }
    }
    saved.citations.lastIndex = 0;
    const cited = new Map<string, [number, number][]>();
    for (const match of citationText.matchAll(saved.citations)) {
      const ranges = cited.get(match[1]!) ?? []; ranges.push([Number(match[2]), Number(match[3] ?? match[2])]); cited.set(match[1]!, ranges);
    }
    const reads = saved.scope.map(read => {
      const ranges = cited.get(read.path);
      if (!ranges) return read;
      const content = saved.rows.get(read.path)?.filter(([line]) => ranges.some(([start, end]) => line >= start && line <= end)).map(([, row]) => row).join('\n');
      return content ? { ...read, returnedContent: content, contentKind: 'cited-source' as const } : read;
    });
    // Nothing qualified: no evidence object, so briefs and prompts gain nothing.
    if (!reads.length) return none('no owner read matched the input tree', sessionId);
    return { kind: 'original-owner-read-observations', ownerSessionId: contract.sessionId,
      inputTree: contract.inputSnapshot.inputTree, callIds: [...new Set(saved.calls)],
      hostValidation: { operation: 'verify-recorded-owner-reads', source: 'native-host', success: true,
        ownerSessionId: contract.sessionId, inputTree: contract.inputSnapshot.inputTree,
        qualifiedFiles: reads.length, returnedLines: reads.reduce((total, read) => total + read.returnedLines, 0),
        meaning: 'Actual original-owner tool returns matched the immutable source line by line. This establishes returned scope and cited text, not semantic review quality, tests or native acceptance.' },
      sources: messages && !sources.length
        ? [{ operation: 'read-owner-session', success: true, path: `conversation:${contract.sessionId}`, bytes: 0 }]
        : sources.map(({ path, bytes }) => ({ operation: 'read-owner-session', success: true, path, bytes })),
      sourceReads: reads.map(read => ({ ...read, returnedRanges: [...read.returnedRanges] })),
      meaning: 'Actual recorded original-owner successful read results, qualified line by line against this immutable contract input. Only complete returned source lines with matching host offsets and original text count; requests, declared totals, searches and previews do not. Line labels may be normalized from host-bound plain returns. Quoted contents are limited to cited source ranges. These are earlier owner observations, not worker actions, executed tests, semantic review approval or acceptance of this answer.',
    };
  };
}
