import { describe, expect, it } from 'vitest';
import { parseOneBookRepairArgs } from '../src/scripts/pairing-one-book-repair';
const identity = [
  '--request-id=55f3c29a-5b0f-47df-8dab-4d05229a480b',
  '--expected-park=multi_book',
  '--expected-title=Wool',
  '--expected-author=Hugh Howey',
];
describe('scoped park repair command', () => {
  it('requires an explicit mode and keeps spaces in the expected title/author literal', () => {
    expect(() => parseOneBookRepairArgs(identity)).toThrow();
    expect(parseOneBookRepairArgs(['--dry-run', ...identity])).toMatchObject({
      dryRun: true,
      expectedTitle: 'Wool',
      expectedAuthor: 'Hugh Howey',
      expectedPark: 'multi_book',
    });
    expect(parseOneBookRepairArgs(['--apply', ...identity])).toMatchObject({ dryRun: false });
  });
  it('rejects mixed modes, unknown/repeated arguments and unrestricted park kinds', () => {
    expect(() => parseOneBookRepairArgs(['--dry-run', '--apply', ...identity])).toThrow();
    expect(() => parseOneBookRepairArgs(['--apply', ...identity, '--all'])).toThrow();
    expect(() =>
      parseOneBookRepairArgs(['--apply', ...identity, '--expected-title=First Shift']),
    ).toThrow();
    expect(() =>
      parseOneBookRepairArgs([
        '--apply',
        ...identity.map((s) => s.replace('multi_book', 'wrong_volume')),
      ]),
    ).toThrow();
  });
});
