// ADR-087 / DESIGN-049 D-02 — the /api/mcp route adapter, tested at the route level with @hnet/mcp mocked
// (web tests never touch a database — the handler itself is proven end to end in packages/mcp). The
// load-bearing assertions: the module exports ONLY `POST` (so Next answers GET / DELETE / PUT / PATCH with
// 405 and they never reach the stateless transport), runs on the Node runtime, is never cached, and hands
// the request to the handler untouched.
import { beforeEach, describe, expect, it, vi } from 'vitest';

const handleMcpRequest = vi.hoisted(() => vi.fn());
vi.mock('@hnet/mcp', () => ({ handleMcpRequest }));

import * as route from '../../app/api/mcp/route';

beforeEach(() => {
  handleMcpRequest.mockReset();
});

describe('POST /api/mcp — the route adapter', () => {
  it('exports only POST (every other method is Next’s 405), on the Node runtime, never cached', () => {
    expect(Object.keys(route).sort()).toEqual(['POST', 'dynamic', 'runtime']);
    expect(route.runtime).toBe('nodejs');
    expect(route.dynamic).toBe('force-dynamic');
    for (const method of ['GET', 'DELETE', 'PUT', 'PATCH', 'HEAD', 'OPTIONS']) {
      expect(method in route, method).toBe(false);
    }
  });

  it('hands the request to @hnet/mcp untouched and returns its response', async () => {
    const response = new Response('{"jsonrpc":"2.0","id":1,"result":{}}', { status: 200 });
    handleMcpRequest.mockResolvedValue(response);
    const req = new Request('http://app.local/api/mcp', {
      method: 'POST',
      headers: { authorization: 'Bearer x', 'content-type': 'application/json' },
      body: '{"jsonrpc":"2.0","id":1,"method":"tools/list"}',
    });
    await expect(route.POST(req)).resolves.toBe(response);
    expect(handleMcpRequest).toHaveBeenCalledWith(req);
  });
});
