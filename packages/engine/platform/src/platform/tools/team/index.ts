import { existsSync } from 'node:fs';
import type { Tool } from '../../types/tools.js';
import { resolveScopedDirectory } from '../../runtime/surface-root.js';
import { TEAM_TOOL_SCHEMA, type TeamToolInput } from './schema.js';
import { toRecord } from '../../utils/record-coerce.js';
import { readJsonFileOrQuarantine, writeJsonFileAtomic } from '../../utils/atomic-json-store.js';

interface TeamMember {
  readonly id: string;
  readonly role: string;
  readonly lanes: readonly string[];
}

interface TeamRecord {
  readonly id: string;
  readonly name: string;
  readonly summary: string;
  readonly members: readonly TeamMember[];
  readonly createdAt: number;
  readonly updatedAt: number;
}

interface TeamFile {
  readonly version: 1;
  readonly teams: readonly TeamRecord[];
}

function summarizeTeam(team: TeamRecord) {
  return {
    id: team.id,
    name: team.name,
    summary: team.summary,
    memberCount: team.members.length,
    lanes: Array.from(new Set(team.members.flatMap((member) => member.lanes))).sort(),
    createdAt: team.createdAt,
    updatedAt: team.updatedAt,
  };
}

function teamsPath(storageRoot: string, surfaceRoot?: string): string {
  return resolveScopedDirectory(storageRoot, surfaceRoot, 'teams.json');
}

/** The stored teams, plus a notice when an unreadable file had to be set aside. */
function loadTeams(storageRoot: string, surfaceRoot?: string): { readonly teams: TeamRecord[]; readonly notice?: string } {
  const path = teamsPath(storageRoot, surfaceRoot);
  const existed = existsSync(path);
  const parsed = readJsonFileOrQuarantine<TeamFile>(path, {
    label: 'team',
    validate: (value) => {
      const file = value as TeamFile | null;
      if (file?.version !== 1 || !Array.isArray(file.teams)) throw new Error('team store is malformed');
      return file;
    },
    recovery: 'The team tool starts with no teams; the unreadable file is kept beside the store for recovery.',
  });
  if (parsed) return { teams: [...parsed.teams] };
  return existed
    ? { teams: [], notice: `The team file ${path} was unreadable. It was kept beside the store as ${path}.corrupt-<time>, and the teams start empty; copy teams back from it if you need them.` }
    : { teams: [] };
}

function saveTeams(storageRoot: string, teams: readonly TeamRecord[], surfaceRoot?: string): void {
  // Written to a temp file and renamed, so a crash leaves the old file, never a torn one.
  writeJsonFileAtomic(teamsPath(storageRoot, surfaceRoot), { version: 1, teams });
}

export function createTeamTool(options?: { readonly surfaceRoot?: string; readonly workingDirectory?: string }): Tool {
  const surfaceRoot = options?.surfaceRoot;
  // The host's working directory is the store root. A model-supplied path is
  // never honoured: the schema has no such field, and an extra argument must
  // not pick where the file is written.
  const hostStorageRoot = options?.workingDirectory;
  return {
    definition: {
      name: 'team',
      description: 'Keep durable notes on a team: its members, their roles and the lanes you assign them. The record is stored for you and the user to read back; it does not change how agents are spawned or how they communicate (use the agent tool\'s communicationLane for that).',
      parameters: toRecord(TEAM_TOOL_SCHEMA),
      sideEffects: ['workflow', 'state'],
      concurrency: 'serial',
    },

    async execute(args: Record<string, unknown>) {
      if (!args || typeof args !== 'object' || typeof args.mode !== 'string') {
        return { success: false, error: 'Invalid args: mode is required.' };
      }
      const input = args as TeamToolInput;
      const storageRoot = hostStorageRoot;
      if (!storageRoot || storageRoot.trim().length === 0) {
        return { success: false, error: 'team is not set up in this session: the host gave it no working directory. Nothing was read or changed; do not retry.' };
      }
      const { teams, notice } = loadTeams(storageRoot, surfaceRoot);
      const reply = (payload: object) => ({ success: true, output: JSON.stringify(notice ? { ...payload, notice } : payload) });
      const view = input.view ?? 'summary';

      if (input.mode === 'create') {
        if (!input.teamId || !input.name || !input.summary) {
          return { success: false, error: 'create requires teamId, name, and summary.' };
        }
        if (teams.some((team) => team.id === input.teamId)) {
          return { success: false, error: `Team already exists: ${input.teamId}` };
        }
        const now = Date.now();
        const team: TeamRecord = {
          id: input.teamId,
          name: input.name,
          summary: input.summary,
          members: [],
          createdAt: now,
          updatedAt: now,
        };
        saveTeams(storageRoot, [...teams, team], surfaceRoot);
        return reply(team);
      }

      if (input.mode === 'list') {
        return reply({
          view,
          count: teams.length,
          teams: view === 'full' ? teams : teams.map(summarizeTeam),
        });
      }

      const index = teams.findIndex((team) => team.id === input.teamId);
      if (index < 0) {
        return { success: false, error: `Unknown team: ${input.teamId ?? '(missing)'}` };
      }
      const current = teams[index]!;

      if (input.mode === 'show') {
        return reply(view === 'full' ? current : {
          ...summarizeTeam(current),
          members: current.members.map((member) => ({
            id: member.id,
            role: member.role,
            lanes: member.lanes,
          })),
        });
      }

      if (input.mode === 'delete') {
        saveTeams(storageRoot, teams.filter((team) => team.id !== input.teamId), surfaceRoot);
        return reply({ removed: input.teamId });
      }

      const unknownMember = (): { success: false; error: string } => ({
        success: false,
        error: `Unknown member ${input.memberId} in team ${current.id}; known: ${current.members.map((member) => member.id).join(', ') || '(none)'}. Nothing was changed.`,
      });

      if (input.mode === 'add-member') {
        if (!input.memberId || !input.role) {
          return { success: false, error: 'add-member requires memberId and role.' };
        }
        const existing = current.members.find((member) => member.id === input.memberId);
        if (existing) {
          return { success: false, error: `Member ${input.memberId} already exists in team ${current.id} as ${existing.role}. Nothing was changed; use set-lanes to change its lanes, or remove-member first to replace it.` };
        }
        const next: TeamRecord = {
          ...current,
          members: [...current.members, { id: input.memberId, role: input.role, lanes: input.lanes ?? [] }],
          updatedAt: Date.now(),
        };
        teams[index] = next;
        saveTeams(storageRoot, teams, surfaceRoot);
        return reply(next);
      }

      if (input.mode === 'remove-member') {
        if (!input.memberId) return { success: false, error: 'remove-member requires memberId.' };
        if (!current.members.some((member) => member.id === input.memberId)) return unknownMember();
        const next: TeamRecord = {
          ...current,
          members: current.members.filter((member) => member.id !== input.memberId),
          updatedAt: Date.now(),
        };
        teams[index] = next;
        saveTeams(storageRoot, teams, surfaceRoot);
        return reply(next);
      }

      if (input.mode === 'set-lanes') {
        if (!input.memberId) return { success: false, error: 'set-lanes requires memberId.' };
        const lanes = input.lanes;
        if (!lanes) return { success: false, error: 'set-lanes requires lanes (an empty array clears them). Nothing was changed.' };
        if (!current.members.some((member) => member.id === input.memberId)) return unknownMember();
        const next: TeamRecord = {
          ...current,
          members: current.members.map((member) => (member.id === input.memberId ? { ...member, lanes } : member)),
          updatedAt: Date.now(),
        };
        teams[index] = next;
        saveTeams(storageRoot, teams, surfaceRoot);
        return reply(next);
      }

      return { success: false, error: `Unknown mode: ${input.mode}` };
    },
  };
}

export const teamTool = createTeamTool();
