/**
 * cluster-runtime.ts, `/cluster` in the TUI, described once (command-actions/).
 *
 * The same operations as the `goodvibes-daemon cluster` subcommands, reaching
 * the same daemon verbs through the same caller (`runClusterCommand`, whose
 * input is that command's argument list). There is no cluster logic in this
 * file and there must never be any: if `/cluster status` and `cluster status`
 * could disagree, one of them would be lying to somebody.
 *
 * Every action names which machine it acts on: this one unless another
 * daemon's address is given.
 */
import { resolveDaemonHomeDir } from '@goodvibes/engine/platform/platform/workspace/daemon-home';
import { runClusterCommand } from '@goodvibes/engine/terminal-shell/cluster-commands';
import { defineCommand, type ActionDescription, type ActionValues, type InputDescription } from '@goodvibes/engine/terminal-shell/command-actions';
import { textInput } from '@goodvibes/engine/terminal-shell/described-command-kit';
import { commandRefusal } from '@goodvibes/engine/terminal-shell/command-confirmation';
import type { CommandContext, CommandRegistry } from '../command-registry.ts';
import { requireShellPaths } from './runtime-services.ts';
import { createNetworkFetch } from '@goodvibes/engine/platform/platform/runtime/transport';

const MACHINE: InputDescription = textInput({
  id: 'machine', label: 'Which machine', help: 'The daemon to act on: this machine, or another one\'s address (https://host:port)',
  why: 'the address of a daemon on another machine', typed: { flag: '--host' }, optional: { default: '', means: 'this machine' },
});
const TOKEN: InputDescription = {
  id: 'token', label: 'Its access token', help: 'Only for another machine whose token is not stored here; hidden as you type', kind: 'secret',
  required: { default: '', defaultMeans: 'the token stored for it, if any' }, typed: { flag: '--token' },
};
const SETTING: InputDescription = textInput({
  id: 'setting', label: 'Shared setting', help: 'A shared setting\'s key, or user:<name> for an account', why: 'a shared setting\'s key or user:<name>', typed: { position: 1 },
});

/** The cluster command's own argument list for these values (its input; it is also the daemon's `cluster` command). */
function clusterArgv(subcommand: string, values: ActionValues, rest: readonly string[]): string[] {
  return [
    subcommand,
    ...rest,
    ...(values.machine ? ['--host', values.machine] : []),
    ...(values.token ? ['--token', values.token] : []),
    // The registry has already asked the owner for an irreversible line, so the shared caller is told it was confirmed.
    '--yes',
  ];
}

async function runCluster(ctx: CommandContext, argv: readonly string[]): Promise<string> {
  const result = await runClusterCommand({
    argv: [...argv],
    configManager: ctx.platform.configManager,
    daemonHomeDir: resolveDaemonHomeDir(),
    // Tokens stored for other daemons; this machine's token is never sent to one.
    homeDirectory: requireShellPaths(ctx).homeDirectory,
    // The configured outbound TLS trust, as the daemon's own cluster command uses.
    fetchImpl: createNetworkFetch(globalThis.fetch, ctx.platform.configManager),
    // A transcript is not a terminal for clipboard purposes: writing an OSC 52
    // escape into the rendered conversation would put a control sequence in
    // the scrollback rather than on anyone's clipboard.
    isTerminal: false,
  });
  if (result.exitCode !== 0) throw commandRefusal(result.lines.join('\n'));
  return result.lines.join('\n');
}

type ClusterAction = Omit<ActionDescription<CommandContext>, 'run' | 'inputs' | 'operator' | 'done'> & {
  readonly inputs?: readonly InputDescription[];
  readonly argv: (values: ActionValues) => readonly string[];
};

function clusterAction(fields: ClusterAction): ActionDescription<CommandContext> {
  const { argv, inputs, ...rest } = fields;
  return {
    ...rest,
    done: '',
    inputs: [...(inputs ?? []), MACHINE, TOKEN],
    operator: { terminalOnly: 'The web UI has its own Cluster page on each daemon.' },
    async run(values, ctx) { return runCluster(ctx, clusterArgv(fields.word, values, argv(values))); },
  };
}

const read = { touches: 'another-machine', lasts: 'not-a-change', risk: 'none' } as const;

export function registerClusterRuntimeCommands(registry: CommandRegistry): void {
  registry.register(defineCommand<CommandContext>({
    name: 'cluster',
    title: 'Cluster',
    summary: 'Share inbound channel work with your other goodvibes machines on this network',
    group: 'Devices',
    report: 'status',
    firstScreenRows: [
      'status',
      'groups',
      'join',
      'create',
      { label: 'Run the group', actions: ['nodes', 'key', 'rename', 'rotate', 'forget', 'leave'] },
      { label: 'Share settings across the group', actions: ['publish', 'accept'] },
    ],
    actions: [
      clusterAction({
        id: 'status', label: 'See this machine\'s group', word: 'status', ...read,
        sentence: 'Shows the group this machine is in, its members and its key\'s age.', example: {}, argv: () => [],
      }),
      clusterAction({
        id: 'groups', label: 'See the groups on this network', word: 'groups', ...read,
        sentence: 'Shows the groups other machines on this network announce.', example: {}, argv: () => [],
      }),
      clusterAction({
        id: 'create', label: 'Start a group on this network', word: 'create',
        inputs: [
          textInput({ id: 'name', label: 'Group name', help: 'A name the other machines will see', why: 'a name you choose', typed: { flag: '--name' }, optional: { default: '', means: 'this machine\'s name' } }),
          { id: 'passphrase', label: 'Passphrase', help: 'A phrase the join key is made from; hidden as you type', kind: 'secret', required: { default: '', defaultMeans: 'a random key' }, typed: { flag: '--passphrase' } },
        ],
        sentence: 'A new group is started on this machine, until you change it; other machines join it with its key.',
        touches: 'another-machine', lasts: 'kept', risk: 'none', undoneBy: 'leave', example: { name: 'the workshop' },
        argv: (values) => [...(values.name ? ['--name', values.name] : []), ...(values.passphrase ? ['--passphrase', values.passphrase] : [])],
      }),
      clusterAction({
        id: 'join', label: 'Join a group', word: 'join',
        inputs: [
          textInput({ id: 'group', label: 'Group', help: 'The group\'s id, as /cluster groups shows it', why: 'the id another machine announced', typed: { position: 1 } }),
          { id: 'key', label: 'Join key', help: 'The key /cluster key shows on a member; hidden as you type', kind: 'secret', required: true, typed: { flag: '--key' } },
        ],
        sentence: 'This machine joins {group} and shares inbound channel work with its members, until you change it.',
        touches: 'another-machine', lasts: 'kept', risk: 'sends-out', undoneBy: 'leave', example: { group: 'g-41a2', key: 'abc' },
        argv: (values) => ['--group', values.group!, '--key', values.key!],
      }),
      clusterAction({
        id: 'nodes', label: 'See the machines in the group', word: 'nodes', ...read,
        sentence: 'Shows each machine in the group, when it was last seen and what it serves.', example: {}, argv: () => [],
      }),
      clusterAction({
        id: 'key', label: 'See the key others join with', word: 'key', touches: 'credential', lasts: 'not-a-change', risk: 'none',
        inputs: [{ id: 'qr', label: 'Also as a QR code', help: 'Show the key as a QR code to scan', kind: 'yes-no', choices: [{ value: 'no', label: 'No' }, { value: 'yes', label: 'Yes' }], required: { default: 'no', defaultMeans: 'text only' }, typed: { flag: '--qr' } }],
        sentence: 'Shows the group\'s join key; anyone with it can join the group.', example: {},
        argv: (values) => values.qr === 'yes' ? ['--qr'] : [],
      }),
      clusterAction({
        id: 'rename', label: 'Rename the group', word: 'rename',
        inputs: [textInput({ id: 'name', label: 'New name', help: 'The name the machines will see', why: 'a name you choose', typed: { tail: true } })],
        sentence: 'The group is named "{name}" on every machine, until you change it.',
        touches: 'another-machine', lasts: 'kept', risk: 'none', example: { name: 'the workshop' },
        argv: (values) => [values.name!],
      }),
      clusterAction({
        id: 'rotate', label: 'Change the group\'s join key', word: 'rotate',
        inputs: [{ id: 'when', label: 'The old key', help: 'Whether the old key still works for a while', kind: 'choice', choices: [{ value: 'grace', label: 'Keeps working for a while' }, { value: 'now', label: 'Stops working now', help: 'A machine that has not picked up the new key is cut off.', risk: 'cannot-be-undone' }], required: { default: 'grace', defaultMeans: 'keeps working for a while' }, typed: { flag: '--now', switchOn: 'now' } }],
        sentence: 'The group gets a new join key, until you change it; machines pick it up on their own.',
        touches: 'another-machine', lasts: 'kept', risk: 'none', example: {},
        argv: (values) => values.when === 'now' ? ['--now'] : [],
      }),
      clusterAction({
        id: 'forget', label: 'Remove a machine from the group', word: 'forget',
        inputs: [textInput({ id: 'node', label: 'Machine', help: 'The machine\'s name, as /cluster nodes shows it', why: 'a machine name from /cluster nodes', typed: { position: 1 } })],
        sentence: '{node} is removed from the group and the group key is replaced at once.',
        touches: 'another-machine', lasts: 'kept', risk: 'cannot-be-undone', example: { node: 'garage-pi' },
        argv: (values) => [values.node!],
      }),
      clusterAction({
        id: 'leave', label: 'Leave the group', word: 'leave',
        sentence: 'This machine leaves its group; joining again needs the key.',
        touches: 'another-machine', lasts: 'kept', risk: 'cannot-be-undone', example: {}, argv: () => [],
      }),
      clusterAction({
        id: 'publish', label: 'Share a setting with the group', word: 'publish', inputs: [SETTING],
        sentence: '{setting} on every machine in the group is replaced with this machine\'s value (for user:<name>, this machine\'s account becomes the group\'s and the others end).',
        touches: 'another-machine', lasts: 'kept', risk: 'cannot-be-undone', example: { setting: 'provider.model' },
        argv: (values) => [values.setting!],
      }),
      clusterAction({
        id: 'accept', label: 'Take the group\'s value of a setting', word: 'accept', inputs: [SETTING],
        sentence: 'This machine\'s {setting} is replaced with the group\'s (for user:<name>, this machine\'s account of that name ends).',
        touches: 'another-machine', lasts: 'kept', risk: 'cannot-be-undone', example: { setting: 'provider.model' },
        argv: (values) => [values.setting!],
      }),
    ],
  }));
}
