/**
 * `/principals`, described once (command-actions/) for both terminal apps:
 * the daemon's registry of who is who across channels (one person or bot with
 * its identities on each channel), over the `principals.*` methods. Each app
 * says how it reaches the daemon.
 */
import type { OperatorMethodInput, OperatorMethodOutput } from '@goodvibes-jev/engine/platform/contracts';
import { commandRefusal } from './command-confirmation.js';
import type { TerminalCommandRegistry } from './command-registry.js';
import { defineCommand } from './command-actions/define.js';
import { defineList, type ListRow } from './command-actions/lists.js';
import type { CommandActionContext, FixedChoice, InputDescription } from './command-actions/types.js';
import { listInput, readAction, textInput } from './described-command-kit.js';

type PrincipalsMethod = 'principals.list' | 'principals.get' | 'principals.create' | 'principals.update' | 'principals.delete' | 'principals.resolve';
export type PrincipalsInvoke<Ctx> = <M extends PrincipalsMethod>(ctx: Ctx, method: M, input: OperatorMethodInput<M>) => Promise<OperatorMethodOutput<M>>;
type Principal = OperatorMethodOutput<'principals.list'>['principals'][number];
type PrincipalKind = Principal['kind'];

export function renderPrincipal(principal: Principal): string {
  return [
    `  ${principal.id}  ${principal.name}  [${principal.kind}]`,
    `    identities: ${principal.identities.length > 0 ? principal.identities.map((i) => `${i.channel}:${i.value}`).join(', ') : '(none)'}`,
  ].join('\n');
}

/** `slack:U123, telegram:42` as identity pairs; a malformed one is refused, nothing changed. */
function identitiesOf(text: string): { channel: string; value: string }[] {
  const tokens = text.split(/[,\n]/).map((token) => token.trim()).filter(Boolean);
  const rejected = tokens.filter((token) => { const at = token.indexOf(':'); return at <= 0 || at === token.length - 1; });
  if (rejected.length > 0) throw commandRefusal(`Not a channel:value identity: ${rejected.join(', ')}. Nothing was changed.`, 'Write identities as slack:U123, separated by commas.');
  return tokens.map((token) => ({ channel: token.slice(0, token.indexOf(':')), value: token.slice(token.indexOf(':') + 1) }));
}

const KINDS: readonly FixedChoice[] = [
  { value: 'user', label: 'A person' }, { value: 'bot', label: 'A bot' }, { value: 'service', label: 'A service' }, { value: 'token', label: 'A token' },
];

let invokeOf: PrincipalsInvoke<unknown> | undefined;
const PRINCIPALS = defineList<unknown>({
  name: 'principals',
  async read(ctx) {
    if (!invokeOf) return [];
    return (await invokeOf(ctx, 'principals.list', {})).principals.map((principal): ListRow => ({
      value: principal.id, label: principal.name, state: principal.kind,
      detail: principal.identities.map((i) => `${i.channel}:${i.value}`).join(', ') || 'no identities',
    }));
  },
  operator: { method: 'principals.list', input: {}, rows: { from: 'principals', value: 'id', label: 'name', state: 'kind' } },
});
const PRINCIPAL: InputDescription = listInput({ id: 'principal', label: 'Who', help: 'The people, bots and services the daemon knows', list: PRINCIPALS });

export function registerPrincipalsCommand<Ctx extends CommandActionContext>(registry: Pick<TerminalCommandRegistry<Ctx>, 'register'>, invoke: PrincipalsInvoke<Ctx>): void {
  invokeOf = invoke as PrincipalsInvoke<unknown>;
  registry.register(defineCommand<Ctx>({
    name: 'principals',
    title: 'Who is who',
    summary: 'The people, bots and services the daemon knows, and their identity on each channel',
    group: 'Channels',
    report: 'list',
    actions: [
      readAction<Ctx>({
        id: 'list', label: 'See who the daemon knows', word: 'list',
        sentence: 'Lists every person, bot and service with their identities on each channel.',
        operator: { method: 'principals.list', fields: {} },
        async run(_values, ctx) {
          const { principals } = await invoke(ctx, 'principals.list', {});
          return principals.length === 0 ? 'No principals registered. Add one with /principals create.' : ['Principals:', ...principals.map(renderPrincipal)].join('\n');
        },
      }),
      readAction<Ctx>({
        id: 'get', label: 'See one person, bot or service', word: 'get', inputs: [PRINCIPAL],
        sentence: 'Shows {principal}\'s kind and identities.', example: { principal: 'p-sam' },
        operator: { method: 'principals.get', fields: { principalId: 'principal' } },
        async run(values, ctx) { return renderPrincipal((await invoke(ctx, 'principals.get', { principalId: values.principal! })).principal); },
      }),
      readAction<Ctx>({
        id: 'resolve', label: 'Find who a channel identity belongs to', word: 'resolve',
        inputs: [
          textInput({ id: 'channel', label: 'Channel', help: 'The channel kind: slack, telegram, discord, email...', why: 'a channel kind', typed: { position: 1 } }),
          textInput({ id: 'value', label: 'Identity', help: 'Their id or address on that channel', why: 'an id on that channel', typed: { position: 2 } }),
        ],
        sentence: 'Shows who {channel}:{value} is, if the daemon knows.', example: { channel: 'slack', value: 'U123' },
        operator: { method: 'principals.resolve', fields: { channel: 'channel', value: 'value' } },
        async run(values, ctx) {
          const result = await invoke(ctx, 'principals.resolve', { channel: values.channel!, value: values.value! });
          if (!result.known) return `${values.channel}:${values.value} is not mapped to anyone the daemon knows.`;
          return `${values.channel}:${values.value} is ${result.principal.name}\n${renderPrincipal(result.principal)}`;
        },
      }),
      {
        id: 'create', label: 'Add a person, bot or service', word: 'create',
        inputs: [
          textInput({ id: 'name', label: 'Name', help: 'Their name', why: 'a name you choose', typed: { position: 1 } }),
          { id: 'kind', label: 'Kind', help: 'What they are', kind: 'choice', choices: KINDS, required: true, typed: { position: 2 } },
          textInput({ id: 'identities', label: 'Identities', help: 'channel:value pairs, separated by commas (slack:U123)', why: 'channel:value pairs', typed: { flag: '--identity', repeats: true }, optional: { default: '', means: 'none yet' } }),
        ],
        sentence: '{name} ({kind}) is added to the daemon\'s registry, until you change it.', done: '',
        touches: 'another-machine', lasts: 'kept', risk: 'none', undoneBy: 'delete',
        operator: { method: 'principals.create', fields: { name: 'name', kind: 'kind' } }, example: { name: 'Sam', kind: 'user', identities: 'slack:U123' },
        async run(values, ctx) {
          const { principal } = await invoke(ctx, 'principals.create', { name: values.name!, kind: values.kind as PrincipalKind, identities: identitiesOf(values.identities ?? '') });
          return `Added ${principal.id}\n${renderPrincipal(principal)}`;
        },
      },
      {
        id: 'update', label: 'Change a person, bot or service', word: 'update',
        inputs: [
          PRINCIPAL,
          textInput({ id: 'name', label: 'Name', help: 'A new name', why: 'a name you choose', typed: { flag: '--name' }, optional: { default: '', means: 'unchanged' } }),
          { id: 'kind', label: 'Kind', help: 'What they are', kind: 'choice', choices: KINDS, required: { default: '', defaultMeans: 'unchanged' }, typed: { flag: '--kind' } },
          textInput({ id: 'identities', label: 'Identities', help: 'All their channel:value pairs, separated by commas; none clears them', why: 'channel:value pairs, or none', typed: { flag: '--identities' }, optional: { default: '', means: 'unchanged' } }),
        ],
        sentence: '{principal} is changed to what you gave, until you change it.', done: '',
        touches: 'another-machine', lasts: 'kept', risk: 'none',
        operator: { method: 'principals.update', fields: { principalId: 'principal', name: 'name', kind: 'kind' } }, example: { principal: 'p-sam', name: 'Sam Lee' },
        async run(values, ctx) {
          const raw = values.identities?.trim();
          // Clearing every identity mapping must be asked for with the word none.
          const identities = raw === undefined || raw === '' ? undefined : raw.toLowerCase() === 'none' ? [] : identitiesOf(raw);
          const { principal } = await invoke(ctx, 'principals.update', {
            principalId: values.principal!,
            ...(values.name ? { name: values.name } : {}),
            ...(values.kind ? { kind: values.kind as PrincipalKind } : {}),
            ...(identities !== undefined ? { identities } : {}),
          });
          return `Changed ${principal.id}\n${renderPrincipal(principal)}`;
        },
      },
      {
        id: 'delete', label: 'Remove a person, bot or service', word: 'delete', inputs: [PRINCIPAL],
        sentence: '{principal} and its identities are removed from the daemon\'s registry.', done: '',
        touches: 'another-machine', lasts: 'kept', risk: 'cannot-be-undone',
        operator: { method: 'principals.delete', fields: { principalId: 'principal' } }, example: { principal: 'p-sam' },
        async run(values, ctx) {
          if (!(await invoke(ctx, 'principals.delete', { principalId: values.principal! })).deleted) throw commandRefusal(`No principal has the id ${values.principal}.`, '/principals list shows every principal');
          return `Removed ${values.principal}.`;
        },
      },
    ],
  }));
}
