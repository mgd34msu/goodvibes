/** Lossless spelling of a native lowercase UUID with no card-shaped decimal runs.
 * UUID producers retain their entropy and ordering; existing stored IDs are never rewritten.
 */
export function opaqueUuid(uuid: string = crypto.randomUUID()): string {
  return uuid.replace(/[0-9a-f]/g, nibble => String.fromCharCode(97 + Number.parseInt(nibble, 16)));
}
