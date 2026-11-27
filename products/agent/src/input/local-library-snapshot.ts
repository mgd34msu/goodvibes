import { AgentResearchRunRegistry, researchRunLogTail } from '@goodvibes/engine/terminal-shell/agent-turn/research-run-registry';
import { RoutineScheduleReceiptStore } from '@goodvibes/engine/terminal-shell/agent-turn/routine-schedules';
// The record summaries are the shared Agent turn's (local-library-items.ts); the curator reads the same ones.
export { summarizeMemoryItem, summarizeNoteItem, summarizePersonaItem, summarizeRoutineItem, summarizeSkillBundleItem, summarizeSkillItem } from '@goodvibes/engine/terminal-shell/agent-turn/local-library-items';
import type { listAgentRuntimeProfiles, listAgentRuntimeProfileTemplates } from '../agent/runtime-profile.ts';
import type { AgentResearchRunSummary, AgentRoutineScheduleReceiptSummary, AgentRuntimeProfileItem, AgentRuntimeStarterTemplateItem } from './runtime-snapshot-types.ts';

export function summarizeRoutineScheduleReceipt(
  receipt: ReturnType<RoutineScheduleReceiptStore['snapshot']>['receipts'][number],
): AgentRoutineScheduleReceiptSummary {
  return {
    id: receipt.id,
    status: receipt.status,
    routineId: receipt.routineId,
    routineName: receipt.routineName,
    scheduleName: receipt.scheduleName,
    scheduleKind: receipt.scheduleKind,
    scheduleValue: receipt.scheduleValue,
    createdAt: receipt.createdAt,
  };
}

export function summarizeResearchRunItem(
  run: ReturnType<AgentResearchRunRegistry['snapshot']>['runs'][number],
): AgentResearchRunSummary {
  return {
    id: run.id,
    title: run.title,
    status: run.status,
    phase: run.phase,
    progress: run.progress,
    sourceIds: run.sourceIds,
    nextSteps: run.nextSteps,
    checkpointCount: run.checkpoints.length,
    logTail: researchRunLogTail(run, 4),
    updatedAt: run.updatedAt,
    ...(run.note ? { note: run.note } : {}),
    ...(run.reportArtifactId ? { reportArtifactId: run.reportArtifactId } : {}),
  };
}

export function summarizeRuntimeProfile(profile: ReturnType<typeof listAgentRuntimeProfiles>[number]): AgentRuntimeProfileItem {
  return {
    id: profile.id,
    homeDirectory: profile.homeDirectory,
    createdAt: profile.createdAt,
    starterTemplateId: profile.starterTemplateId,
    starterTemplateName: profile.starterTemplateName,
  };
}

export function summarizeStarterTemplate(template: ReturnType<typeof listAgentRuntimeProfileTemplates>[number]): AgentRuntimeStarterTemplateItem {
  return {
    id: template.id,
    name: template.name,
    description: template.description,
    personaName: template.personaName,
    skillNames: template.skillNames,
    routineNames: template.routineNames,
    source: template.source,
  };
}
