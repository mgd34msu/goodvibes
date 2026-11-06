import { join } from 'node:path';
import { existsSync, mkdirSync } from 'node:fs';
import { unlink, writeFile } from 'node:fs/promises';
import { fetchModelContextWindows } from '@goodvibes-jev/engine/sdk/platform/discovery';
import type { CustomProviderConfig, ProviderApi } from '@goodvibes-jev/engine/sdk/platform/providers';
import type { LiteralSecretsManager } from '@goodvibes-jev/engine/sdk/platform/config';
import type { ShellPathService } from '@goodvibes-jev/engine/sdk/platform/runtime/shell';
import { summarizeError } from '@goodvibes-jev/engine/sdk/platform/utils';
import type { TerminalCommandRegistry } from './command-registry.js';
import type { ConcealedInputRequest } from './concealed-input.js';
import { requireYesFlag, stripYesFlag } from './command-confirmation.js';

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
async function storeProviderKey(manager: Pick<LiteralSecretsManager, 'set'>, name: string, value: string): Promise<void> {
  await manager.set(customProviderKeyName(name), value, { scope: 'daemon', medium: 'secure' });
}
export function createLocalProviderCommands<Context extends LocalProviderCommandContext>(
  services: {
    readonly requireProviderApi: (context: Context) => ProviderApi;
    readonly requireShellPaths: (context: Context) => ShellPathService;
    readonly requireSecretsManager: (context: Context) => Pick<LiteralSecretsManager, 'set'>;
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
  function requestKey(context: Context, name: string): void {
    if (!context.beginConcealedInput) return;
    const manager = services.requireSecretsManager(context);
    context.print(
      `Enter the API key for provider '${name}' (input is masked; press Enter to store, Esc to skip if the endpoint needs no key).`,
    );
    const skipped = () => context.print(`No key stored for '${name}' (endpoint used without a key).`);
    context.beginConcealedInput({
      label: name,
      onSubmit(value) {
        if (!value.length) {
          skipped();
          return;
        }
        void storeProviderKey(manager, name, value).then(
          () => context.print(`Stored the API key for '${name}' (value hidden). It resolves live for this provider; no restart needed.`),
          (error) => context.print(`Could not store the key for '${name}': ${summarizeError(error)}`),
        );
      },
      onCancel: skipped,
    });
  }
  function registerLocalProviderRuntimeCommands(registry: Pick<TerminalCommandRegistry<Context>, 'register'>): void {
    const confirmationSuffix = policy.confirmMutations ? ' --yes' : '';
    registry.register({
      name: 'provider',
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
            context.print(`Usage: ${usage}\nExample: /provider add my-server http://192.168.0.85:8001/v1${confirmationSuffix}`);
            return;
          }
          if (!parsed.yes) {
            requireYesFlag(context, `add custom provider ${name}`, usage);
            return;
          }
          if (!validProviderName(name)) {
            context.print('Error: Provider name must contain only letters, numbers, hyphens, and underscores.');
            return;
          }
          let endpoint: URL;
          try {
            endpoint = new URL(baseURL);
            if (!['http:', 'https:'].includes(endpoint.protocol) || endpoint.username || endpoint.password)
              throw new Error('invalid endpoint');
          } catch {
            context.print('Error: Use an http:// or https:// provider endpoint without embedded credentials.');
            return;
          }
          const directory = paths.resolveUserPath(policy.surfaceRoot, 'providers');
          const file = join(directory, `${name}.json`);
          if (existsSync(file)) {
            context.print(
              `Provider '${name}' already exists at ${file}\nRemove it first with: /provider remove ${name}${confirmationSuffix}`,
            );
            return;
          }
          if (apiKey) {
            try {
              await storeProviderKey(services.requireSecretsManager(context), name, apiKey);
            } catch (error) {
              context.print(`Could not store the key for '${name}': ${summarizeError(error)}`);
              return;
            }
          }
          context.print(`Probing ${baseURL}/models ...`);
          let ids: string[] = [];
          const abort = new AbortController();
          const timer = setTimeout(() => abort.abort(), 5000);
          try {
            const headers: Record<string, string> = { 'Content-Type': 'application/json' };
            if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;
            const response = await fetch(`${baseURL}/models`, { signal: abort.signal, headers });
            if (response.ok) ids = discoveredModelIds(await response.json());
          } catch {
            context.print(`Could not reach ${baseURL}/models: creating provider with a minimal starter config.`);
          } finally {
            clearTimeout(timer);
          }
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
            await writeFile(file, JSON.stringify(config, null, 2), 'utf-8');
          } catch (error) {
            context.print(`Error writing provider file: ${summarizeError(error)}`);
            return;
          }
          const modelLines = ids.length
            ? ids
                .map((id) => {
                  const window = Object.hasOwn(windows, id) ? windows[id] : undefined;
                  return `  • ${id} (${window !== undefined && window > 0 ? `${window.toLocaleString()} ctx` : 'context window unknown'})`;
                })
                .join('\n')
            : `  • ${starter} (starter entry)`;
          context.print(
            `Provider '${name}' added with ${models.length} model(s):\n${modelLines}\nThe file watcher will auto-register it shortly.`,
          );
          if (!apiKey && policy.captureMissingKey) requestKey(context, name);
          return;
        }
        if (commandArgs[0] === 'remove' || commandArgs[0] === 'rm') {
          const name = commandArgs[1];
          const usage = `/provider remove <name>${confirmationSuffix}`;
          if (!name) {
            context.print(`Usage: ${usage}`);
            return;
          }
          if (!parsed.yes) {
            requireYesFlag(context, `remove custom provider ${name}`, usage);
            return;
          }
          if (!validProviderName(name)) {
            context.print('Error: Provider name must contain only letters, numbers, hyphens, and underscores.');
            return;
          }
          const file = paths.resolveUserPath(policy.surfaceRoot, 'providers', `${name}.json`);
          if (!existsSync(file)) {
            context.print(`No custom provider '${name}' found at ${file}`);
            return;
          }
          try {
            await unlink(file);
            context.print(`Provider '${name}' removed. The file watcher will deregister it shortly.`);
          } catch (error) {
            context.print(`Error removing provider file: ${summarizeError(error)}`);
          }
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
            context.print(`Unknown provider: ${provider}. Available: ${api.listProviderIds().join(', ')}`);
            return;
          }
          const registryKey = requestedModel
            ? requestedModel.includes(':')
              ? requestedModel
              : `${provider}:${requestedModel}`
            : match.registryKey;
          const selected = await api.selectModel(registryKey);
          policy.beforeSelection(context, selected.providerId, () => {
            context.session.runtime.model = selected.registryKey;
            context.session.runtime.provider = selected.providerId;
            context.platform.configManager.set('provider.model', selected.registryKey);
            context.print(`Switched to provider: ${selected.providerId} (model: ${selected.modelId})`);
          });
        } catch (error) {
          context.print(`Error: ${summarizeError(error)}`);
        }
      },
    });
  }
  return { registerLocalProviderRuntimeCommands };
}
