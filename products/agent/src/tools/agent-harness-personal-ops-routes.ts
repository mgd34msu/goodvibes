/** Route strings the Personal Ops catalogs hand to the model, spelled with the discriminator keys the tools really read. */

/** agent_local_registry takes the singular domain name. */
export const NOTE_CAPTURE_ROUTE = 'agent_local_registry domain:"note" action:"create"';

/** The mcp tool picks its behaviour with `mode`. */
export function mcpSchemaRoute(qualifiedName: string): string {
  return `mcp mode:"schema" qualifiedName:"${qualifiedName}"`;
}

/** agent_artifacts picks its behaviour with `mode`. */
export function artifactShowRoute(artifactId: string, includeContent?: boolean): string {
  return `agent_artifacts mode:"show" artifactId:"${artifactId}"${includeContent === undefined ? '' : ` includeContent:${includeContent}`}`;
}
