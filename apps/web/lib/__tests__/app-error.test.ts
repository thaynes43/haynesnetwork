import { describe, expect, it } from 'vitest';
import { appCodeOf, describeMutationError } from '../app-error';

describe('appCode error surfacing (DESIGN-003 D-13)', () => {
  it('reads the appCode the errorFormatter attaches', () => {
    expect(appCodeOf({ data: { appCode: 'ROLE_NAME_CONFLICT' } })).toBe('ROLE_NAME_CONFLICT');
    expect(appCodeOf({ data: {} })).toBeUndefined();
    expect(appCodeOf({ data: null })).toBeUndefined();
    expect(appCodeOf(null)).toBeUndefined();
    expect(appCodeOf('boom')).toBeUndefined();
  });

  it('maps known appCodes to friendly copy', () => {
    expect(
      describeMutationError({ message: 'raw', data: { appCode: 'CATALOG_URL_INVALID' } }),
    ).toMatch(/example\.com/);
    expect(
      describeMutationError({ message: 'raw', data: { appCode: 'ROLE_NAME_CONFLICT' } }),
    ).toMatch(/already exists/);
    expect(describeMutationError({ message: 'raw', data: { appCode: 'ROLE_IMMUTABLE' } })).toMatch(
      /system role/i,
    );
    expect(describeMutationError({ message: 'raw', data: { appCode: 'LAST_ADMIN' } })).toMatch(
      /last Admin/i,
    );
    expect(
      describeMutationError({ message: 'raw', data: { appCode: 'REORDER_SET_MISMATCH' } }),
    ).toMatch(/refresh/);
  });

  it('falls back to the message, then to generic copy', () => {
    expect(describeMutationError({ message: 'NOT_FOUND: no such tag' })).toBe(
      'NOT_FOUND: no such tag',
    );
    expect(describeMutationError({ message: '', data: { appCode: 'UNKNOWN_CODE' } })).toBe(
      'Something went wrong. Try again.',
    );
    expect(describeMutationError(undefined)).toBe('Something went wrong. Try again.');
  });
});
