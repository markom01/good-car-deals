import { describe, expect, it } from 'vitest';
import { chunk } from './chunk';

describe('chunk', () => {
  it('splits items into fixed-size rows', () => {
    expect(chunk([1, 2, 3, 4, 5, 6], 3)).toEqual([
      [1, 2, 3],
      [4, 5, 6],
    ]);
  });

  it('keeps the last row partial', () => {
    expect(chunk([1, 2, 3, 4, 5, 6, 7], 3)).toEqual([
      [1, 2, 3],
      [4, 5, 6],
      [7],
    ]);
  });

  it('returns no rows for an empty list', () => {
    expect(chunk([], 3)).toEqual([]);
  });

  it('rejects a non-positive row size', () => {
    expect(() => chunk([1], 0)).toThrow(
      'chunk size must be a positive integer',
    );
    expect(() => chunk([1], -1)).toThrow(
      'chunk size must be a positive integer',
    );
  });
});
