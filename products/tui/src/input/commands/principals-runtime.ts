/**
 * principals-runtime.ts
 *
 * `/principals`, identity-mapping admin over `principals.*`: named
 * principals (people, bots, services, tokens) and the channel identities
 * ({channel, value} pairs, e.g. {channel:'slack', value:'U123'}) mapped to
 * them. Goes over the operator wire (see operator-rpc.ts) for the same
 * reason /ci and /checkin do: this verb family is not yet on the in-process
 * OperatorClient facade.
 *
 * `principals.resolve` is the honest lookup this command exists to make
 * reachable: an unmapped identity resolves to the shared "unknown" principal
 * with `known: false`, the registry never guesses, and this command never
 * papers over that with a name that looks real.
 */
import type { CommandRegistry } from '../command-registry.ts';
import { describeOperatorRpcError, getOperatorRpc } from './operator-rpc.ts';
import type { OperatorMethodOutput } from '@goodvibes-jev/engine/platform';
import { RefusalError, readRefusal, refusal } from '@goodvibes-jev/engine/errors';
import { commandRefusal } from '@goodvibes-jev/engine/terminal-shell/command-confirmation';

type Principal = OperatorMethodOutput<'principals.list'>['principals'][number];
type PrincipalKind = Principal['kind'];

const PRINCIPAL_KINDS: readonly PrincipalKind[] = ['user', 'bot', 'service', 'token'];

function isPrincipalKind(value: string | undefined): value is PrincipalKind {
  return PRINCIPAL_KINDS.includes(value as PrincipalKind);
}

/** Parse `channel:value` tokens (e.g. `slack:U123`) into identity pairs; malformed tokens are returned in `rejected`. */
function parseIdentities(tokens: readonly string[]): {
  identities: Array<{ channel: string; value: string }>;
  rejected: string[];
} {
  const identities: Array<{ channel: string; value: string }> = [];
  const rejected: string[] = [];
  for (const token of tokens) {
    const idx = token.indexOf(':');
    if (idx <= 0 || idx === token.length - 1) {
      rejected.push(token);
      continue;
    }
    identities.push({ channel: token.slice(0, idx), value: token.slice(idx + 1) });
  }
  return { identities, rejected };
}

function refuseMalformedIdentities(verb: string, rejected: readonly string[]): void {
  if (rejected.length === 0) return;
  throw commandRefusal(
    `/principals ${verb} refused: not a channel:value identity: ${rejected.join(', ')}. Nothing was changed.`,
    'Write identities as slack:U123 (comma separated for --identities)',
    'USAGE',
  );
}

/** A daemon failure as the command's refusal, keeping the daemon's own code, state and next steps. */
function rpcRefusal(verb: string, error: unknown): RefusalError {
  const own = readRefusal(error);
  return new RefusalError(refusal({
    code: own?.code ?? 'NOT_DONE',
    state: own?.state ?? 'not done',
    reason: `/principals ${verb} failed: ${describeOperatorRpcError(error)}`,
    next: own?.next ?? [],
  }), { cause: error });
}

/** Extract `--flag value` pairs from an args array, returning the remaining positional tokens. */
function extractFlags(args: readonly string[], flagNames: readonly string[]): { flags: Map<string, string>; positional: string[] } {
  const flags = new Map<string, string>();
  const positional: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    const name = arg.startsWith('--') ? arg.slice(2) : null;
    if (name && flagNames.includes(name)) {
      const value = args[i + 1];
      if (value !== undefined) {
        flags.set(name, value);
        i++;
        continue;
      }
    }
    positional.push(arg);
  }
  return { flags, positional };
}

export function renderPrincipal(principal: Principal): string {
  const lines = [
    `  ${principal.id}  ${principal.name}  [${principal.kind}]`,
  ];
  if (principal.identities.length > 0) {
    lines.push(`    identities: ${principal.identities.map((i) => `${i.channel}:${i.value}`).join(', ')}`);
  } else {
    lines.push('    identities: (none)');
  }
  return lines.join('\n');
}

export function registerPrincipalsRuntimeCommands(registry: CommandRegistry): void {
  registry.register({
    name: 'principals',
    description: 'Identity mappings: named principals and their channel identities',
    usage: '[list|get <id>|create <name> <kind> [channel:value...]|update <id> [--name x] [--kind x] [--identities c:v,c:v|none]|delete <id>|resolve <channel> <value>]',
    argsHint: '[list|get|create|update|delete|resolve]',
    subcommands: {
      list: '', get: '<id>', create: '<name> <kind> [channel:value...]',
      update: '<id> [--name x] [--kind x] [--identities c:v,c:v|none]', delete: '<id>', resolve: '<channel> <value>',
    },
    confirm(args) {
      if (args[0] !== 'delete' || !args[1]) return undefined;
      return {
        title: `Delete principal ${args[1]}?`,
        detail: `The principal ${args[1]} and every channel identity bound to it are removed permanently; messages from those identities are no longer attributed to anyone.`,
        confirmLabel: 'Delete',
      };
    },
    async handler(args, ctx) {
      const sub = args[0] ?? 'list';
      const knownSubcommands = ['list', 'get', 'create', 'update', 'delete', 'resolve'];
      if (!knownSubcommands.includes(sub)) {
        throw commandRefusal(
          'Usage: /principals <subcommand>\n'
          + '  /principals list                                          — list every principal\n'
          + '  /principals get <id>                                      — show one principal\n'
          + '  /principals create <name> <user|bot|service|token> [channel:value...]\n'
          + '  /principals update <id> [--name x] [--kind x] [--identities c:v,c:v|none]\n'
          + '  /principals delete <id>                                   — permanently remove a principal\n'
          + '  /principals resolve <channel> <value>                     — resolve a sender identity to its principal, or "unknown principal"'
        );
      }

      // Validate each subcommand's required positional arguments before
      // touching the operator connection, so a usage mistake never depends
      // on daemon reachability to be reported.
      if (sub === 'get' && !args[1]) throw commandRefusal('Usage: /principals get <id>');
      if (sub === 'create' && (!args[1] || !isPrincipalKind(args[2]))) {
        throw commandRefusal(`Usage: /principals create <name> <${PRINCIPAL_KINDS.join('|')}> [channel:value...]`);
      }
      if (sub === 'update' && !args[1]) throw commandRefusal('Usage: /principals update <id> [--name x] [--kind user|bot|service|token] [--identities c:v,c:v|none]');
      if (sub === 'delete' && !args[1]) throw commandRefusal('Usage: /principals delete <id>');
      if (sub === 'resolve' && (!args[1] || !args[2])) throw commandRefusal('Usage: /principals resolve <channel> <value>');

      // Identities are validated before the daemon is contacted: a typo must never
      // reach the store, and the refusal does not depend on the daemon being up.
      let createIdentities: Array<{ channel: string; value: string }> = [];
      let identitiesUpdate: Array<{ channel: string; value: string }> | undefined;
      if (sub === 'create') {
        const parsed = parseIdentities(args.slice(3));
        refuseMalformedIdentities('create', parsed.rejected);
        createIdentities = parsed.identities;
      }
      if (sub === 'update') {
        const { flags } = extractFlags(args.slice(2), ['name', 'kind', 'identities']);
        const identitiesRaw = flags.get('identities');
        // Clearing every identity mapping must be asked for: an empty value or the word "none".
        if (identitiesRaw !== undefined) {
          const clear = identitiesRaw.trim() === '' || identitiesRaw.trim().toLowerCase() === 'none';
          const parsed = clear ? { identities: [], rejected: [] } : parseIdentities(identitiesRaw.split(',').map((t) => t.trim()).filter((t) => t.length > 0));
          refuseMalformedIdentities('update', parsed.rejected);
          if (!clear && parsed.identities.length === 0) {
            throw commandRefusal('/principals update refused: --identities named no channel:value pair. Nothing was changed.', 'Use --identities none to clear every identity mapping', 'USAGE');
          }
          identitiesUpdate = parsed.identities;
        }
      }

      const rpc = getOperatorRpc(ctx);
      if (!rpc.available) throw commandRefusal(rpc.reason, undefined, 'DAEMON_UNAVAILABLE');

      if (sub === 'list') {
        try {
          const { principals } = await rpc.platformClient.operator.invoke('principals.list', {});
          if (principals.length === 0) {
            ctx.print('[principals] no principals registered.');
            return;
          }
          ctx.print(['Principals:', ...principals.map(renderPrincipal)].join('\n'));
        } catch (error) {
          throw rpcRefusal('list', error);
        }
        return;
      }

      if (sub === 'get') {
        const id = args[1]!;
        try {
          const { principal } = await rpc.platformClient.operator.invoke('principals.get', { principalId: id });
          ctx.print(renderPrincipal(principal));
        } catch (error) {
          throw rpcRefusal('get', error);
        }
        return;
      }

      if (sub === 'create') {
        const name = args[1]!;
        const kind = args[2] as PrincipalKind;
        const identities = createIdentities;
        try {
          const { principal } = await rpc.platformClient.operator.invoke('principals.create', { name, kind, identities });
          ctx.print(`[principals create] created ${principal.id}\n${renderPrincipal(principal)}`);
        } catch (error) {
          throw rpcRefusal('create', error);
        }
        return;
      }

      if (sub === 'update') {
        const id = args[1]!;
        const { flags } = extractFlags(args.slice(2), ['name', 'kind', 'identities']);
        const kind = flags.get('kind');
        if (kind !== undefined && !isPrincipalKind(kind)) {
          throw commandRefusal(`Invalid --kind "${kind}". Nothing was changed.`, `Valid values: ${PRINCIPAL_KINDS.join(', ')}`, 'USAGE');
        }
        try {
          const { principal } = await rpc.platformClient.operator.invoke('principals.update', {
            principalId: id,
            ...(flags.has('name') ? { name: flags.get('name')! } : {}),
            ...(kind !== undefined ? { kind } : {}),
            ...(identitiesUpdate !== undefined ? { identities: identitiesUpdate } : {}),
          });
          ctx.print(`[principals update] updated ${principal.id}\n${renderPrincipal(principal)}`);
        } catch (error) {
          throw rpcRefusal('update', error);
        }
        return;
      }

      if (sub === 'delete') {
        const id = args[1]!;
        let deleted: boolean;
        try {
          deleted = (await rpc.platformClient.operator.invoke('principals.delete', { principalId: id })).deleted;
        } catch (error) {
          throw rpcRefusal('delete', error);
        }
        if (!deleted) throw commandRefusal(`No principal found with id ${id}.`, '/principals list shows every principal', 'NOT_FOUND');
        ctx.print(`[principals delete] deleted ${id}.`);
        return;
      }

      if (sub === 'resolve') {
        const channel = args[1]!;
        const value = args[2]!;
        try {
          const result = await rpc.platformClient.operator.invoke('principals.resolve', { channel, value });
          if (!result.known) {
            ctx.print(`[principals resolve] unknown principal: ${channel}:${value} is not mapped to any registered principal.`);
            return;
          }
          ctx.print(`[principals resolve] ${channel}:${value} -> ${result.principal.name}\n${renderPrincipal(result.principal)}`);
        } catch (error) {
          throw rpcRefusal('resolve', error);
        }
      }
    },
  });
}
