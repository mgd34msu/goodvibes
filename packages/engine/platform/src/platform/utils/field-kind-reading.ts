import type { JudgmentReadingOptions } from '@goodvibes-jev/engine/errors';
import { assertRedactionCurrent } from './redaction-reading.js';

/** The role of a structured field name: credential material, owner-profile data, free text, or an ordinary fact. */
export type FieldKind = 'secret' | 'owner_profile' | 'content' | 'other';

/** Declared field roles, keyed by the name with `_` and `-` removed and lower-cased. */
const fields: Readonly<Record<FieldKind, ReadonlySet<string>>> = {
  secret: new Set(['password', 'passwd', 'loginpassword', 'apikey', 'accesstoken', 'refreshtoken', 'idtoken', 'authorization',
    'proxyauthorization', 'cookie', 'setcookie', 'credential', 'credentials', 'credentialref', 'token', 'privatekey', 'signingkey',
    'secret', 'clientsecret', 'unlockpassphrase', 'privatesigningmaterial',
    'pan', 'cvv', 'cvc', 'cardnumber', 'cardexpiry', 'ccnumber', 'cccsc', 'ccexp', 'ccexpmonth', 'ccexpyear']),
  owner_profile: new Set(['shippingaddress', 'billingaddress', 'homeaddress', 'emailaddress', 'phonenumber', 'privateaddress', 'quiethours']),
  content: new Set(['message', 'body', 'text', 'content', 'prompt', 'response', 'stdout', 'stderr', 'output', 'error', 'stack',
    'summary', 'hint', 'name', 'note', 'description', 'reasoningcontent', 'reasoningsummary', 'instructions', 'document', 'transcript', 'title',
    'data', 'details', 'payload', 'attributes', 'arguments', 'result', 'results', 'records', 'items', 'nested', 'self', 'metadata', 'judgment', 'config', 'extension', 'surfaces', 'diagnostics',
    'servers', 'endpoints', 'baseurl', 'modelsurl']),
  other: new Set(['id', 'recordid', 'requestid', 'sessionid', 'agentid', 'taskid', 'documentid', 'traceid', 'spanid', 'workstreamid',
    'domain', 'eventtype', 'source', 'turnid', 'stopreason', 'model', 'modelid', 'provider', 'providerid', 'registrykey', 'site', 'universe', 'kind', 'type', 'category', 'code', 'status', 'state',
    'count', 'tokencount', 'maxtokens', 'maxoutputtokens', 'totaltokens', 'inputtokens', 'outputtokens', 'cachereadtokens', 'cachewritetokens',
    'durationms', 'latencyms', 'elapsedms', 'timestamp', 'at', 'attempt', 'attempts', 'retryafterms', 'size', 'bytes', 'limit', 'total',
    'path', 'filepath', 'stalepath', 'quarantinepath', 'syscall', 'command', 'exitcode', 'signal', 'label',
    'depth', 'maxdepth', 'reaped', 'preservedunknown', 'argcount', 'agems', 'delayms',
    'active', 'enabled', 'success', 'valid', 'complete', 'cached', 'recoverable', 'stable', 'found',
    'loadedmodels', 'loadedmodelcount', 'toolsupport', 'schemastatus', 'resourcepressure', 'memoryusagepercent', 'vramusagepercent']),
};

/**
 * Last words that make a field name a credential whatever precedes them
 * (`botToken`, `webhookSecret`, `smtpPassword`). Checked after the declared
 * `other` names, so `tokenCount` and `maxTokens` stay ordinary counts.
 */
const SECRET_NAME_ENDINGS = ['token', 'secret', 'password', 'passwd', 'passphrase', 'apikey', 'privatekey', 'signingkey',
  'credential', 'credentials', 'cookie', 'authorization'] as const;

function normalizeFieldName(field: string): string {
  return field.replace(/[_-]/g, '').toLowerCase();
}

/** The declared role of a field name, or undefined when the name declares none. No I/O, no model. */
export function declaredFieldKind(field: string): FieldKind | undefined {
  const name = normalizeFieldName(field);
  for (const kind of ['secret', 'owner_profile', 'content', 'other'] as const) if (fields[kind].has(name)) return kind;
  if (SECRET_NAME_ENDINGS.some(ending => name.endsWith(ending))) return 'secret';
  return undefined;
}

/**
 * Whether a field's whole value is withheld wherever a record is shown or
 * stored: credential material and owner-profile data. Every other field keeps
 * its value, with its text masked for credential-shaped material.
 */
export function withheldFieldKind(field: string): 'secret' | 'owner_profile' | undefined {
  const kind = declaredFieldKind(field);
  return kind === 'secret' || kind === 'owner_profile' ? kind : undefined;
}

/** Field roles bound to one redaction operation's lifetime (the semantic export path). */
export class FieldKindReader {
  private disposed = false;
  constructor(private readonly options: JudgmentReadingOptions = {}) {}

  read(field: string): FieldKind | undefined {
    try {
      if (this.disposed || this.options.signal?.aborted) return undefined;
      assertRedactionCurrent(this.options.assertCurrent);
      return declaredFieldKind(field);
    } catch { return undefined; }
  }

  async readAsync(field: string): Promise<FieldKind | undefined> { return this.read(field); }
  dispose(): void { this.disposed = true; }
}
