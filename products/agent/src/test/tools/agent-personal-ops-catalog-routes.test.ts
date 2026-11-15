import { describe, expect, test } from 'bun:test';
import { WORK_PLAN_STATUSES } from '@goodvibes-jev/engine/platform/platform/workflow';
import type { Tool } from '@goodvibes-jev/engine/platform/platform/types';
import { reminderOperationRecords, taskOperationRecords } from '../../tools/agent-harness-personal-ops-operations.ts';
import { reminderWorkflows, taskWorkflows } from '../../tools/agent-harness-personal-ops-discovery.ts';
import { artifactShowRoute, mcpSchemaRoute, NOTE_CAPTURE_ROUTE } from '../../tools/agent-harness-personal-ops-routes.ts';
import { allWorkspaceActions } from '../../tools/agent-harness-workspace-actions.ts';
import { createAgentLocalRegistryTool } from '../../tools/agent-local-registry-tool.ts';
import { createAgentReminderScheduleTool } from '../../tools/agent-reminder-schedule-tool.ts';
import { createAgentScheduleTool } from '../../tools/agent-schedule-tool.ts';
import { createAgentWorkPlanTool } from '../../tools/agent-work-plan-tool.ts';

// The tools' definitions do not touch their dependencies, so inert stand-ins are enough to read the schemas.
const inert = {} as never;
const tools: Readonly<Record<string, Tool>> = {
  schedule: createAgentScheduleTool(inert, inert),
  agent_work_plan: createAgentWorkPlanTool(inert),
  agent_reminder_schedule: createAgentReminderScheduleTool(inert, inert, inert),
  agent_local_registry: createAgentLocalRegistryTool(inert, inert, inert),
};
const properties = (tool: Tool): readonly string[] => Object.keys((tool.definition.parameters as { properties: Record<string, unknown> }).properties);
const required = (tool: Tool): readonly string[] => (tool.definition.parameters as { required?: readonly string[] }).required ?? [];

const hostTaskMethods = ['tasks.list', 'tasks.get', 'tasks.status', 'tasks.cancel', 'tasks.retry'];
const scheduleMethods = ['automation.schedules.create', 'automation.schedules.list', 'automation.schedules.run', 'automation.schedules.disable',
  'automation.schedules.enable', 'automation.schedules.delete', 'automation.jobs.update'];
const records = [...taskOperationRecords(hostTaskMethods), ...reminderOperationRecords(scheduleMethods, true)];

describe('Personal Ops operation records name the fields their tools accept', () => {
  test('every route and field list for the schedule and work-plan tools uses the tool schema property names', () => {
    let checked = 0;
    for (const record of records) {
      const tool = tools[record.modelRoute.split(' ')[0]!];
      if (!tool || tool.definition.name === 'agent_reminder_schedule') continue;
      const accepted = new Set(properties(tool));
      const routeKeys = [...record.modelRoute.matchAll(/\b([A-Za-z]\w*):/g)].map((match) => match[1]!);
      for (const key of routeKeys) expect({ record: record.id, key, accepted: accepted.has(key) }).toEqual({ record: record.id, key, accepted: true });
      for (const field of [...(record.requiredFields ?? []), ...(record.optionalFields ?? [])]) {
        expect({ record: record.id, field, accepted: accepted.has(field) }).toEqual({ record: record.id, field, accepted: true });
      }
      checked += 1;
    }
    expect(checked).toBeGreaterThan(8);
  });

  test('the reminder record asks for exactly what the reminder tool requires', () => {
    const reminder = records.find((record) => record.id === 'reminder-create')!;
    for (const field of required(tools.agent_reminder_schedule!)) expect(reminder.requiredFields).toContain(field);
    for (const field of [...reminder.requiredFields!, ...reminder.optionalFields!]) expect(properties(tools.agent_reminder_schedule!)).toContain(field);
  });

  test('the work-plan status record lists the statuses the store accepts', () => {
    const status = records.find((record) => record.id === 'workplan-status')!;
    for (const value of WORK_PLAN_STATUSES) expect(status.summary).toContain(value);
  });

  test('a schedule edit is advertised only when the method the edit tool dispatches is available', () => {
    expect(reminderOperationRecords(['automation.schedules.list'], true).some((record) => record.id === 'schedule-edit')).toBe(false);
    expect(reminderOperationRecords(['automation.schedules.list', 'automation.jobs.update'], true).some((record) => record.id === 'schedule-edit')).toBe(true);
  });
});

describe('Personal Ops workspace and tool routes resolve', () => {
  test('every workspace action id a catalog tells the model to inspect exists', () => {
    const known = new Set(allWorkspaceActions().map((entry) => entry.action.id));
    const text = JSON.stringify([records, taskWorkflows(hostTaskMethods), reminderWorkflows(scheduleMethods, true)]);
    const ids = [...text.matchAll(/actionId:\\"([^\\"]+)\\"/g)].map((match) => match[1]!);
    expect(ids.length).toBeGreaterThan(3);
    for (const id of ids) expect({ id, known: known.has(id) }).toEqual({ id, known: true });
  });

  test('the note capture route uses a domain the local registry tool accepts', () => {
    const domain = /domain:"([^"]+)"/.exec(NOTE_CAPTURE_ROUTE)![1]!;
    const domainSchema = (tools.agent_local_registry!.definition.parameters as { properties: { domain: { enum: readonly string[] } } }).properties.domain;
    expect(domainSchema.enum).toContain(domain);
  });

  test('connector schema and artifact routes carry the mode discriminator', () => {
    expect(mcpSchemaRoute('mcp:srv:tool')).toBe('mcp mode:"schema" qualifiedName:"mcp:srv:tool"');
    expect(artifactShowRoute('a-1', true)).toBe('agent_artifacts mode:"show" artifactId:"a-1" includeContent:true');
    expect(artifactShowRoute('a-1')).toBe('agent_artifacts mode:"show" artifactId:"a-1"');
  });
});
