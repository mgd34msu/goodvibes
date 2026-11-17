import { join } from 'node:path';
import { existsSync, mkdirSync, readdirSync } from 'node:fs';
import { unlink, writeFile } from 'node:fs/promises';
import { fetchModelContextWindows } from '@goodvibes-jev/engine/platform/platform/discovery';
import type { CustomProviderConfig, ProviderApi } from '@goodvibes-jev/engine/platform/platform/providers';
import type { SecretsManager } from '@goodvibes-jev/engine/platform/platform/config';
import type { ShellPathService } from '@goodvibes-jev/engine/platform/platform/runtime/shell';
import { formatProviderModel } from '@goodvibes-jev/engine/platform/platform/providers';
import { summarizeError } from '@goodvibes-jev/engine/platform/platform/utils';
import type { TerminalCommandRegistry } from './command-registry.js';
import type { ConcealedInputRequest } from './concealed-input.js';
import { commandRefusal, requireYesFlag, stripYesFlag } from './command-confirmation.js';
import { readRefusal } from '@goodvibes-jev/engine/errors';

export interface LocalProviderCommandContext {
  readonly print: (message: string) => void;
  readonly beginConcealedInput?: ((request: ConcealedInputRequest) => void) | undefined;
  readonly openProviderPicker?: (() => void) | undefined;
  readonly session: { readonly runtime: { model: string; provider: string } };
  readonly platform: { readonly configManager: { set(key: 'provider.model', model: string): unknown } };
}
export function customProviderKeyName(providerName: string): string {
  return `${providerName.replace(/[^A-Za-z0-9]/g, '_').toUpperCase()}_API_KEY`;
}
function validProviderName(name: string): boolean {
  return /^[a-zA-Z0-9_-]+$/.test(name);
}
function discoveredModelIds(body: unknown): string[] {
  if (!body || typeof body !== 'object' || !('data' in body) || !Array.isArray(body.data)) return [];
  return body.data
    .filter((value): value is { readonly id: unknown } => value !== null && typeof value === 'object' && 'id' in value)
    .map((value) => String(value.id))
    .filter(Boolean);
}
/** Custom provider names are owner-defined, so their credentials explicitly belong to the daemon tier. */
async function storeProviderKey(manager: Pick<SecretsManager, 'set'>, name: string, value: string): Promise<void> {
  await manager.set(customProviderKeyName(name), value, { scope: 'daemon', medium: 'secure' });
}
export function createLocalProviderCommands<Context extends LocalProviderCommandContext>(
  services: {
    readonly requireProviderApi: (context: Context) => ProviderApi;
    readonly requireShellPaths: (context: Context) => ShellPathService;
    readonly requireSecretsManager: (context: Context) => Pick<SecretsManager, 'set' | 'delete'>;
  },
  policy: {
    readonly surfaceRoot: string;
    readonly hidden: boolean;
    readonly confirmMutations: boolean;
    readonly allowInlineKey: boolean;
    readonly captureMissingKey: boolean;
    readonly explicitModelSelection: boolean;
    readonly codeEditing: boolean;
    readonly beforeSelection: (context: Context, provider: string, complete: () => void) => void;
  },
) {
  /**
   * Asks for the key before the endpoint is probed, so a key-protected endpoint
   * answers with its models instead of a refusal. Empty input or Escape adds the
   * provider without a key.
   */
  function requestKeyThen(context: Context, name: string, next: (apiKey: string | undefined) => void): void {
    context.print(
      `Enter the API key for provider '${name}' (input is masked; press Enter to continue, or Enter on an empty line or Esc if the endpoint needs no key).`,
    );
    context.beginConcealedInput!({
      label: name,
      onSubmit: (value) => next(value.length ? value : undefined),
      onCancel: () => next(undefined),
    });
  }
  /** Another provider file whose name maps to the same key slot, which would share and overwrite its key. */
  function keySlotOwner(directory: string, name: string): string | undefined {
    const slot = customProviderKeyName(name);
    let files: string[];
    try {
      files = readdirSync(directory);
    } catch {
      return undefined;
    }
    return files
      .filter((file) => file.endsWith('.json'))
      .map((file) => file.slice(0, -'.json'.length))
      .find((other) => other !== name && customProviderKeyName(other) === slot);
  }
  async function addProvider(
    context: Context,
    request: { readonly name: string; readonly baseURL: string; readonly endpoint: URL; readonly directory: string; readonly file: string },
    apiKey: string | undefined,
  ): Promise<void> {
    const { name, baseURL, endpoint, directory, file } = request;
    const confirmationSuffix = policy.confirmMutations ? ' --yes' : '';
    context.print(`Probing ${baseURL}/models ...`);
    let ids: string[] = [];
    let unreadable = false;
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), 5000);
    try {
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;
      let response: Response | undefined;
      try {
        response = await fetch(`${baseURL}/models`, { signal: abort.signal, headers });
      } catch {
        context.print(`Could not reach ${baseURL}/models: creating provider with a starter model entry; edit ${file} once the endpoint is up.`);
      }
      if (response && !response.ok) {
        const keyHint = response.status === 401 || response.status === 403
          ? apiKey ? ' The endpoint did not accept the key.' : ' The endpoint needs an API key.'
          : '';
        context.print(
          `${baseURL}/models answered HTTP ${response.status}, so provider '${name}' was not added.${keyHint} Fix the endpoint${response.status === 401 || response.status === 403 ? ' or key' : ''}, then run /provider add ${name} ${baseURL}${confirmationSuffix} again.`,
        );
        return;
      }
      if (response) {
        try {
          ids = discoveredModelIds(await response.json());
        } catch {
          unreadable = true;
        }
        if (!ids.length) unreadable = true;
      }
    } finally {
      clearTimeout(timer);
    }
    if (unreadable) context.print(`${baseURL}/models answered without a model list: creating provider with a starter model entry; edit ${file} to name its models.`);
    let windows: Record<string, number> = {};
    if (ids.length) {
      if (endpoint.protocol === 'http:') {
        try {
          windows = await fetchModelContextWindows(endpoint.hostname, Number.parseInt(endpoint.port, 10) || 80, 'unknown', ids);
        } catch {
          /* Missing metadata stays unknown. */
        }
      } else
        context.print(
          'Note: Context window detection is only supported for http:// URLs. Windows the endpoint does not report are left unknown.',
        );
    }
    const starter = `${name}-model`;
    const models: CustomProviderConfig['models'] = (ids.length ? ids : [starter]).map((id) => {
      const window = Object.hasOwn(windows, id) ? windows[id] : undefined;
      return {
        id,
        displayName: id,
        ...(window !== undefined && window > 0 ? { contextWindow: window } : {}),
        capabilities: { toolCalling: true, codeEditing: policy.codeEditing, reasoning: false, multimodal: false },
      };
    });
    // Provider JSON contains only the vault reference, never the credential.
    const config: CustomProviderConfig = {
      name,
      displayName: name,
      type: 'openai-compat',
      baseURL,
      apiKeyEnv: customProviderKeyName(name),
      models,
    };
    try {
      mkdirSync(directory, { recursive: true });
      // Exclusive create: a second add of the same name cannot overwrite the first.
      await writeFile(file, JSON.stringify(config, null, 2), { encoding: 'utf-8', flag: 'wx' });
    } catch (error) {
      throw (error as NodeJS.ErrnoException).code === 'EEXIST'
        ? commandRefusal(`Provider '${name}' already exists at ${file}`, `Remove it first with: /provider remove ${name}${confirmationSuffix}`)
        : commandRefusal(`Error writing provider file: ${summarizeError(error)}`, undefined, 'COMMAND_FAILED');
    }
    // The key is stored last, so a failed write leaves no key without a provider; a failed
    // store takes the provider file back out so the two never disagree.
    if (apiKey) {
      try {
        await storeProviderKey(services.requireSecretsManager(context), name, apiKey);
      } catch (error) {
        await unlink(file).catch(() => undefined);
        throw commandRefusal(`Could not store the key for '${name}': ${summarizeError(error)}. The provider was not added.`);
      }
    }
    const modelLines = ids.length
      ? ids
          .map((id) => {
            const window = Object.hasOwn(windows, id) ? windows[id] : undefined;
            return `  • ${id} (${window !== undefined && window > 0 ? `${window.toLocaleString()} ctx` : 'context window unknown'})`;
          })
          .join('\n')
      : `  • ${starter} (starter entry: not reported by the endpoint)`;
    context.print(
      `Provider '${name}' added with ${models.length} model(s)${apiKey ? '; its API key is stored (value hidden)' : ' and no API key'}:\n${modelLines}\nThe file watcher will auto-register it shortly.`,
    );
  }
  function registerLocalProviderRuntimeCommands(registry: Pick<TerminalCommandRegistry<Context>, 'register'>): void {
    const confirmationSuffix = policy.confirmMutations ? ' --yes' : '';
    registry.register({
      name: 'provider',
      effect: 'mixed',
      aliases: ['p'],
      description: 'Switch provider or manage custom providers (add/remove)',
      ...(policy.hidden ? { hidden: true } : {}),
      usage: `[add <name> <baseURL>${policy.allowInlineKey ? ' [apiKey]' : ''}${confirmationSuffix} | remove <name>${confirmationSuffix} | <provider-name>]`,
      argsHint: policy.confirmMutations ? '[name|add --yes|remove --yes]' : '[add|remove|name]',
      async handler(args, context) {
        const parsed = policy.confirmMutations ? stripYesFlag(args) : { rest: args, yes: true };
        const commandArgs = parsed.rest;
        const paths = services.requireShellPaths(context);
        if (commandArgs[0] === 'add') {
          const name = commandArgs[1];
          const baseURL = commandArgs[2];
          const apiKey = policy.allowInlineKey ? commandArgs[3] : undefined;
          const usage = `/provider add <name> <baseURL>${policy.allowInlineKey ? ' [apiKey]' : ''}${confirmationSuffix}`;
          if (!name || !baseURL) {
            throw commandRefusal(`Usage: ${usage}\nExample: /provider add my-server http://192.168.0.85:8001/v1${confirmationSuffix}`);
          }
          if (!parsed.yes) {
            requireYesFlag(context, `add custom provider ${name}`, usage);
            return;
          }
          if (!validProviderName(name)) {
            throw commandRefusal('Error: Provider name must contain only letters, numbers, hyphens, and underscores.');
          }
          let endpoint: URL;
          try {
            endpoint = new URL(baseURL);
            if (!['http:', 'https:'].includes(endpoint.protocol) || endpoint.username || endpoint.password)
              throw new Error('invalid endpoint');
          } catch {
            throw commandRefusal('Error: Use an http:// or https:// provider endpoint without embedded credentials.');
          }
          const directory = paths.resolveUserPath(policy.surfaceRoot, 'providers');
          const file = join(directory, `${name}.json`);
          if (existsSync(file)) {
            context.print(
              `Provider '${name}' already exists at ${file}\nRemove it first with: /provider remove ${name}${confirmationSuffix}`,
            );
            return;
          }
          const sharing = keySlotOwner(directory, name);
          if (sharing) {
            context.print(
              `Provider '${name}' was not added: its API key would be stored as ${customProviderKeyName(name)}, which provider '${sharing}' already uses. Choose a name that differs by more than - and _, or remove '${sharing}' first with /provider remove ${sharing}${confirmationSuffix}.`,
            );
            return;
          }
          const request = { name, baseURL, endpoint, directory, file };
          if (!apiKey && policy.captureMissingKey && context.beginConcealedInput) {
            requestKeyThen(context, name, (key) => {
              void addProvider(context, request, key).catch((error: unknown) => context.print(`Provider '${name}' was not added: ${summarizeError(error)}`));
            });
            return;
          }
          await addProvider(context, request, apiKey);
          return;
        }
        if (commandArgs[0] === 'remove' || commandArgs[0] === 'rm') {
          const name = commandArgs[1];
          const usage = `/provider remove <name>${confirmationSuffix}`;
          if (!name) {
            throw commandRefusal(`Usage: ${usage}`);
          }
          if (!parsed.yes) {
            requireYesFlag(context, `remove custom provider ${name}`, usage);
            return;
          }
          if (!validProviderName(name)) {
            throw commandRefusal('Error: Provider name must contain only letters, numbers, hyphens, and underscores.');
          }
          const file = paths.resolveUserPath(policy.surfaceRoot, 'providers', `${name}.json`);
          if (!existsSync(file)) {
            context.print(`No custom provider '${name}' found at ${file}`);
            return;
          }
          try {
            await unlink(file);
          } catch (error) {
            throw commandRefusal(`Error removing provider file: ${summarizeError(error)}`);
          }
          // The key belongs to this provider alone (an add refuses a name that maps to a key slot in use).
          const keyName = customProviderKeyName(name);
          try {
            await services.requireSecretsManager(context).delete(keyName, { scope: 'daemon' });
          } catch (error) {
            throw commandRefusal(`Provider '${name}' removed, but its stored API key ${keyName} could not be deleted: ${summarizeError(error)}`,
              `Delete it with /secrets delete ${keyName}`, 'PARTIALLY_DONE');
          }
          context.print(`Provider '${name}' and its stored API key ${keyName} (if any) removed. The file watcher will deregister it shortly.`);
          return;
        }
        if (!commandArgs.length) {
          if (context.openProviderPicker) {
            context.openProviderPicker();
            return;
          }
          const providers = services.requireProviderApi(context).listProviderIds();
          context.print(
            [
              'Available providers:',
              ...providers.map((provider) => `  ${provider === context.session.runtime.provider ? '▶' : ' '} ${provider}`),
            ].join('\n'),
          );
          return;
        }
        const provider = commandArgs[0];
        if (provider === undefined) return;
        const requestedModel = policy.explicitModelSelection ? commandArgs[1] : undefined;
        const api = services.requireProviderApi(context);
        try {
          const models = await api.listModels({ providerId: provider, selectableOnly: true });
          const match = models[0];
          if (!match) {
            throw commandRefusal(`Unknown provider: ${provider}. Available: ${api.listProviderIds().join(', ')}`);
          }
          const registryKey = requestedModel ? formatProviderModel(provider, requestedModel) : match.registryKey;
          const selected = await api.selectModel(registryKey);
          policy.beforeSelection(context, selected.providerId, () => {
            context.session.runtime.model = selected.registryKey;
            context.session.runtime.provider = selected.providerId;
            context.platform.configManager.set('provider.model', selected.registryKey);
            context.print(`Switched to provider: ${selected.providerId} (model: ${selected.modelId})`);
          });
        } catch (error) {
          if (readRefusal(error)) throw error;
          throw commandRefusal(`Error: ${summarizeError(error)}`, undefined, 'COMMAND_FAILED');
        }
      },
    });
  }
  return { registerLocalProviderRuntimeCommands };
}
