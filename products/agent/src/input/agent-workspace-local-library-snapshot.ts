import { AgentResearchRunRegistry, researchRunLogTail } from '@goodvibes-jev/engine/terminal-shell/agent-turn/research-run-registry';
import { RoutineScheduleReceiptStore } from '../agent/routine-schedule-receipts.ts';
// The record summaries are the shared Agent turn's (local-library-items.ts); the curator reads the same ones.
export { summarizeMemoryItem, summarizeNoteItem, summarizePersonaItem, summarizeRoutineItem, summarizeSkillBundleItem, summarizeSkillItem } from '@goodvibes-jev/engine/terminal-shell/agent-turn/local-library-items';
import type { listAgentRuntimeProfiles, listAgentRuntimeProfileTemplates } from '../agent/runtime-profile.ts';
import type { AgentWorkspaceResearchRunSummary, AgentWorkspaceRoutineScheduleReceiptSummary, AgentWorkspaceRuntimeProfileItem, AgentWorkspaceRuntimeStarterTemplateItem } from './agent-workspace-types.ts';

export function summarizeRoutineScheduleReceipt(
  receipt: ReturnType<RoutineScheduleReceiptStore['snapshot']>['receipts'][number],
): AgentWorkspaceRoutineScheduleReceiptSummary {
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
): AgentWorkspaceResearchRunSummary {
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

export function summarizeRuntimeProfile(profile: ReturnType<typeof listAgentRuntimeProfiles>[number]): AgentWorkspaceRuntimeProfileItem {
  return {
    id: profile.id,
    homeDirectory: profile.homeDirectory,
    createdAt: profile.createdAt,
    starterTemplateId: profile.starterTemplateId,
    starterTemplateName: profile.starterTemplateName,
  };
}

export function summarizeStarterTemplate(template: ReturnType<typeof listAgentRuntimeProfileTemplates>[number]): AgentWorkspaceRuntimeStarterTemplateItem {
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
