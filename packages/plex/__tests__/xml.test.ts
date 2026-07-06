import { describe, expect, it } from 'vitest';
import { parseXml, childrenNamed } from '../src/xml';
import { SERVER_SECTIONS_XML, SHARED_SERVERS_XML, USERS_XML } from '../__fixtures__/xml';

describe('parseXml — the minimal Plex XML reader', () => {
  it('parses users into <User> children with attributes + nested <Server>', () => {
    const root = parseXml(USERS_XML);
    expect(root.tag).toBe('MediaContainer');
    const users = childrenNamed(root, 'User');
    expect(users).toHaveLength(2);
    expect(users[0]!.attrs).toMatchObject({ id: '111', email: 'Alice@Example.com', username: 'alice' });
    // nested element captured
    expect(childrenNamed(users[0]!, 'Server')[0]!.attrs.machineIdentifier).toBe('mid-tower');
  });

  it('decodes entities in attribute values (&amp; → &)', () => {
    const server = childrenNamed(parseXml(SERVER_SECTIONS_XML), 'Server')[0]!;
    const tv = childrenNamed(server, 'Section').find((s) => s.attrs.key === '2')!;
    expect(tv.attrs.title).toBe('HNet TV & Specials');
  });

  it('handles self-closing <Section/> and the shared="1|0" flag', () => {
    const ss = childrenNamed(parseXml(SHARED_SERVERS_XML), 'SharedServer')[0]!;
    const sections = childrenNamed(ss, 'Section');
    expect(sections).toHaveLength(4);
    expect(sections.filter((s) => s.attrs.shared === '1').map((s) => s.attrs.key)).toEqual(['1', '2']);
  });

  it('throws on an empty document', () => {
    expect(() => parseXml('   ')).toThrow();
  });
});
