import { describe, expect, it } from 'vitest';
import { GET } from '../../app/api/health/route';

describe('GET /api/health', () => {
  it('returns 200 ok without touching the database', async () => {
    const res = GET();
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ status: 'ok' });
  });
});
