import { GoodVibesError } from '@goodvibes-jev/engine/errors';
import { readTriggerOperatorStatus, TRIGGER_OPERATOR_MESSAGES, type TriggerOperatorFailureKind } from '@goodvibes-jev/engine/platform/platform/triggers/browser';
import { describeRetainedConnectionFailure, RetainedOperatorConnection } from './retained-operator-connection.js';
import { isOwnerOperatorPrincipal } from './native/native-paired-principal.js';
import type { PaymentWindowCommandContext, PaymentWindowCommandPolicy } from './payment-window-command.js';
import { stripDangerousAnsi } from './ansi-sanitize.js';
import type { TerminalSlashCommand } from './command-registry.js';
import { commandRefusal } from './command-confirmation.js';
const display = (value: unknown) => stripDangerousAnsi(String(value ?? '')).replace(/\x1b\[[0-9;]*m/g, '').replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, '');

const USAGE = 'Usage: /triggers [status] | list | history <id> [count] | create <definition JSON> | cancel <id> | reset <id> | grants | grant <id> <command> [args...]';
const READ_VERBS = ['status', 'list', 'history', 'grants'] as const;

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

/** One trigger as a line: label, id, kind, state, what it watches and how often it fired. */
function triggerLine(trigger: Record<string, unknown>): string {
  const parts = [`  ${display(trigger['label'])} (${display(trigger['id'])}) — ${display(trigger['kind'])} / ${display(trigger['state'])}`];
  if (trigger['watching'] !== undefined) parts.push(`watching ${display(trigger['watching'])}`);
  if (typeof trigger['firedCount'] === 'number') parts.push(`fired ${trigger['firedCount']}`);
  if (trigger['lastError'] !== undefined) parts.push(`last error: ${display(trigger['lastError'])}`);
  if (trigger['next'] !== undefined) parts.push(`next: ${display(trigger['next'])}`);
  return parts.join(' · ');
}

/** The daemon's own words for a refused operation, or the failure's message. */
function describeFailure(error: unknown): string {
  if (error instanceof GoodVibesError) {
    const body = record(error.body);
    const message = body['error'] ?? body['message'];
    if (typeof message === 'string' && message.length > 0) return display(message);
  }
  return display(error instanceof Error ? error.message : String(error));
}

/** Client terminals read and change the selected daemon's triggers through its
 * retained paired connection. Registering an action grant is the owner's own
 * act: it runs only when the owner typed the command. */
export function registerRemoteTriggerSupervisorCommand<Context extends PaymentWindowCommandContext>(
  registry: { register(command: TerminalSlashCommand<Context>): void },
  policy: PaymentWindowCommandPolicy<Context>,
): void {
  registry.register({ name: 'triggers', effect: 'mixed', readVerbs: [...READ_VERBS],
    description: 'List, inspect, create, cancel and reset the selected daemon’s supervised triggers; approve commands they may run',
    usage: '[status|list|history <id> [count]|create <json>|cancel <id>|reset <id>|grants|grant <id> <command> [args...]]',
    argsHint: 'status|list|history|create|cancel|reset|grants|grant',
    // A definition is the rest of the line exactly as typed.
    rawRest: (args) => (args[0] === 'create' && args.length === 1 ? 1 : undefined),
    async handler(args, context) {
      const verb = args[0] ?? 'status';
      const writes = !(READ_VERBS as readonly string[]).includes(verb);
      if (!['status', 'list', 'history', 'create', 'cancel', 'reset', 'grants', 'grant'].includes(verb)) throw commandRefusal(USAGE);
      if ((verb === 'status' || verb === 'list' || verb === 'grants') && args.length > 1) throw commandRefusal(USAGE);
      if ((verb === 'history' || verb === 'cancel' || verb === 'reset') && !args[1]) throw commandRefusal(`Usage: /triggers ${verb} <id>${verb === 'history' ? ' [count]' : ''}`);
      if (verb === 'create' && !args[1]?.trim()) throw commandRefusal('Usage: /triggers create <definition JSON>', 'Example: /triggers create {"id":"build","label":"Build finished","spec":{"kind":"on-exit","command":"npm","args":["run","build"]}}');
      if (verb === 'grant' && args.length < 3) throw commandRefusal('Usage: /triggers grant <id> <command> [args...]');
      // A grant is a command the owner approves; the model's command runner never registers one.
      if (verb === 'grant' && !policy.isOwner(context)) throw commandRefusal('Only the owner approves a command for triggers: type /triggers grant yourself.');
      let input: Record<string, unknown> = {};
      if (verb === 'history') {
        const count = args[2] === undefined ? undefined : Number(args[2]);
        if (count !== undefined && (!Number.isInteger(count) || count < 1)) throw commandRefusal('Usage: /triggers history <id> [count]', 'count is a positive whole number');
        input = { id: args[1], ...(count !== undefined ? { limit: count } : {}) };
      } else if (verb === 'cancel' || verb === 'reset') {
        input = { id: args[1] };
      } else if (verb === 'create') {
        let definition: unknown;
        try { definition = JSON.parse(args[1] ?? ''); } catch (error) { throw commandRefusal(`The definition is not JSON: ${display(error instanceof Error ? error.message : error)}`); }
        if (!definition || typeof definition !== 'object' || Array.isArray(definition)) throw commandRefusal('The definition is a JSON object: { id, label, spec, action? }.');
        input = { definition };
      } else if (verb === 'grant') {
        const [, id, command, ...commandArgs] = args;
        input = { id, command, args: commandArgs, description: `Runs ${[command, ...commandArgs].join(' ')}` };
      }
      const abort = new AbortController();
      let connection: RetainedOperatorConnection;
      try { connection = new RetainedOperatorConnection({ owner: () => policy.owner(context), home: () => policy.home(context),
        read: observation => policy.read(context, observation), files: policy.files,
        environment: policy.environment, fetchImpl: policy.fetchImpl, signal: abort.signal }); }
      catch (error) { context.print(`[triggers] ${describeRetainedConnectionFailure(error, `run /triggers ${verb} again`)}`); return; }
      const report = (message: string) => { context.print(message); context.renderRequest(); };
      const scope = writes ? 'write:watchers' : 'read:watchers';
      const invoke = (methodId: string, body: Record<string, unknown>) => connection.run(async (operator, signal) => operator.transport.requestJson(
        `/api/control-plane/methods/${methodId}/invoke`, { method: 'POST', body: { body }, signal, retry: false },
      ));
      try {
        const auth = await connection.run((operator, signal) => operator.control.auth.current({}, { signal }));
        if (!isOwnerOperatorPrincipal(auth, [scope], connection.expectedPrincipalId)) throw new Error(`Original administrative watcher principal required (${scope})`);
        if (verb === 'status') {
          const status = readTriggerOperatorStatus(await invoke('watchers.triggers.status', {}));
          report(`[triggers] ${status.message}`);
          for (const item of status.records) report(`  ${display(item.label)} (${display(item.id)}) — ${display(item.kind)} / ${display(item.state)}`);
          return;
        }
        if (verb === 'list') {
          const body = record(await invoke('watchers.triggers.list', {}));
          const triggers = Array.isArray(body['triggers']) ? body['triggers'].map(record) : [];
          report(triggers.length === 0 ? '[triggers] No triggers. Create one with /triggers create, or ask the agent to watch something.' : `[triggers] ${triggers.length} trigger${triggers.length === 1 ? '' : 's'}${body['ownership'] === 'other-process' ? ' (another process supervises them)' : ''}`);
          for (const trigger of triggers) report(triggerLine(trigger));
          return;
        }
        if (verb === 'history') {
          const body = record(await invoke('watchers.triggers.history', input));
          report(`[triggers] ${triggerLine(record(body['trigger'])).trim()}`);
          const runs = Array.isArray(body['runs']) ? body['runs'].map(record) : [];
          if (runs.length === 0) report('  No runs yet.');
          for (const run of runs) report(`  ${display(run['at'])} ${display(run['outcome'])}${run['detail'] !== undefined ? ` — ${display(run['detail'])}` : ''}`);
          return;
        }
        if (verb === 'grants') {
          const body = record(await invoke('watchers.triggers.grant.list', {}));
          const grants = Array.isArray(body['grants']) ? body['grants'].map(record) : [];
          report(grants.length === 0 ? '[triggers] No approved commands. Approve one with /triggers grant <id> <command> [args...].' : `[triggers] ${grants.length} approved command${grants.length === 1 ? '' : 's'}`);
          for (const grant of grants) {
            const argv = [grant['command'], ...(Array.isArray(grant['args']) ? grant['args'] : [])].map(display).join(' ');
            report(`  ${display(grant['id'])}: ${argv} (digest ${display(grant['digest'])}, approved by ${display(grant['confirmedBy'])})`);
          }
          return;
        }
        if (verb === 'grant') {
          const grant = record(record(await invoke('watchers.triggers.grant.register', input))['grant']);
          report(`[triggers] Approved ${display(grant['id'])}: a trigger may run it with {"kind":"action-grant","grantId":"${display(grant['id'])}","digest":"${display(grant['digest'])}"}.`);
          return;
        }
        const methodId = verb === 'create' ? 'watchers.triggers.create' : verb === 'cancel' ? 'watchers.triggers.cancel' : 'watchers.triggers.reset';
        const trigger = record(record(await invoke(methodId, input))['trigger']);
        report(`[triggers] ${verb === 'create' ? 'Created' : verb === 'cancel' ? 'Cancelled' : 'Reset'}:`);
        report(triggerLine(trigger));
      } catch (error) {
        if (verb === 'status') {
          let kind: TriggerOperatorFailureKind = 'unavailable';
          if (error instanceof GoodVibesError) {
            const body = error.body;
            const code = body && typeof body === 'object' && 'code' in body ? body.code : error.code;
            for (const candidate of ['other-process', 'future-version'] as const) {
              if (code === `TRIGGER_${candidate.toUpperCase().replaceAll('-', '_')}`) kind = candidate;
            }
          }
          report(`[triggers] ${TRIGGER_OPERATOR_MESSAGES[kind]}`);
          return;
        }
        throw commandRefusal(`/triggers ${verb} was not done: ${describeFailure(error)}`);
      } finally {
        abort.abort(); void connection.close();
      }
    } });
}
