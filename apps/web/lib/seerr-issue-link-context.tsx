'use client';
// ADR-111 C-03 / DESIGN-055 D-10 (PLAN-077 P7) — the Seerr issue a Repair Guide was opened from (a report's banner on
// the title page, or the `/r/seerr/<id>` link's first visit). The guide's remedies send it with their mutation, so the
// Repair Request or Fix records which report it answers and the bridge can resolve that report once the repair has
// completed. The server keeps it only for an open report on the same title; outside a report's guide it is absent.
import { createContext, useContext } from 'react';

export const SeerrIssueLinkContext = createContext<number | null>(null);

/** Spread into a remedy's mutation input: `{ seerrIssueId }` inside a report's guide, `{}` everywhere else. */
export function useSeerrIssueLink(): { seerrIssueId?: number } {
  const id = useContext(SeerrIssueLinkContext);
  return id !== null ? { seerrIssueId: id } : {};
}
