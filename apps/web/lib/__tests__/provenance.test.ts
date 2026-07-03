import { describe, expect, it } from 'vitest';
import { provenanceForApp, provenanceLabel, type AdminTagLike } from '../provenance';

const app = (id: string, defaultVisible = false) => ({ id, defaultVisible });
const tag = (id: string, name: string, appIds: string[]): AdminTagLike => ({
  id,
  name,
  bundle: { appIds },
});

const allTags = [tag('t1', 'family', ['a1', 'a2']), tag('t2', 'media', ['a2'])];

describe('provenanceForApp (DESIGN-003 D-05/D-09, R-22)', () => {
  it('empty when the user has no access path', () => {
    const user = { directGrants: [], tags: [] };
    expect(provenanceForApp(app('a1'), user, allTags)).toEqual([]);
  });

  it('defaultVisible yields a default chip for everyone', () => {
    const user = { directGrants: [], tags: [] };
    expect(provenanceForApp(app('a1', true), user, allTags)).toEqual([{ kind: 'default' }]);
  });

  it('direct grant yields a direct chip', () => {
    const user = { directGrants: [{ appId: 'a1' }], tags: [] };
    expect(provenanceForApp(app('a1'), user, allTags)).toEqual([{ kind: 'direct' }]);
  });

  it('applied tags contribute one chip per bundling tag; unapplied tags do not', () => {
    const user = { directGrants: [], tags: [{ id: 't1' }] };
    expect(provenanceForApp(app('a2'), user, allTags)).toEqual([
      { kind: 'tag', tagId: 't1', tagName: 'family' },
    ]);
  });

  it('stacks every source (default + direct + multiple tags)', () => {
    const user = { directGrants: [{ appId: 'a2' }], tags: [{ id: 't1' }, { id: 't2' }] };
    const chips = provenanceForApp(app('a2', true), user, allTags);
    expect(chips.map(provenanceLabel)).toEqual(['default', 'direct', 'tag:family', 'tag:media']);
  });

  it('tag chip only appears when the bundle contains the app', () => {
    const user = { directGrants: [], tags: [{ id: 't2' }] };
    expect(provenanceForApp(app('a1'), user, allTags)).toEqual([]);
  });
});
