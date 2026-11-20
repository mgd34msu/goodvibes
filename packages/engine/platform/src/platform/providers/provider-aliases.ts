import { CATALOG_PROVIDER_NAME_ALIASES } from '@goodvibes/engine/contracts';
export { CATALOG_PROVIDER_NAME_ALIASES } from '@goodvibes/engine/contracts';


export function sameProviderCatalog(left: string, right: string): boolean {
  return (CATALOG_PROVIDER_NAME_ALIASES[left] ?? left) === (CATALOG_PROVIDER_NAME_ALIASES[right] ?? right);
}
