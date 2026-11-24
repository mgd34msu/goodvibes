import { ToolError } from '../types/errors.js';

/** A missing model-selected tool is a recoverable call failure, never admission. */
export class UnknownPreparedToolError extends ToolError {
  constructor(toolName: string) {
    super('Unknown tool in autonomous preparation', toolName);
  }
}

/** Where a call's arguments first fail the tool's schema, as the validator reports it. */
export interface ToolInputFailure {
  /** `$`-rooted path, such as `$.commands[0].cmd`. */
  readonly path: string;
  readonly expected: string;
  readonly received: string;
}

/**
 * A call whose arguments do not match its tool's schema after the format
 * repairs: nothing ran. Its message is written for the model (the field, what
 * was received, what is accepted, and the repairs already made); `ownerLine`
 * is the one sentence a person reads. Like an unknown tool, it is answered as
 * a failed call and the turn goes on.
 */
export class ToolInputError extends ToolError {
  readonly field: string;
  readonly ownerLine: string;
  constructor(toolName: string, failure: ToolInputFailure, receivedValue: string | undefined, repairs: readonly string[]) {
    const field = failure.path === '$' || failure.path === '' ? 'the arguments' : failure.path.replace(/^\$\.?/, '');
    const received = receivedValue === undefined ? failure.received : `${failure.received} ${receivedValue}`;
    super(`The call to ${toolName} was not run: ${field} does not match the tool's schema. Received: ${received}. Accepted: ${failure.expected}.`
      + (repairs.length > 0 ? ` Already repaired before checking: ${repairs.join(', ')}.` : '')
      + ` Send the call again with ${field} corrected.`, toolName);
    this.name = 'ToolInputError';
    this.field = field;
    this.ownerLine = `The model's call to ${toolName} was malformed; it was asked to send it again.`;
  }
}
