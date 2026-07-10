import { describe, expect, it, vi } from 'vitest';
import {
  createPrometheusClient,
  PROMETHEUS_DEFAULT_URL,
  prometheusClientFromEnv,
} from '../src/client';

function jsonResponse(body: unknown, ok = true, status = 200): Response {
  return {
    ok,
    status,
    json: async () => body,
  } as unknown as Response;
}

/** A fetch mock with typed params so `.mock.calls[i][0]` (the request URL) is well-typed. */
function fetchMock(body: unknown, ok = true, status = 200) {
  return vi.fn(async (_url: string | URL | Request, _init?: RequestInit) =>
    jsonResponse(body, ok, status),
  );
}

const VECTOR_OK = {
  status: 'success',
  data: {
    resultType: 'vector',
    result: [{ metric: { __name__: 'x' }, value: [1_700_000_000, '42'] }],
  },
};

const MATRIX_OK = {
  status: 'success',
  data: {
    resultType: 'matrix',
    result: [{ metric: { __name__: 'x' }, values: [[1_700_000_000, '42']] }],
  },
};

function calledUrl(fetchImpl: ReturnType<typeof fetchMock>): URL {
  const arg = fetchImpl.mock.calls[0]?.[0];
  return new URL(String(arg));
}

describe('createPrometheusClient.query (instant)', () => {
  it('GETs /api/v1/query with the promQL + optional time, parses the vector', async () => {
    const fetchImpl = fetchMock(VECTOR_OK);
    const client = createPrometheusClient({ baseUrl: 'http://prom:9090/', fetchImpl });
    const out = await client.query('sum(node_load1)', 1_700_000_100);
    expect(out).toHaveLength(1);
    expect(out[0]?.value[1]).toBe('42');
    const url = calledUrl(fetchImpl);
    expect(url.pathname).toBe('/api/v1/query');
    expect(url.searchParams.get('query')).toBe('sum(node_load1)');
    expect(url.searchParams.get('time')).toBe('1700000100');
    // trailing slash on baseUrl is stripped (no //api)
    expect(url.host).toBe('prom:9090');
  });

  it('throws on a non-OK HTTP status', async () => {
    const client = createPrometheusClient({ baseUrl: 'http://prom:9090', fetchImpl: fetchMock({}, false, 503) });
    await expect(client.query('up')).rejects.toThrow(/HTTP 503/);
  });

  it('throws on an unexpected response shape', async () => {
    const client = createPrometheusClient({
      baseUrl: 'http://prom:9090',
      fetchImpl: fetchMock({ status: 'success', data: { foo: 1 } }),
    });
    await expect(client.query('up')).rejects.toThrow(/unexpected shape/);
  });
});

describe('createPrometheusClient.queryRange (range)', () => {
  it('GETs /api/v1/query_range with start/end/step, parses the matrix', async () => {
    const fetchImpl = fetchMock(MATRIX_OK);
    const client = createPrometheusClient({ baseUrl: 'http://prom:9090', fetchImpl });
    const out = await client.queryRange('up', 1000, 2000, 60);
    expect(out[0]?.values[0]?.[1]).toBe('42');
    const url = calledUrl(fetchImpl);
    expect(url.pathname).toBe('/api/v1/query_range');
    expect(url.searchParams.get('start')).toBe('1000');
    expect(url.searchParams.get('end')).toBe('2000');
    expect(url.searchParams.get('step')).toBe('60');
  });
});

describe('prometheusClientFromEnv', () => {
  it('defaults to the in-cluster service when PROMETHEUS_URL is unset', () => {
    expect(PROMETHEUS_DEFAULT_URL).toContain('kube-prometheus-stack-prometheus.observability');
    const client = prometheusClientFromEnv({});
    expect(typeof client.query).toBe('function');
    expect(typeof client.queryRange).toBe('function');
  });

  it('honours PROMETHEUS_URL when set', async () => {
    const fetchImpl = fetchMock(VECTOR_OK);
    const client = createPrometheusClient({ baseUrl: 'http://stub:9999', fetchImpl });
    await client.query('up');
    expect(calledUrl(fetchImpl).host).toBe('stub:9999');
  });
});
