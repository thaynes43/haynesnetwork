'use client';

// ADR-110 C-03, C-04, C-08, ADR-113 / DESIGN-055 D-04 rule 10, D-05 (PLAN-077 P4) — two cards on /admin/fixes:
//   • the Mislabel Block: every term the app keeps in Sonarr's "mislabelled releases" profile (one per series and release
//     group, or per series and mislabelled name: a number with the wrong title, a double episode, another title of the
//     show), the series linked to its title page, with an inline two-step Remove (hard rule 8: the @hnet/ui
//     ConfirmButton, never window.confirm). Remove writes the profile without the term and reads it back first;
//   • the Title Check census: how imported file names compared with their episodes, the open flags, and the newest of
//     them linked to the title page, where the live flag names both episodes.
// Reflow-safe (hard rule 9): each row's action cell reserves the armed label's width, and a remove's answer replaces the
// button in that same cell. Tokens only (hard rule 2). Copy follows the owner's rules.
import Link from 'next/link';
import { useState } from 'react';
import { ConfirmButton } from '@hnet/ui';
import { trpc } from '@/lib/trpc-client';
import { describeMutationError } from '@/lib/app-error';
import { episodeLabelOf } from '@/lib/remap-guide';

const dateOnly = (value: string | Date): string => {
  const d = new Date(value);
  return Number.isNaN(d.getTime())
    ? String(value)
    : d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
};

const STATE_LABELS: Record<string, string> = { active: 'Active', expired: 'Expired', removed: 'Removed' };

/** ADR-113 — what a term blocks, in a few words after it: a release group, or one kind of mislabelled name. */
const KIND_LABELS: Record<string, string> = {
  group: 'release group',
  pair: 'episode with the wrong title',
  double: 'double episode',
  alias: 'other title of the show',
};

const ORIGIN_LABELS: Record<string, string> = { adoption: 'added by hand', staff: 'added by staff' };

/** The term's blocked text: its group, or its name (`S01E11 Secret Menu`, `S01E13E14`, an alternate title). */
const blockedText = (t: { releaseGroup: string | null; nameToken: string | null }): string =>
  t.releaseGroup ?? t.nameToken ?? '';

/** The Mislabel Block terms: the active ones with Remove, the ended ones below them, muted. */
export function MislabelBlockCard() {
  const utils = trpc.useUtils();
  const terms = trpc.fix.mislabelTerms.useQuery(undefined, { retry: false });
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const remove = trpc.fix.removeMislabelTerm.useMutation({
    onError: (err, variables) => setAnswers((a) => ({ ...a, [variables.termId]: describeMutationError(err) })),
    onSuccess: (r, variables) => {
      setAnswers((a) => ({ ...a, [variables.termId]: r.removed ? 'Removed.' : `Not removed. ${r.message}` }));
      void utils.fix.mislabelTerms.invalidate();
    },
  });

  const all = terms.data?.terms ?? [];
  const active = all.filter((t) => t.state === 'active');
  const ended = all.filter((t) => t.state !== 'active');

  return (
    <section className="card repair-admin-card" aria-labelledby="mislabel-block-title">
      <h2 id="mislabel-block-title">Mislabel Block</h2>
      <p className="muted">
        Release groups and release names that filed a show&rsquo;s episodes in the wrong place. Sonarr skips a blocked
        group&rsquo;s releases of that one show, and any release of it that carries a blocked name; other groups and
        other shows are not affected. A term ends on its own after a year.
      </p>
      {terms.isLoading ? (
        <p className="muted">Loading the terms…</p>
      ) : terms.error ? (
        <p className="alert" role="alert">
          Failed to load the Mislabel Block: {terms.error.message}
        </p>
      ) : active.length === 0 ? (
        <p className="muted">Nothing is blocked right now.</p>
      ) : (
        <ul className="mislabel-terms">
          {active.map((t) => (
            <li key={t.id} className="mislabel-terms__row">
              <span className="mislabel-terms__what">
                {t.mediaItemId ? (
                  <Link className="row-link" href={`/library/${t.mediaItemId}`}>
                    {t.seriesTitle}
                  </Link>
                ) : (
                  t.seriesTitle
                )}
                <span>
                  <code>{blockedText(t)}</code>
                  <span className="muted">
                    {' '}
                    {KIND_LABELS[t.kind] ?? t.kind},{' '}
                    {ORIGIN_LABELS[t.origin] ??
                      (t.createdByName ? `from a fix by ${t.createdByName}` : 'from a fix')}
                  </span>
                </span>
                <span className="muted mislabel-terms__dates">
                  Added {dateOnly(t.createdAt)} · ends {dateOnly(t.expiresAt)}
                </span>
              </span>
              <span className="mislabel-terms__action">
                {answers[t.id] ? (
                  <span className="muted" role="status">
                    {answers[t.id]}
                  </span>
                ) : (
                  <ConfirmButton
                    className="btn sm"
                    label="Remove"
                    confirmLabel="Confirm remove"
                    restingAriaLabel={`Remove the block on ${blockedText(t)} for ${t.seriesTitle}, click twice to confirm`}
                    confirmAriaLabel={`Confirm removing the block on ${blockedText(t)} for ${t.seriesTitle}`}
                    disabled={remove.isPending}
                    onConfirm={() => remove.mutate({ termId: t.id })}
                  />
                )}
              </span>
            </li>
          ))}
        </ul>
      )}
      {ended.length > 0 ? (
        <details className="mislabel-terms__ended">
          <summary className="muted">
            {ended.length === 1 ? '1 ended term' : `${ended.length} ended terms`}
          </summary>
          <ul className="repair-guide__facts">
            {ended.map((t) => (
              <li key={t.id} className="muted">
                {t.seriesTitle}: {blockedText(t)} ({STATE_LABELS[t.state] ?? t.state}, added {dateOnly(t.createdAt)})
              </li>
            ))}
          </ul>
        </details>
      ) : null}
    </section>
  );
}

/** The Title Check census: verdict counts, open flags, and the newest flags linked to their title pages. */
export function TitleCheckCard() {
  const summary = trpc.fix.titleCheckSummary.useQuery(undefined, { retry: false });
  const data = summary.data;
  return (
    <section className="card repair-admin-card" aria-labelledby="title-check-title">
      <h2 id="title-check-title">Title Check</h2>
      <p className="muted">
        Each episode Sonarr imports is checked against the title in its file name. Nothing is changed in Sonarr. A name
        that points at another episode of the season flags that episode on its title page, where anyone who can use Fix
        can move the file.
      </p>
      {summary.isLoading ? (
        <p className="muted">Loading the Title Check…</p>
      ) : summary.error || !data ? (
        <p className="alert" role="alert">
          Failed to load the Title Check: {summary.error?.message ?? 'no answer'}
        </p>
      ) : (
        <>
          <dl className="title-check__counts">
            <div>
              <dt>Name matches</dt>
              <dd>{data.counts.agrees}</dd>
            </div>
            <div>
              <dt>Names another episode</dt>
              <dd>{data.counts.disagrees}</dd>
            </div>
            <div>
              <dt>No title in the name</dt>
              <dd>{data.counts.silent}</dd>
            </div>
            <div>
              <dt>Unclear</dt>
              <dd>{data.counts.ambiguous}</dd>
            </div>
            <div>
              <dt>Open flags</dt>
              <dd>{data.openFlags}</dd>
            </div>
          </dl>
          {data.recentFlags.length === 0 ? (
            <p className="muted">No episode is flagged.</p>
          ) : (
            <ul className="repair-guide__facts title-check__flags">
              {data.recentFlags.map((f) => {
                const on = episodeLabelOf(f.seasonNumber, f.episodeNumber, null);
                const line =
                  f.bestEpisodeNumber !== null ? `${on}, its name says E${String(f.bestEpisodeNumber).padStart(2, '0')}` : on;
                return (
                  <li key={f.titleCheckId}>
                    {f.mediaItemId ? (
                      <Link className="row-link" href={`/library/${f.mediaItemId}`}>
                        {f.seriesTitle ?? `Series ${f.seriesId}`}
                      </Link>
                    ) : (
                      <span>{f.seriesTitle ?? `Series ${f.seriesId}`}</span>
                    )}{' '}
                    {line}
                    <span className="muted title-check__when"> · imported {dateOnly(f.importedAt)}</span>
                    <span className="muted repair-guide__release title-check__name">{f.sourceTitle}</span>
                  </li>
                );
              })}
            </ul>
          )}
        </>
      )}
    </section>
  );
}
