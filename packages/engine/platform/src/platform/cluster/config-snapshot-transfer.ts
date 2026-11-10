/** Bounded, authenticated in-memory transfer of one complete config snapshot.
 * No part mutates a replica or advertises its revision as locally complete. */
import { opaqueUuid } from '@goodvibes-jev/judgment/decisions';
import { MAX_GROUP_MEMBERS } from './group-state.js';
import { MAX_ENVELOPE_BYTES, type ClusterEnvelope } from './protocol-envelope.js';

export const CONFIG_SNAPSHOT_PART = 'CONFIG_SNAPSHOT_PART';
// The authenticated envelope's finite native IDs/version/signature fit the
// reserved header. Parts use base64 so escaping cannot inflate arbitrary text.
export const CONFIG_BODY_LIMIT = MAX_ENVELOPE_BYTES - 1024;
const CHUNK_BYTES = 12 * 1024;
const MAX_BYTES = 32 * 1024 * 1024;
const MAX_PARTS = Math.ceil(MAX_BYTES / CHUNK_BYTES);
const MAX_SENDERS = MAX_GROUP_MEMBERS;
const TTL_MS = 30_000;
interface Part { id: string; revision: number; index: number; count: number; bytes: number; data: string }
interface Frame {
  readonly header: Omit<Part, 'data' | 'index'>;
  readonly groupId: string;
  readonly keyGen: number;
  readonly createdAt: number;
  readonly assertCurrent: () => void;
  readonly parts: Map<number, Buffer>;
  received: number;
  seq: number;
}
interface Retired { readonly id: string; readonly at: number }
const invalid = () => new Error('Cluster config snapshot transfer is unavailable');

export function prepareConfigSnapshotTransfer(document: unknown, revision: number): readonly Readonly<Part>[] {
  const bytes = Buffer.from(JSON.stringify(document), 'utf8');
  if (bytes.length === 0 || bytes.length > MAX_BYTES || !Number.isSafeInteger(revision) || revision < 0) throw invalid();
  const id = opaqueUuid(), count = Math.ceil(bytes.length / CHUNK_BYTES);
  const parts: Readonly<Part>[] = [];
  for (let index = 0; index < count; index++) parts.push(Object.freeze({ id, revision, index, count, bytes: bytes.length,
    data: bytes.subarray(index * CHUNK_BYTES, (index + 1) * CHUNK_BYTES).toString('base64') }));
  return parts;
}
function readPart(body: Readonly<Record<string, unknown>>): Part | null {
  const { id, revision, index, count, bytes, data } = body;
  if (Object.keys(body).length !== 6 || typeof id !== 'string' || !/^[a-p]{8}(?:-[a-p]{4}){3}-[a-p]{12}$/.test(id)
    || typeof revision !== 'number' || !Number.isSafeInteger(revision) || revision < 0
    || typeof index !== 'number' || !Number.isSafeInteger(index) || index < 0
    || typeof count !== 'number' || !Number.isSafeInteger(count) || count < 1 || count > MAX_PARTS || index >= count
    || typeof bytes !== 'number' || !Number.isSafeInteger(bytes) || bytes < 1 || bytes > MAX_BYTES || Math.ceil(bytes / CHUNK_BYTES) !== count
    || typeof data !== 'string' || data.length > 4 * Math.ceil(CHUNK_BYTES / 3)
    || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(data)) return null;
  return { id, revision, index, count, bytes, data };
}

/** One original frame per authenticated peer; 32MiB total, finite peers and
 * expiry. Lost/inconsistent parts leave the original replica revision intact,
 * allowing existing roster anti-entropy to request another complete snapshot. */
export class ConfigSnapshotTransfers {
  private readonly frames = new Map<string, Frame>();
  private readonly retired = new Map<string, Retired>();
  private buffered = 0;
  clear(): void { this.frames.clear(); this.retired.clear(); this.buffered = 0; }
  private drop(sender: string): void {
    const frame = this.frames.get(sender); if (!frame) return;
    this.buffered -= frame.received; this.frames.delete(sender);
  }
  expire(now: number): void {
    for (const [sender, frame] of this.frames) if (now - frame.createdAt >= TTL_MS || now < frame.createdAt) this.drop(sender);
    for (const [sender, retired] of this.retired) if (now - retired.at >= TTL_MS || now < retired.at) this.retired.delete(sender);
  }
  accept(envelope: ClusterEnvelope, now: number, assertCurrent: () => void): { readonly bytes: Buffer; readonly revision: number; readonly assertCurrent: () => void } | null {
    this.expire(now);
    const part = readPart(envelope.body); if (!part) return null;
    const sender = envelope.nodeId;
    if (this.retired.get(sender)?.id === part.id) return null;
    let frame = this.frames.get(sender);
    if (frame && frame.header.id !== part.id) {
      // A fresh resend may replace an incomplete frame. A late noninitial part
      // of the older transfer cannot evict the newer original selected frame.
      if (part.index !== 0 || part.revision < frame.header.revision || envelope.seq <= frame.seq) return null;
      this.drop(sender); frame = undefined;
    }
    if (!frame) {
      if (this.frames.size >= MAX_SENDERS || (!this.retired.has(sender) && this.retired.size >= MAX_SENDERS)) return null;
      assertCurrent();
      frame = { header: { id: part.id, revision: part.revision, bytes: part.bytes, count: part.count }, groupId: envelope.groupId, keyGen: envelope.keyGen, createdAt: now,
        assertCurrent, parts: new Map(), received: 0, seq: envelope.seq };
      this.frames.set(sender, frame);
    }
    const reject = (): null => {
      this.drop(sender); this.retired.set(sender, { id: part.id, at: now }); return null;
    };
    try { frame.assertCurrent(); assertCurrent(); } catch { return reject(); }
    if (frame.groupId !== envelope.groupId || frame.keyGen !== envelope.keyGen || frame.header.revision !== part.revision
      || frame.header.count !== part.count || frame.header.bytes !== part.bytes) return reject();
    const bytes = Buffer.from(part.data, 'base64');
    const expected = Math.min(CHUNK_BYTES, part.bytes - part.index * CHUNK_BYTES);
    if (bytes.length !== expected || bytes.toString('base64') !== part.data) return reject();
    const prior = frame.parts.get(part.index);
    if (prior) return prior.equals(bytes) ? null : reject();
    if (this.buffered + bytes.length > MAX_BYTES) return reject();
    frame.parts.set(part.index, bytes); frame.received += bytes.length; this.buffered += bytes.length;
    frame.seq = Math.max(frame.seq, envelope.seq);
    if (frame.parts.size !== part.count) return null;
    const complete = Buffer.concat(Array.from({ length: part.count }, (_, index) => frame!.parts.get(index)!));
    if (complete.length !== part.bytes) return reject();
    const original = frame.assertCurrent;
    this.drop(sender); this.retired.set(sender, { id: part.id, at: now });
    return { bytes: complete, revision: part.revision, assertCurrent: original };
  }
}
