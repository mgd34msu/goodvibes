/**
 * Error-class re-exports for `instanceof` assertions.
 *
 * Transport sources import the error classes through `@goodvibes-jev/engine/errors`,
 * which resolves to `errors/src/index.ts` under Bun. Importing the same file here
 * keeps one module instance, so `err instanceof GoodVibesError` holds across the
 * boundary. Import from the source, never from `errors/dist`: a stale build would
 * give a second set of constructors and the tests would judge old code.
 */
export {
  GoodVibesError,
  HttpStatusError,
  ConfigurationError,
  ContractError,
} from '../../errors/src/index.js';
