/** A snapshot needs an actual declared reference; raw object bytes are not an
 * identity. Errors expose only a known group and item position, never payloads. */
const groups = new Set(['entity', 'device', 'area', 'automation', 'script', 'scene', 'label', 'integration', 'home', 'device_passport', 'room', 'maintenance_item', 'troubleshooting_case', 'purchase', 'network_node', 'entities', 'devices', 'areas', 'automations', 'scripts', 'scenes', 'labels', 'integrations', 'helpers']);
export class HomeGraphObjectIdentityError extends Error {
  override readonly name = 'HomeGraphObjectIdentityError';
  readonly group: string;
  readonly index: number | undefined;
  constructor(group: string, index?: number) {
    const selected = groups.has(group) ? group : 'object';
    const position = index !== undefined && Number.isSafeInteger(index) && index >= 0 ? index : undefined;
    super(`Home Graph ${selected}${position === undefined ? '' : ` item ${position + 1}`} needs a recognizable identity: provide an id, registry identifier, slug, name or title.`);
    this.group = selected; this.index = position;
  }
}
