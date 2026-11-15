import { addNumbers } from './math.mjs';

export function total(values) {
  return values.reduce((acc, value) => addNumbers(acc, value), 0);
}
