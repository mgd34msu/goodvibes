import { mkdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { Tool } from '../../types/tools.js';
import { resolveScopedDirectory } from '../../runtime/surface-root.js';
import { defineLifecycle } from '../../utils/lifecycle-machine.js';
import { writeFileAtomic } from '../../utils/atomic-json-store.js';
import { summarizeError } from '../../utils/error-display.js';
import { PACKET_TOOL_SCHEMA, type PacketToolInput } from './schema.js';

interface PacketRecord {
  readonly id: string;
  readonly title: string;
  readonly summary: string;
  readonly goals: readonly string[];
  readonly constraints: readonly string[];
  readonly risks: readonly string[];
  readonly audience?: string | undefined;
  readonly status: 'draft' | 'published';
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly publishedAt?: number | undefined;
}

/** A packet is drafted, then published once. Revising a published packet is allowed and does not change its status. */
const packetLifecycle = defineLifecycle<PacketRecord['status']>('packet', {
  draft: ['published'],
  published: [],
});

function summarizePacket(record: PacketRecord) {
  return {
    id: record.id,
    title: record.title,
    summary: record.summary,
    goalCount: record.goals.length,
    constraintCount: record.constraints.length,
    riskCount: record.risks.length,
    audience: record.audience,
    status: record.status,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    publishedAt: record.publishedAt,
  };
}

export function createPacketTool(
  options: string | { readonly workingDirectory: string; readonly surfaceRoot?: string },
): Tool {
  const workingDirectory = typeof options === 'string' ? options : options.workingDirectory;
  const surfaceRoot = typeof options === 'string' ? undefined : options.surfaceRoot;
  const workspaceRoot = resolve(workingDirectory);
  const packetsDir = resolveScopedDirectory(workspaceRoot, surfaceRoot);
  const packetsPath = join(packetsDir, 'packets.json');

  // Only a missing file is an empty store. An unreadable or malformed file must
  // fail the call: treating it as empty would let the next write replace every record.
  function loadPackets(): PacketRecord[] {
    let raw: string;
    try {
      raw = readFileSync(packetsPath, 'utf-8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw new Error(`Cannot read ${packetsPath}: ${summarizeError(err)}. Nothing was changed.`);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      throw new Error(`${packetsPath} is not valid JSON (${summarizeError(err)}). Nothing was changed; repair or move the file aside.`);
    }
    if (!Array.isArray(parsed)) throw new Error(`${packetsPath} does not hold a list of packets. Nothing was changed; repair or move the file aside.`);
    return parsed as PacketRecord[];
  }

  function savePackets(records: readonly PacketRecord[]): void {
    mkdirSync(packetsDir, { recursive: true });
    writeFileAtomic(packetsPath, `${JSON.stringify(records, null, 2)}\n`);
  }

  return {
    definition: {
      name: 'packet',
      description: 'Keep your own notes as implementation packets (draft, revise, publish). Packets are stored in a file for later reference; nothing consumes them or sends them to anyone.',
      parameters: PACKET_TOOL_SCHEMA.parameters,
      sideEffects: ['workflow', 'state'],
      concurrency: 'serial',
    },

    async execute(args: Record<string, unknown>) {
      if (!args || typeof args !== 'object' || typeof args.mode !== 'string') {
        return { success: false, error: 'Invalid args: mode is required.' };
      }
      const input = args as unknown as PacketToolInput;
      let records: PacketRecord[];
      try {
        records = loadPackets();
      } catch (err) {
        return { success: false, error: summarizeError(err) };
      }
      const view = input.view ?? 'summary';

      if (input.mode === 'create') {
        if (!input.packetId || !input.title || !input.summary) {
          return { success: false, error: 'create requires packetId, title, and summary.' };
        }
        const existing = records.find((entry) => entry.id === input.packetId);
        if (existing) {
          return {
            success: false,
            error: `Packet ${existing.id} already exists (status ${existing.status}); create would replace it. Use revise to change its content, show to read it, or choose a new packetId.`,
          };
        }
        const now = Date.now();
        const record: PacketRecord = {
          id: input.packetId,
          title: input.title,
          summary: input.summary,
          goals: [...(input.goals ?? [])],
          constraints: [...(input.constraints ?? [])],
          risks: [...(input.risks ?? [])],
          ...(input.audience ? { audience: input.audience } : {}),
          status: 'draft',
          createdAt: now,
          updatedAt: now,
        };
        savePackets([...records, record]);
        return { success: true, output: JSON.stringify(record) };
      }

      if (input.mode === 'list') {
        return {
          success: true,
          output: JSON.stringify({
            view,
            count: records.length,
            packets: view === 'full' ? records : records.map(summarizePacket),
          }),
        };
      }

      const record = records.find((entry) => entry.id === input.packetId);
      if (!record) return { success: false, error: `Unknown packet: ${input.packetId ?? '(missing)'}` };

      if (input.mode === 'show') {
        return { success: true, output: JSON.stringify(view === 'full' ? record : summarizePacket(record)) };
      }

      if (input.mode === 'revise') {
        const next: PacketRecord = {
          ...record,
          title: input.title ?? record.title,
          summary: input.summary ?? record.summary,
          goals: input.goals ? [...input.goals] : record.goals,
          constraints: input.constraints ? [...input.constraints] : record.constraints,
          risks: input.risks ? [...input.risks] : record.risks,
          audience: input.audience ?? record.audience,
          updatedAt: Date.now(),
        };
        savePackets(records.map((entry) => (entry.id === next.id ? next : entry)));
        return { success: true, output: JSON.stringify(next) };
      }

      if (input.mode === 'publish') {
        if (!packetLifecycle.can(record.status, 'published')) {
          return {
            success: false,
            error: `Packet ${record.id} is already published${record.publishedAt ? ` (at ${new Date(record.publishedAt).toISOString()})` : ''}; publishing again would re-stamp it. Use revise to change its content or show to read it.`,
          };
        }
        const next: PacketRecord = {
          ...record,
          status: 'published',
          publishedAt: Date.now(),
          updatedAt: Date.now(),
        };
        savePackets(records.map((entry) => (entry.id === next.id ? next : entry)));
        return { success: true, output: JSON.stringify(next) };
      }

      return { success: false, error: `Unknown mode: ${input.mode}` };
    },
  };
}
