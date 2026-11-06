/** Common explicit permission keys. Denial and escape policy are construction-owned product choices. */
export function handleSimplePermissionInput(
  data: string,
  ports: {
    readonly escapeDenies: boolean;
    readonly abortOnDeny: boolean;
    readonly resolve: (approved: boolean, remember: boolean) => void;
    readonly abort: () => void;
    readonly render: () => void;
  },
): boolean {
  const key = data.toLowerCase().trim();
  const deny = key === 'n' || (ports.escapeDenies && (data === '\x1b' || data === '\x03'));
  if (key !== 'y' && key !== 'a' && !deny) return false;
  ports.resolve(!deny, key === 'a');
  if (deny && ports.abortOnDeny) ports.abort();
  ports.render();
  return true;
}
