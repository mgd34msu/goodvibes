import { expect } from 'bun:test';

const FIXTURE_FAULT = /^(Unscripted|Unexpected)\b/;
const PROGRAMMING_ERRORS = [TypeError, RangeError, ReferenceError, SyntaxError] as const;

/**
 * A rejection that comes from the code under test, not from a script that ran out of answers or a coding slip.
 * `message` names the one refusal expected when the refusal itself is a built-in error (a write to a frozen object).
 */
function assertGenuineRefusal(reason: unknown, message?: RegExp): void {
  expect(reason).toBeInstanceOf(Error);
  const error = reason as Error;
  if (message) { expect(error.message).toMatch(message); return; }
  for (const fault of PROGRAMMING_ERRORS) expect(error, `a ${fault.name} is a fault, not a refusal: ${error.message}`).not.toBeInstanceOf(fault);
  expect(error.message, 'the fixture ran out of scripted answers before the intended refusal').not.toMatch(FIXTURE_FAULT);
}

/** Asserts the call was refused by the product; a fixture or script error does not count as a refusal. */
export async function expectHeld(pending: PromiseLike<unknown>, message?: RegExp): Promise<void> {
  const outcome = await Promise.resolve(pending).then(
    () => ({ rejected: false as const }),
    (reason: unknown) => ({ rejected: true as const, reason }),
  );
  expect(outcome.rejected, 'the call resolved instead of being refused').toBe(true);
  if (outcome.rejected) assertGenuineRefusal(outcome.reason, message);
}

/** Asserts the call did not succeed: a failed result, or a refusal that is not a fixture or coding fault. */
export async function expectNotSucceeded(pending: PromiseLike<{ readonly success: boolean }>): Promise<void> {
  const outcome = await Promise.resolve(pending).then(
    (result) => ({ rejected: false as const, result }),
    (reason: unknown) => ({ rejected: true as const, reason }),
  );
  if (outcome.rejected) assertGenuineRefusal(outcome.reason);
  else expect(outcome.result.success).toBe(false);
}
