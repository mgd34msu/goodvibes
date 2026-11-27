/**
 * local-library-items.ts, the one summary of an Agent-local record (memory, a
 * note, a persona, a skill, a skill bundle, a routine) that the Agent's
 * model tools list and the learning curator reads, wherever the turn runs.
 */
import { memoryRecordTemporalStatus, type MemoryRecord } from '@goodvibes/engine/platform/platform/state';
import type { AgentNoteRecord } from './note-registry.js';
import type { AgentPersonaRecord } from './persona-registry.js';
import { formatAgentRecordOrigin } from './record-labels.js';
import { evaluateAgentRoutineReadiness, type AgentRoutineRecord } from './routine-registry.js';
import { evaluateAgentSkillBundleReadiness, evaluateAgentSkillReadiness, formatAgentSkillRequirement, type AgentSkillBundleRecord, type AgentSkillRecord } from './skill-registry.js';

export interface AgentLocalLibraryItem {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly reviewState: string;
  readonly source: string;
  readonly tags: readonly string[];
  readonly triggers: readonly string[];
  readonly scope?: string | undefined;
  readonly cls?: string | undefined;
  readonly confidence?: number | undefined;
  readonly active?: boolean | undefined;
  readonly enabled?: boolean | undefined;
  readonly requirementCount?: number | undefined;
  readonly missingRequirementCount?: number | undefined;
  readonly missingRequirements?: readonly string[] | undefined;
  readonly startCount?: number | undefined;
  /** Memory-only: whether this record currently clears the prompt-injection recall floor, per describeMemoryPromptEligibility. */
  readonly promptEligible?: boolean | undefined;
  /** Memory-only: the honest, per-record reason from describeMemoryPromptEligibility, the same wording source prompt-context-receipts.ts and agent-harness-prompt-context.ts use. */
  readonly promptEligibilityReason?: string | undefined;
  readonly temporalStatus?: 'active' | 'pending' | 'expired' | undefined; // memoryRecordTemporalStatus; pending/expired stay stored, just not prompt-injected
}

export function summarizePersonaItem(persona: AgentPersonaRecord, activePersonaId: string | null): AgentLocalLibraryItem {
  return {
    id: persona.id,
    name: persona.name,
    description: persona.description,
    reviewState: persona.reviewState,
    source: formatAgentRecordOrigin(persona.source, persona.provenance),
    tags: persona.tags,
    triggers: persona.triggers,
    active: persona.id === activePersonaId,
  };
}

export function summarizeSkillItem(skill: AgentSkillRecord): AgentLocalLibraryItem {
  const readiness = evaluateAgentSkillReadiness(skill);
  return {
    id: skill.id,
    name: skill.name,
    description: skill.description,
    reviewState: skill.reviewState,
    source: formatAgentRecordOrigin(skill.source, skill.provenance),
    tags: skill.tags,
    triggers: skill.triggers,
    enabled: skill.enabled,
    requirementCount: skill.requirements.length,
    missingRequirementCount: readiness.missing.length,
    missingRequirements: readiness.missing.map(formatAgentSkillRequirement),
  };
}

export function summarizeSkillBundleItem(bundle: AgentSkillBundleRecord, skills: readonly AgentSkillRecord[]): AgentLocalLibraryItem {
  const readiness = evaluateAgentSkillBundleReadiness(bundle, skills);
  const missing = [
    ...readiness.missingRequirements.map(formatAgentSkillRequirement),
    ...readiness.missingSkillIds.map((skillId) => `skill:${skillId}`),
  ];
  return {
    id: bundle.id,
    name: bundle.name,
    description: `${bundle.description} Skills: ${bundle.skillIds.join(', ')}`,
    reviewState: bundle.reviewState,
    source: formatAgentRecordOrigin(bundle.source, bundle.provenance),
    tags: bundle.skillIds,
    triggers: [],
    enabled: bundle.enabled,
    requirementCount: readiness.includedSkills.reduce((total, skill) => total + skill.requirements.length, 0) + readiness.missingSkillIds.length,
    missingRequirementCount: missing.length,
    missingRequirements: missing,
  };
}

export function summarizeRoutineItem(routine: AgentRoutineRecord): AgentLocalLibraryItem {
  const readiness = evaluateAgentRoutineReadiness(routine);
  return {
    id: routine.id,
    name: routine.name,
    description: routine.description,
    reviewState: routine.reviewState,
    source: formatAgentRecordOrigin(routine.source, routine.provenance),
    tags: routine.tags,
    triggers: routine.triggers,
    enabled: routine.enabled,
    requirementCount: routine.requirements.length,
    missingRequirementCount: readiness.missing.length,
    missingRequirements: readiness.missing.map(formatAgentSkillRequirement),
    startCount: routine.startCount,
  };
}

export function summarizeMemoryItem(record: MemoryRecord): AgentLocalLibraryItem {
  const detail = record.detail?.trim();
  return {
    id: record.id,
    name: record.summary,
    description: detail && detail.length > 0 ? detail : `${record.scope}/${record.cls}`,
    reviewState: record.reviewState,
    source: 'Agent memory',
    tags: record.tags,
    triggers: [],
    scope: record.scope,
    cls: record.cls,
    confidence: record.confidence,
    // Visible expiry: a record outside its [validFrom, validUntil) window is
    // still stored (not deleted) but not prompt-injected, see
    // memoryRecordTemporalStatus / describeMemoryPromptEligibility.
    temporalStatus: memoryRecordTemporalStatus(record),
  };
}

export function summarizeNoteItem(note: AgentNoteRecord): AgentLocalLibraryItem {
  const preview = note.body.replace(/\s+/g, ' ').trim();
  const description = note.sourceUrl
    ? `${preview.slice(0, 160)}${preview.length > 160 ? '...' : ''} Origin URL ${note.sourceUrl}`
    : preview;
  return {
    id: note.id,
    name: note.title,
    description,
    reviewState: note.reviewState,
    source: formatAgentRecordOrigin(note.source, note.provenance),
    tags: note.tags,
    triggers: [],
  };
}
