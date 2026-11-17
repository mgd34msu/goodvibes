import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync, type BigIntStats } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { sourceReadsFromFolded, type SourceReadEvidence } from '../contract/evidence.js';
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

/** The journal was not replaced or written while it was read (a torn read, not a question of who wrote it). */
const sameFile = (before: BigIntStats, after: BigIntStats): boolean => after.dev === before.dev && after.ino === before.ino
  && after.size === before.size && after.mtimeNs === before.mtimeNs && after.ctimeNs === before.ctimeNs;

/**
 * A journal's identity without reading it. Both journals are replaced by
 * rename on every content change (a new inode), and the recovery writer only
 * moves the snapshot's file time when nothing changed, so device, inode and
 * size name one content.
 */
const fileIdentity = (info: BigIntStats): string => `${info.dev}:${info.ino}:${info.size}`;

/**
 * A stored read result's identity: its call id and a digest of its returned
 * text, so two results that share a call id and a length are never taken for
 * one another. Memoised per message object, so a live conversation's results
 * are hashed once, not on every re-scan.
 */
const resultDigests = new WeakMap<object, string>();
function resultIdentity(message: Record<string, unknown> & { callId: string; content: string }): string {
  let digest = resultDigests.get(message);
  if (digest === undefined) {
    digest = createHash('sha256').update(message.content).digest('base64url');
    resultDigests.set(message, digest);
  }
  return `${message.callId}\0${digest}`;
}

/** One read result qualified against an input tree: the file lines it returned that match the tree. */
type QualifiedRead = readonly { readonly path: string; readonly rows: readonly (readonly [number, string])[] }[];

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
 * the contract's immutable input. Session text cannot certify source or work.
 *
 * A read's qualification is a function of its call id, its returned text and
 * the input tree, none of which changes, so each read is qualified once per
 * owner session and tree and kept: one session's rows are never credited to
 * another whose results happen to share a call id. A journal on disk is re-read only when its identity changed;
 * a live conversation is re-scanned only when its length or last message did. */
export function createOwnerReadEvidenceReader(from: string | OwnerReadSource): OwnerEvidenceReader {
  const source: OwnerReadSource = typeof from === 'string' ? { surfaceDirectory: from } : from;
  // Derived results only; journal bytes are never kept. Eight sessions, eight (session, tree) pairs.
  const cache = new Map<string, { scope: SourceReadEvidence[]; calls: string[];
    rows: Map<string, [number, string][]>; citations: RegExp;
    sources: readonly { path: string; bytes: number }[];
    stamp: string | { readonly count: number; readonly last: unknown } }>();
  const qualifiedByTree = new Map<string, Map<string, QualifiedRead>>();
  const remember = <K, V>(map: Map<K, V>, key: K, value: V): void => {
    map.delete(key);
    map.set(key, value);
    while (map.size > 8) map.delete(map.keys().next().value as K);
  };
  return (contract, citationText) => {
    if (!contract.sessionId) return none('contract has no owner session');
    if (!contract.inputSnapshot || !/^[a-f0-9]{40,64}$/.test(contract.inputSnapshot.inputTree)) return none('contract has no input tree', contract.sessionId);
    const sessionId = contract.sessionId;
    const inputTree = contract.inputSnapshot.inputTree;
    const journals: { path: string; info: BigIntStats }[] = [];
    let messages: Record<string, unknown>[] | undefined;
    const live = source.liveMessages?.(contract.sessionId);
    if (live) {
      messages = live.filter(object);
    } else {
      const surfaceDirectory = source.surfaceDirectory;
      if (!surfaceDirectory) return none('session not loaded here and no surface directory', sessionId);
      const within = relative(contract.projectRoot, surfaceDirectory);
      if (isAbsolute(within) || within.split('/').includes('..') || !within.startsWith('.goodvibes/')) return none('surface directory is outside the project .goodvibes directory', sessionId);
      // What makes these journals the owner's is that only the runtime writes
      // under `.goodvibes/<surface>/`; a file-type check adds nothing to that
      // (whoever can plant a link there can plant a file). The recovery copy is
      // found through the recovery writer's own resolver, which takes a file as
      // this session's only when its header names the session.
      const sessionFile = join(surfaceDirectory, 'sessions', `${sanitizeSessionName(contract.sessionId)}.jsonl`);
      let recoveryFile: string | undefined;
      try { recoveryFile = recoveryFilePath(join(surfaceDirectory, 'recovery'), contract.sessionId); } catch { /* no recovery file for this id */ }
      for (const path of [sessionFile, ...(recoveryFile ? [recoveryFile] : [])]) {
        if (!existsSync(path)) continue;
        const info = statSync(path, { bigint: true });
        if (!info.isFile()) return none('session journal is not a file', sessionId);
        journals.push({ path, info });
      }
      // The recovery file is a copy of the same conversation written between
      // saves; once the session file is newer, the copy adds nothing.
      const [session, recovery] = journals.length === 2 ? journals : [undefined, undefined];
      if (session && recovery && session.info.mtimeNs >= recovery.info.mtimeNs) journals.pop();
      if (!journals.length) return none('no session journal on disk', sessionId);
    }
    // A live conversation is keyed by its length and last message; files by their identity.
    const stamp = messages ? { count: messages.length, last: messages[messages.length - 1] } : journals.map(({ info }) => fileIdentity(info)).join('|');
    const key = JSON.stringify([contract.projectRoot, inputTree,
      messages ? `conversation:${contract.sessionId}` : journals.map(item => item.path)]);
    let saved = cache.get(key);
    if (saved && (typeof stamp === 'string'
      ? saved.stamp !== stamp
      : typeof saved.stamp === 'string' || saved.stamp.count !== stamp.count || saved.stamp.last !== stamp.last)) {
      cache.delete(key); saved = undefined;
    }
    if (!saved) {
      const sources: { path: string; bytes: number }[] = [];
      if (!messages) {
        messages = [];
        for (const { path, info } of journals) {
          let bytes: Buffer | undefined;
          // A session save can land between the two stats; one more read then sees the saved file.
          for (let attempt = 0; attempt < 2 && bytes === undefined; attempt++) {
            const before = attempt === 0 ? info : statSync(path, { bigint: true });
            const read = readFileSync(path);
            if (sameFile(before, statSync(path, { bigint: true }))) bytes = read;
          }
          if (bytes === undefined) return none('session journal changed while it was read, twice', sessionId);
          sources.push({ path, bytes: bytes.length });
          for (const line of bytes.toString('utf8').split('\n')) {
            if (!line) continue;
            try { const parsed: unknown = JSON.parse(line); if (object(parsed)) messages.push(parsed); } catch { return none('a session journal line is not JSON', sessionId); }
          }
        }
      }
      const requests = new Map<string, Record<string, unknown>>();
      for (const message of messages) if (message['role'] === 'assistant' && Array.isArray(message['toolCalls'])) {
        for (const call of message['toolCalls']) if (object(call) && call['name'] === 'read' && typeof call['id'] === 'string') requests.set(call['id'], call);
      }
      const qualifiedKey = `${sessionId}\0${inputTree}`;
      const qualified = qualifiedByTree.get(qualifiedKey) ?? new Map<string, QualifiedRead>();
      remember(qualifiedByTree, qualifiedKey, qualified);
      const records: { callId: string; identity: string }[] = [];
      const pending: { callId: string; identity: string; files: { path: string; content: string; readObservation?: unknown }[] }[] = [];
      const seen = new Set<string>();
      for (const message of messages) {
        if (message['role'] !== 'tool' || typeof message['callId'] !== 'string' || typeof message['content'] !== 'string') continue;
        if (!requests.has(message['callId'])) continue;
        // A call id's returned text never changes; its digest tells a re-stored copy from a different result.
        const identity = resultIdentity(message as Record<string, unknown> & { callId: string; content: string });
        if (seen.has(identity)) continue;
        seen.add(identity);
        records.push({ callId: message['callId'], identity });
        if (qualified.has(identity)) continue;
        // The read's observations travel beside its text on the stored message; a result stored before that carries them in the text.
        const result = readBodyWithHostEvidence({ output: message['content'], hostEvidence: message['hostEvidence'] as ToolResult['hostEvidence'] });
        const files: { path: string; content: string; readObservation?: unknown }[] = [];
        if (result !== undefined && result['success'] === true && Array.isArray(result['files'])) {
          for (const file of result['files']) {
            if (!object(file) || typeof file['path'] !== 'string' || typeof file['content'] !== 'string' || file['error'] || file['binary']
              || (file['extract'] !== 'content' && file['extract'] !== 'lines')) continue;
            // One spelling per file: `./src/a.ts`, `src/a.ts` and the absolute path are the same entry.
            const path = relative(contract.projectRoot, resolve(contract.projectRoot, file.path));
            if (isAbsolute(path) || /[\r\n\0]/.test(path) || path.split('/').includes('..') || path.startsWith('.goodvibes/') || path.startsWith('.git/')) continue;
            if (typeof file.resolvedPath === 'string' && file.resolvedPath !== join(contract.projectRoot, path)) continue;
            files.push({ path, content: file.content, readObservation: file['readObservation'] });
          }
        }
        if (files.length) pending.push({ callId: message['callId'], identity, files });
        else qualified.set(identity, []);
      }
      // The input tree is read only for files a not-yet-qualified read returned.
      const originals = new Map<string, string[] | null>();
      const sourcePaths = [...new Set(pending.flatMap(record => record.files.map(file => file.path)))];
      for (let offset = 0; offset < sourcePaths.length; offset += 64) {
        const batch = sourcePaths.slice(offset, offset + 64);
        const blobs = spawnSync('git', ['-C', contract.projectRoot, 'cat-file', '--batch'], {
          input: batch.map(path => `${inputTree}:${path}\n`).join(''), maxBuffer: 32 * 1024 * 1024,
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
      for (const record of pending) {
        const reads: { path: string; rows: [number, string][] }[] = [];
        for (const file of record.files) {
          const original = originals.get(file.path);
          if (!original) continue;
          const rows: [number, string][] = [];
          for (const row of returnedReadRows(file)) {
            const match = /^[ \t]*(\d+) \| ?(.*)$/.exec(row);
            const line = Number(match?.[1]);
            if (match && Number.isSafeInteger(line) && line > 0 && original[line - 1] === match[2]) rows.push([line, row]);
          }
          if (rows.length) reads.push({ path: file.path, rows });
        }
        qualified.set(record.identity, reads);
      }
      const returned = new Map<string, Map<number, string>>();
      const calls: string[] = [];
      for (const record of records) {
        const reads = qualified.get(record.identity);
        if (!reads?.length) continue;
        calls.push(record.callId);
        for (const read of reads) {
          const numbered = returned.get(read.path) ?? new Map<number, string>();
          for (const [line, row] of read.rows) numbered.set(line, row);
          returned.set(read.path, numbered);
        }
      }
      const scope = sourceReadsFromFolded(returned);
      const names = scope.map(read => read.path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).sort((a, b) => b.length - a.length);
      saved = { scope, calls, rows: new Map([...returned].map(([path, rows]) => [path, [...rows].sort(([a], [b]) => a - b)])),
        citations: new RegExp('(?<![\\w./-])(' + (names.join('|') || '(?!)') + ')(?::|#L)(\\d+)(?:[-–]L?(\\d+))?', 'g'),
        sources, stamp };
      remember(cache, key, saved);
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
        meaning: 'Read results stored in the owner session (its live conversation, or its saved journal when the session is not loaded here) whose returned lines match the immutable source line by line. This establishes which source text the owner was shown and cites it; the match is checked against file content, not against a host record of the read, and it is not semantic review quality, tests or native acceptance.' },
      sources: !saved.sources.length
        ? [{ operation: 'read-owner-session', success: true, path: `conversation:${contract.sessionId}`, bytes: 0 }]
        : saved.sources.map(({ path, bytes }) => ({ operation: 'read-owner-session', success: true, path, bytes })),
      sourceReads: reads.map(read => ({ ...read, returnedRanges: [...read.returnedRanges] })),
      meaning: 'Successful read results stored in the owner session, qualified line by line against this immutable contract input. Only complete returned source lines with matching host offsets and original text count; requests, declared totals, searches and previews do not. Line labels may be normalized from host-bound plain returns. Quoted contents are limited to cited source ranges. These are earlier owner observations, not worker actions, executed tests, semantic review approval or acceptance of this answer.',
    };
  };
}
