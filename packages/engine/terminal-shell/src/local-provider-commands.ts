/**
 * Providers of your own (an OpenAI-compatible server you name): adding one
 * reads its model list from the address and keeps a provider file with only a
 * reference to its key; removing one deletes the file and its stored key.
 * `/provider add` and `/provider remove` (provider-command.ts) run these.
 */
import { join } from 'node:path';
import { existsSync, mkdirSync, readdirSync } from 'node:fs';
import { unlink, writeFile } from 'node:fs/promises';
import { fetchModelContextWindows } from '@goodvibes/engine/platform/platform/discovery';
import type { CustomProviderConfig } from '@goodvibes/engine/platform/platform/providers';
import { findCredentialScopeDeclaration, listDaemonOwnedSecretKeys, type SecretsManager } from '@goodvibes/engine/platform/platform/config';
import { summarizeError } from '@goodvibes/engine/platform/platform/utils/native-error-summary';
import { commandRefusal } from './command-confirmation.js';

export function customProviderKeyName(providerName: string): string {
  return `${providerName.replace(/[^A-Za-z0-9]/g, '_').toUpperCase()}_API_KEY`;
}
/**
 * The custom provider's key slot when it is a credential the platform itself
 * declares (a built-in provider's or a service's key): storing a custom key
 * there would overwrite that credential, and removing the provider would delete it.
 */
function platformCredentialSlot(providerName: string): string | undefined {
  const slot = customProviderKeyName(providerName);
  return findCredentialScopeDeclaration(slot) !== null || listDaemonOwnedSecretKeys().has(slot) ? slot : undefined;
}
export function validProviderName(name: string): boolean {
  return /^[a-zA-Z0-9_-]+$/.test(name);
}
function discoveredModelIds(body: unknown): string[] {
  if (!body || typeof body !== 'object' || !('data' in body) || !Array.isArray(body.data)) return [];
  return body.data
    .filter((value): value is { readonly id: unknown } => value !== null && typeof value === 'object' && 'id' in value)
    .map((value) => String(value.id))
    .filter(Boolean);
}
/** Another provider file whose name maps to the same key slot, which would share and overwrite its key. */
function keySlotOwner(directory: string, name: string): string | undefined {
  const slot = customProviderKeyName(name);
  return customProviderNames(directory).find((other) => other !== name && customProviderKeyName(other) === slot);
}

/** The providers of your own kept in `directory`, by name. */
export function customProviderNames(directory: string): string[] {
  let files: string[];
  try {
    files = readdirSync(directory);
  } catch {
    return [];
  }
  return files.filter((file) => file.endsWith('.json')).map((file) => file.slice(0, -'.json'.length)).sort((a, b) => a.localeCompare(b));
}

/**
 * Add a provider of your own: read its models from `<address>/models` (with the
 * key, when one is given), write its file with an exclusive create, then store
 * the key. Throws a refusal saying why when it was not added; returns what was added.
 */
export async function addCustomProvider(
  request: { readonly name: string; readonly address: string; readonly apiKey: string | undefined; readonly directory: string; readonly codeEditing: boolean },
  secrets: Pick<SecretsManager, 'set'>,
  progress: (line: string) => void,
): Promise<string> {
  const { name, address, apiKey, directory } = request;
  if (!validProviderName(name)) throw commandRefusal(`"${name}" is not a provider name: use only letters, numbers, - and _.`);
  let endpoint: URL;
  try {
    endpoint = new URL(address);
    if (!['http:', 'https:'].includes(endpoint.protocol) || endpoint.username || endpoint.password) throw new Error('invalid endpoint');
  } catch {
    throw commandRefusal(`"${address}" is not an address to add: use an http:// or https:// address without a user name or password in it.`);
  }
  const baseURL = address.replace(/\/+$/, '');
  const file = join(directory, `${name}.json`);
  if (existsSync(file)) throw commandRefusal(`A provider named ${name} already exists (${file}); nothing was added.`, `Remove it first: /provider remove ${name}`);
  const platformSlot = platformCredentialSlot(name);
  if (platformSlot) {
    throw commandRefusal(`${name} was not added: its key would be stored as ${platformSlot}, the key of a built-in provider or service, so adding it would overwrite that key and removing it would delete it.`, `Choose another name, such as /provider add ${name}-local ${baseURL}`);
  }
  const sharing = keySlotOwner(directory, name);
  if (sharing) {
    throw commandRefusal(`${name} was not added: its key would be stored as ${customProviderKeyName(name)}, which ${sharing} already uses.`, `Choose a name that differs by more than - and _, or remove ${sharing} first.`);
  }
  progress(`Reading the models ${baseURL}/models lists…`);
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
      progress(`${baseURL}/models did not answer: ${name} is added with a starter model entry; edit ${file} once the server is up.`);
    }
    if (response && !response.ok) {
      const keyHint = response.status === 401 || response.status === 403 ? (apiKey ? ' It did not accept the key.' : ' It needs a key.') : '';
      throw commandRefusal(`${baseURL}/models answered HTTP ${response.status}, so ${name} was not added.${keyHint}`, `Fix the server${keyHint ? ' or the key' : ''}, then add it again.`);
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
  if (unreadable) progress(`${baseURL}/models answered without a model list: ${name} is added with a starter model entry; edit ${file} to name its models.`);
  let windows: Record<string, number> = {};
  if (ids.length) {
    if (endpoint.protocol === 'http:') {
      try {
        windows = await fetchModelContextWindows(endpoint.hostname, Number.parseInt(endpoint.port, 10) || 80, 'unknown', ids);
      } catch {
        /* Missing metadata stays unknown. */
      }
    } else {
      progress('Context windows are read only from http:// addresses; the ones the server does not report stay unknown.');
    }
  }
  const starter = `${name}-model`;
  const models: CustomProviderConfig['models'] = (ids.length ? ids : [starter]).map((id) => {
    const window = Object.hasOwn(windows, id) ? windows[id] : undefined;
    return {
      id,
      displayName: id,
      ...(window !== undefined && window > 0 ? { contextWindow: window } : {}),
      capabilities: { toolCalling: true, codeEditing: request.codeEditing, reasoning: false, multimodal: false },
    };
  });
  // The provider file holds only the name of its key, never the key.
  const config: CustomProviderConfig = { name, displayName: name, type: 'openai-compat', baseURL, apiKeyEnv: customProviderKeyName(name), models };
  try {
    mkdirSync(directory, { recursive: true });
    // Exclusive create: a second add of the same name cannot overwrite the first.
    await writeFile(file, JSON.stringify(config, null, 2), { encoding: 'utf-8', flag: 'wx' });
  } catch (error) {
    throw (error as NodeJS.ErrnoException).code === 'EEXIST'
      ? commandRefusal(`A provider named ${name} already exists (${file}); nothing was added.`, `Remove it first: /provider remove ${name}`)
      : commandRefusal(`${name} was not added: its file could not be written (${summarizeError(error)}).`, undefined, 'COMMAND_FAILED');
  }
  // The key is stored last, so a failed write leaves no key without a provider; a failed
  // store takes the provider file back out so the two never disagree.
  if (apiKey) {
    try {
      await secrets.set(customProviderKeyName(name), apiKey, { scope: 'daemon', medium: 'secure' });
    } catch (error) {
      await unlink(file).catch(() => undefined);
      throw commandRefusal(`${name} was not added: its key could not be stored (${summarizeError(error)}).`);
    }
  }
  const modelLines = ids.length
    ? ids.map((id) => {
      const window = Object.hasOwn(windows, id) ? windows[id] : undefined;
      return `  • ${id} (${window !== undefined && window > 0 ? `${window.toLocaleString()} ctx` : 'context window unknown'})`;
    }).join('\n')
    : `  • ${starter} (starter entry: not reported by the server)`;
  return `Added ${name} with ${models.length} model${models.length === 1 ? '' : 's'}${apiKey ? '; its key is stored (not shown)' : ' and no key'}:\n${modelLines}\nIts models join the list in a moment.`;
}

/** Remove a provider of your own: its file, then its stored key (unless the slot is a built-in one). */
export async function removeCustomProvider(name: string, directory: string, secrets: Pick<SecretsManager, 'delete'>): Promise<string> {
  if (!validProviderName(name)) throw commandRefusal(`"${name}" is not a provider name: use only letters, numbers, - and _.`);
  const file = join(directory, `${name}.json`);
  if (!existsSync(file)) throw commandRefusal(`No provider of your own is named ${name} (${file}); nothing was removed.`, '/provider list shows them.');
  try {
    await unlink(file);
  } catch (error) {
    throw commandRefusal(`${name} was not removed: its file could not be deleted (${summarizeError(error)}).`);
  }
  const keyName = customProviderKeyName(name);
  // A provider file made by hand may name a built-in provider's or service's key slot: that key stays.
  if (platformCredentialSlot(name)) return `Its key slot ${keyName} belongs to a built-in provider or service, so that key was kept. Its models leave the list in a moment.`;
  try {
    await secrets.delete(keyName, { scope: 'daemon' });
  } catch (error) {
    throw commandRefusal(`${name} was removed, but its stored key ${keyName} could not be deleted: ${summarizeError(error)}`, `Delete it with /secrets delete ${keyName}`, 'PARTIALLY_DONE');
  }
  return `Its stored key ${keyName} (if any) was deleted too. Its models leave the list in a moment.`;
}
