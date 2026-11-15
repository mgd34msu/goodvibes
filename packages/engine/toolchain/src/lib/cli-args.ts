/**
 * Argument helpers shared by the toolchain bins. A flag that needs a value and
 * has none is an error: falling back to a default would act on a different
 * target than the one the caller meant.
 */

/** The value after `flag`, or undefined when the flag is absent. Throws when the flag has no value. */
export function flagValue(argv: readonly string[], flag: string): string | undefined {
  const index = argv.indexOf(flag);
  if (index === -1) return undefined;
  const value = argv[index + 1];
  if (value === undefined || value.startsWith('--')) throw new Error(`${flag} needs a value`);
  return value;
}

/** A bare file name: no directory part, so it cannot point outside the directory it is resolved against. */
export function isBareBasename(name: string): boolean {
  return name !== '' && name !== '.' && name !== '..' && !/[\\/\0]/.test(name);
}
