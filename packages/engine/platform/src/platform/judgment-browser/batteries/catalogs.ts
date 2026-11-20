import { BUILTIN_PROVIDER_ENV_KEYS } from '../../config/provider-credential-catalog.js';
export { WEBUI_CODE_LANGUAGES, type WebuiCodeLanguage } from '@goodvibes/engine/contracts';
/** Browser-safe structural catalogs. No provider, source resolver, or decision log. */
export { WEBUI_STATUS_CATALOG, readWebuiStatusCatalog, type WebuiStatusLabelId } from './webui-status-catalog.js';
export type { StatusValue } from './webui-types.js';
export { readDeclaredProviderCredential } from '../../config/provider-credential-catalog.js';
export { readFenceTagLanguage } from './code-fence-language.js';
export { isReplySubject, replySubjectLine } from './reply-subject-marker.js';
export { SECRET_BEARING_CONFIG_PATHS, isSecretBearingConfigKey } from '../../config/secret-bearing-config-keys.js';
export { isStructuredCredentialReferenceConfigKey, captureStructuredCredentialReferenceConfigValue } from '../../config/structured-credential-config.js';

/** A built-in provider declares every credential name it reads, so a name it does not list is not its credential. */
export function isDeclaredCredentialProvider(providerId: string): boolean {
  return Object.hasOwn(BUILTIN_PROVIDER_ENV_KEYS, providerId);
}
