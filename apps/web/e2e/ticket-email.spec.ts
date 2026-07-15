// ADR-060 / DESIGN-031 D-08 (PLAN-035) — ticket EMAIL notifications end to end, against the
// hermetic stack (embedded PG16 + stub OIDC + the stub SMTP server):
//
//   • the MEMBER opts into ticket-update emails via the user-menu toggle (R-196, default OFF);
//   • the member files a ticket → the UNCONDITIONAL admin email row is enqueued (R-195);
//   • the ADMIN replies on the ticket → the author opt-in email row is enqueued;
//   • the real `notify-outbox` sync mode drains BOTH rows over real SMTP to the stub
//     (the production wire path: nodemailer submission → 220/EHLO/AUTH/MAIL/RCPT/DATA);
//   • the recorder proves recipients + subjects; the member's OWN earlier reply produced nothing.
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { test, expect, type Page } from '@playwright/test';
import { signIn } from './support/helpers';
import { readRuntimeEnv } from './support/env';
import type { RecordedMail } from './support/stub-smtp';

function runNotifyOutbox(): void {
  const env = readRuntimeEnv();
  const run = spawnSync(
    join(process.cwd(), 'node_modules', '.bin', 'tsx'),
    [join(process.cwd(), '..', '..', 'packages', 'sync', 'src', 'scripts', 'sync.ts'), '--mode=notify-outbox'],
    { env: { ...process.env, ...env }, stdio: 'inherit', cwd: process.cwd() },
  );
  expect(run.status, 'notify-outbox subprocess must succeed').toBe(0);
}

async function sentMails(): Promise<RecordedMail[]> {
  const env = readRuntimeEnv();
  const res = await fetch(`${env.STUB_SMTP_URL}/_stub/messages`);
  expect(res.ok).toBe(true);
  return ((await res.json()) as { messages: RecordedMail[] }).messages;
}

async function resetMails(): Promise<void> {
  const env = readRuntimeEnv();
  await fetch(`${env.STUB_SMTP_URL}/_stub/reset`, { method: 'POST' });
}

/** Assign the Marge Member persona's user to a role by name (the helpdesk.spec idiom). */
async function assignMemberRole(adminPage: Page, roleLabel: string): Promise<void> {
  await adminPage.goto('/admin');
  await adminPage.getByRole('link', { name: 'Marge Member' }).click();
  await expect(adminPage.getByRole('heading', { name: 'Marge Member' })).toBeVisible();
  const settled = adminPage.waitForResponse((r) => r.url().includes('users.setRole'));
  await adminPage.locator('#user-role').selectOption({ label: roleLabel });
  await settled;
}

test.describe('ticket email notifications (ADR-060 / PLAN-035)', () => {
  test('opt-in toggle → admin creation email + author reply email over real SMTP', async ({
    page,
    browser,
  }) => {
    test.setTimeout(150_000);
    await signIn(page, 'admin');
    const memberContext = await browser.newContext();
    const memberPage = await memberContext.newPage();
    await signIn(memberPage, 'member');
    await assignMemberRole(page, 'Bulletin Poster');
    await resetMails();

    // ── the MEMBER opts in via the user-menu toggle (R-196; default OFF) ──
    await memberPage.goto('/');
    await memberPage.getByRole('button', { name: /Marge Member/ }).click();
    const toggle = memberPage.getByTestId('email-updates-toggle');
    await expect(toggle).toBeVisible();
    const box = toggle.locator('input[type="checkbox"]');
    await expect(box).not.toBeChecked(); // the default is OFF
    const saved = memberPage.waitForResponse((r) => r.url().includes('setNotificationPreference'));
    await box.click();
    await saved;
    await expect(box).toBeChecked();

    // ── the member FILES a ticket (enqueues the unconditional admin email — R-195) ──
    await memberPage.goto('/bulletin');
    await memberPage.getByTestId('ticket-new').click();
    await memberPage.getByTestId('ticket-title').fill('Subtitles missing on everything');
    await memberPage.getByTestId('ticket-category-playback').click();
    await memberPage.getByTestId('ticket-body').fill('No subtitle tracks listed since yesterday.');
    await memberPage.getByTestId('ticket-create').click();
    await memberPage.waitForURL(/\/bulletin\/ticket\/[0-9a-f-]{36}$/);
    const ticketUrl = new URL(memberPage.url()).pathname;

    // The member's OWN reply — must email nobody (R-196 self-action guard).
    await memberPage.getByTestId('reply-body').fill('Adding: same on my phone.');
    await memberPage.getByTestId('reply-send').click();
    await expect(memberPage.getByTestId('ticket-reply')).toHaveCount(1);

    // ── the ADMIN replies (enqueues the author's opt-in email) ──
    await page.goto(ticketUrl);
    await page.getByTestId('reply-body').fill('Known issue — Bazarr resync running now.');
    await page.getByTestId('reply-send').click();
    await expect(page.getByTestId('ticket-reply')).toHaveCount(2);

    // ── drain over REAL SMTP to the stub and prove the deliveries ──
    runNotifyOutbox();
    const mails = await sentMails();
    const admin = mails.filter((m) => m.to.includes('admin@haynesnetwork.com'));
    expect(admin, 'the unconditional ticket-created admin email').toHaveLength(1);
    expect(admin[0]!.data).toContain('New ticket: Subtitles missing on everything');

    const author = mails.filter((m) => m.to.includes('member@example.test'));
    expect(author, 'exactly ONE author email — the admin reply, never the self-reply').toHaveLength(1);
    expect(author[0]!.data).toContain('Re: Subtitles missing on everything');
    expect(author[0]!.data).toContain('Bazarr resync');

    expect(mails).toHaveLength(2);
    await memberContext.close();
  });
});
