import { describe, expect, it } from 'vitest';
import { initialFor } from '../initials';

describe('initialFor (topbar avatar, Q-02 coordinator default)', () => {
  it.each([
    ['Tom Haynes', 'T'],
    ['sam', 'S'],
    ['  pat g ', 'P'],
    ['9lives', '9'],
    ['', '?'],
    ['   ', '?'],
    [null, '?'],
    [undefined, '?'],
  ])('%j → %s', (name, expected) => {
    expect(initialFor(name)).toBe(expected);
  });
});
