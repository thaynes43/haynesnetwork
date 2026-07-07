// ADR-023 / DESIGN-010 D-02 — Maintainerr READ client ACL regression. Exercised against fetch stubs
// only (no live call); shapes derived from the v3.17.0 source.
import { describe, expect, it } from 'vitest';
import { MaintainerrClient } from '../src/maintainerr';
import { maintainerrExclusionSchema } from '../src/schemas/maintainerr';
import { stubFetch, TEST_OPTS } from './helpers';

function client(routes: Parameters<typeof stubFetch>[0]) {
  const stub = stubFetch(routes);
  return {
    client: new MaintainerrClient({
      baseUrl: 'http://maintainerr.test:6246',
      fetchImpl: stub.fetchImpl,
      ...TEST_OPTS,
    }),
    ...stub,
  };
}

describe('MaintainerrClient.getExclusions (ADR-023 P2 — string-parent schema)', () => {
  it('parses an exclusion whose `parent` is a STRING (the Plex ratingKey v3.17.0 writes)', async () => {
    // v3.17.0 Exclusion.parent is `@Column() parent: string`. The old `z.number().int()` schema made
    // getExclusions 502 for every already-excluded item → broken idempotency + un-save on the real
    // estate. A string parent must now parse cleanly.
    const { client: c } = client([
      {
        method: 'GET',
        path: '/api/rules/exclusion',
        body: [{ id: 1, mediaServerId: '55001', ruleGroupId: null, parent: '54999', type: 'movie' }],
      },
    ]);
    const exclusions = await c.getExclusions({ mediaServerId: '55001' });
    expect(exclusions).toHaveLength(1);
    expect(exclusions[0]).toMatchObject({ mediaServerId: '55001', parent: '54999' });
  });

  it('still accepts a numeric parent (defensive union)', () => {
    expect(maintainerrExclusionSchema.parse({ id: 2, parent: 42 }).parent).toBe(42);
    expect(maintainerrExclusionSchema.parse({ id: 3, parent: 'rk-7' }).parent).toBe('rk-7');
  });
});
