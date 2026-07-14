// ADR-019 / DESIGN-008 D-14 — the authed poster PROXY contract, end to end against the stub
// stack (no new UI required). A signed-in member requests /api/posters/{id} for a seeded item
// (posterSource='arr'); the route streams the *arr MediaCover variant server-side (the stub
// serves the fixture PNG). Guards: unauthenticated → 401, unknown id → 404 (→ KindIcon in the UI).
import { test, expect } from '@playwright/test';
import { signIn } from './support/helpers';

/** Resolve a seeded item's media_item_id by opening its card and reading the detail URL. */
async function seededItemId(page: import('@playwright/test').Page): Promise<string> {
  await page.goto('/library');
  const card = page.locator('.media-card').filter({ hasText: 'The Fixture' });
  await expect(card).toHaveCount(1);
  await card.click();
  await page.waitForURL(/\/library\/[0-9a-f-]{36}$/);
  return page.url().split('/').pop()!;
}

test.describe('poster proxy (ADR-019)', () => {
  test('streams a seeded item poster as an image for a signed-in member', async ({ page }) => {
    await signIn(page, 'member');
    const id = await seededItemId(page);

    const res = await page.request.get(`/api/posters/${id}`);
    expect(res.status()).toBe(200);
    expect(res.headers()['content-type']).toContain('image/');
    // The route sets a private cache + an ETag from the poster ref.
    expect(res.headers()['cache-control']).toContain('private');
    expect(res.headers()['etag']).toBeTruthy();
    expect((await res.body()).byteLength).toBeGreaterThan(0);
  });

  test('unknown id → 404 (the UI falls back to the KindIcon, never a broken image)', async ({
    page,
  }) => {
    await signIn(page, 'member');
    const res = await page.request.get('/api/posters/00000000-0000-4000-8000-000000000000');
    expect(res.status()).toBe(404);
  });

  test('unauthenticated request is rejected (session-gated, not a public endpoint)', async ({
    browser,
    baseURL,
  }) => {
    // A fresh context carries no session cookie.
    const ctx = await browser.newContext({ baseURL });
    const res = await ctx.request.get('/api/posters/00000000-0000-4000-8000-000000000000');
    expect(res.status()).toBe(401);
    await ctx.close();
  });
});

// DESIGN-026 D-04 amendment (group-card art) — the ABS author-portrait sibling proxy carries the
// SAME gates as its parent /api/books/cover: session (401) and the books section (404 when
// disabled — a default member can't probe author art), with the stubbed image streaming for an
// admin. The tier/ETag behavior is unit-tested (author-image-route.test.ts).
test.describe('author-image proxy (group-card art)', () => {
  const AUTHOR_QS = 'id=aa900d1c-0000-4000-8000-000000000001&v=1783700000001'; // stub Dickens

  test('unauthenticated request is rejected with 401', async ({ browser, baseURL }) => {
    const ctx = await browser.newContext({ baseURL });
    const res = await ctx.request.get(`/api/books/author-image?${AUTHOR_QS}`);
    expect(res.status()).toBe(401);
    await ctx.close();
  });

  test('a books-disabled member gets 404 (section-gated like the cover proxy)', async ({ page }) => {
    await signIn(page, 'member');
    const res = await page.request.get(`/api/books/author-image?${AUTHOR_QS}`);
    expect(res.status()).toBe(404);
  });

  test('an admin streams the sized author portrait with the strong ETag', async ({ page }) => {
    await signIn(page, 'admin');
    const res = await page.request.get(`/api/books/author-image?${AUTHOR_QS}`);
    expect(res.status()).toBe(200);
    expect(res.headers()['content-type']).toContain('image/');
    expect(res.headers()['cache-control']).toContain('private');
    expect(res.headers()['etag']).toBeTruthy();
    expect((await res.body()).byteLength).toBeGreaterThan(0);
  });
});
