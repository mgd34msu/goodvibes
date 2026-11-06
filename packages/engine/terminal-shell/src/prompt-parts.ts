/** Join optional host-composed prompt sections without inventing content. */
export function joinPromptParts(...parts: Array<string | null | undefined>): string {
  return parts
    .map((part) => part?.trim())
    .filter((part): part is string => Boolean(part))
    .join('\n\n');
}
