import type { ToolDefinition } from '../../types/tools.js';

/**
 * JSON Schema for the workflow tool's input.
 * Starts contracts, and manages workflow state machines, hook actions and scheduled commands.
 */
export const workflowSchema: ToolDefinition = {
  name: 'workflow',
  description:
    'Automation control plumbing. To run work, use the agent tool instead. ' +
    'This tool manages: hook actions (a command run when a hook event fires), ' +
    'schedule (recurring background commands on intervals), ' +
    'and workflow state tracking (does not execute anything). ' +
    'Hook actions and schedules run in the project root with credential variables withheld and inside the exec sandbox when it is on; ' +
    'their command is judged as a shell command once, when added, exactly as an exec call is (a refusal says why), and list shows its boundary. ' +
    'and last until this process exits; list shows each one\'s last run, exit code and error. For routines that survive restarts make a schedule (the schedule.add capability). ' +
    'Modes: hook-actions (manage hook actions), schedule (manage recurring commands), ' +
    'start/status/transition/cancel/list (state tracking only, no execution), ' +
    'except start with definition=contract, which hands the task to a new contract whose units are checked against acceptance criteria while they work.',
  sideEffects: ['workflow', 'state'],
  concurrency: 'serial',
  parameters: {
    type: 'object',
    required: ['mode'],
    properties: {
      mode: {
        type: 'string',
        enum: ['start', 'status', 'transition', 'cancel', 'list', 'hook-actions', 'schedule'],
        description: 'Operation mode.',
      },
      // mode: start
      definition: {
        type: 'string',
        enum: ['contract', 'fix_loop', 'test_then_fix', 'review_only'],
        description: 'Workflow definition to instantiate (mode: start). contract starts a contract instead of a tracked state machine.',
      },
      task: {
        type: 'string',
        description: 'Task description for the workflow (mode: start).',
      },
      // mode: status / cancel
      workflowId: {
        type: 'string',
        description: 'Workflow instance ID (mode: status, transition, cancel).',
      },
      // mode: transition
      targetState: {
        type: 'string',
        description: 'State to transition to (mode: transition).',
      },
      // mode: hook-actions
      hookAction: {
        type: 'string',
        enum: ['list', 'add', 'remove', 'enable', 'disable'],
        description: 'Hook action management (mode: hook-actions).',
      },
      hookActionId: {
        type: 'string',
        description: 'Hook action ID for remove/enable/disable (mode: hook-actions).',
      },
      hookActionDefinition: {
        type: 'object',
        description: 'Hook action to add (mode: hook-actions, hookAction: add).',
        required: ['event', 'action'],
        properties: {
          event: {
            type: 'string',
            description: 'Hook event pattern to match (e.g. Pre:tool:*, Post:file:write).',
          },
          condition: {
            type: 'string',
            description: "Optional condition over event.* and payload.* paths with ===, !==, ==, !=, >, <, >=, <=, &&, ||, ! and parentheses, e.g. payload.tool === 'exec'. One that cannot be parsed is refused when added.",
          },
          action: {
            type: 'string',
            description: 'Command to run when the event fires, split into words with no shell (POSIX quoting and backslash escapes). Killed after 60 s.',
          },
        },
      },
      // mode: schedule
      scheduleAction: {
        type: 'string',
        enum: ['list', 'add', 'remove', 'enable', 'disable'],
        description: 'Schedule management action (mode: schedule). disable stops the timer and keeps the schedule; enable starts it again.',
      },
      scheduleName: {
        type: 'string',
        description: 'Unique name for the schedule entry.',
      },
      scheduleInterval: {
        type: 'string',
        description: "Repeat interval: a number followed by s, m, h or d, from 1s up to 24d, e.g. '5m', '1h', '30s' (mode: schedule, action: add).",
      },
      scheduleCommand: {
        type: 'string',
        description: 'Command to run on each interval tick, split into words with no shell (POSIX quoting and backslash escapes) (mode: schedule, action: add). A tick is skipped (and counted) while the previous run is still going; a run longer than its interval (at least 60 s) is killed.',
      },
    },
  },
};
