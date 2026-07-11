// ADR-022 C-03 / DESIGN-009 D-06 — the emergency Ledger export. Streams the current filtered set
// as deterministic JSONL (content-disposition attachment) for catastrophic-failure recovery.
// Session-gated AND section-gated (mirrors the poster route's auth pattern): the caller's Ledger
// level must be at least Read-Only (Disabled → 403; server-authoritative, AC-13). @hnet/api parses
// the filter + streams keyset pages; this route only checks access and pipes the stream.
import {
  buildExportFilterFromParams,
  effectiveSectionLevel,
  resolveLibraryAccessGate,
  streamLedgerExportRows,
} from '@hnet/api';
import { getServerSession } from '@hnet/auth';
import { db } from '@hnet/db';

export const runtime = 'nodejs';

export async function GET(req: Request): Promise<Response> {
  const session = await getServerSession(req.headers);
  if (!session) return new Response('unauthorized', { status: 401 });
  // Read-Only and above may export; Disabled is the only level below Read-Only.
  if (effectiveSectionLevel(session.user.role, 'ledger') === 'disabled') {
    return new Response('forbidden', { status: 403 });
  }

  const filter = buildExportFilterFromParams(new URL(req.url).searchParams);
  // ADR-047 THE INVARIANT — the export is filtered to the caller's accessible Plex libraries (admin ⇒
  // unrestricted). An inaccessible item never lands in the JSONL.
  const gate = await resolveLibraryAccessGate(session.user.id, db);
  const encoder = new TextEncoder();
  const iterator = streamLedgerExportRows(db, filter, gate);
  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      const { value, done } = await iterator.next();
      if (done) controller.close();
      else controller.enqueue(encoder.encode(value));
    },
    async cancel() {
      await iterator.return?.(undefined);
    },
  });

  const stamp = new Date().toISOString().slice(0, 10);
  return new Response(stream, {
    status: 200,
    headers: {
      'Content-Type': 'application/x-ndjson; charset=utf-8',
      'Content-Disposition': `attachment; filename="ledger-export-${stamp}.jsonl"`,
      'Cache-Control': 'no-store',
    },
  });
}
