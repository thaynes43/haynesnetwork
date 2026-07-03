import { describe, expect, it } from 'vitest';

import { DOMAIN_PACKAGE } from '../src/index';

describe('@hnet/domain scaffold', () => {
  it('exports the package marker', () => {
    expect(DOMAIN_PACKAGE).toBe('@hnet/domain');
  });
});
