import { expect, test } from 'bun:test';
import { fitLabelDetailColumns } from '../terminal-shell/src/text-layout.js';

test('the label column leaves the two-cell gutter even below the ten-cell floor', () => {
  for (const total of [0, 8, 9, 10, 11]) {
    const { labelWidth, detailWidth } = fitLabelDetailColumns('a', 'b', total);
    const budget = Math.max(8, total);
    expect(labelWidth).toBeLessThanOrEqual(budget - 2);
    expect(labelWidth + detailWidth + 2).toBeLessThanOrEqual(budget);
  }
});
