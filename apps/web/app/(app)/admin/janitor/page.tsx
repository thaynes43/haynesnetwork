'use client';

// ADR-083 / DESIGN-046 D-08 (PLAN-065) — /admin/janitor: the queue-janitor surface. Admin-only (the AdminLayout
// gate). READ: one promotion-ladder readout per family (level, age, next criteria, the stagnation nag; DESIGN-046
// D-17), the resolved config with its source (saved vs all-census defaults), and a last-7-days census/action summary.
// WRITE: the DB-backed audited config as ONE form with ONE Save. A save whose diff contains any census→enforce
// escalation swaps the plain Save for the ConfirmButton two-step (ADR-014) — turning enforcement ON is the one
// consequential act on this page; turning it off or tuning knobs is not.
//
// ADR-095 (DESIGN-046 D-15..D-20) adds the download suite: LazyLibrarian and Kapowarr get their own grid (the
// "Books and comics" family grids) beside the *arr grid, inside the same form, so one Save covers every cell.
//
// Reflow-safe (ADR-015 / hard rule 9): mode cells reserve the width of the wider label so a toggle recolors
// without shifting the grid; the save-status slot is reserved; the ladder pill holds its footprint. Tokens
// only (hard rule 2).

import { useState } from 'react';
import { ConfirmButton } from '@hnet/ui';
import { trpc } from '@/lib/trpc-client';
import { describeMutationError } from '@/lib/app-error';

const INSTANCES = ['sonarr', 'radarr', 'lidarr', 'lazylibrarian', 'kapowarr'] as const;
type Instance = (typeof INSTANCES)[number];
/** Every class with a cell somewhere. */
type EnforceableClass = 'have_better' | 'retry_import' | 'bad_release' | 'manual_match' | 'leftover';
/** The cells each app has, mirroring QUEUE_CLEANUP_INSTANCE_CLASSES in @hnet/domain. */
const INSTANCE_CLASSES: Record<Instance, readonly EnforceableClass[]> = {
  sonarr: ['have_better', 'retry_import', 'bad_release'],
  radarr: ['have_better', 'retry_import', 'bad_release'],
  lidarr: ['have_better', 'retry_import', 'bad_release', 'manual_match'],
  lazylibrarian: ['retry_import', 'bad_release', 'leftover'],
  kapowarr: ['bad_release'],
};
/** The report-only classes: no enforce cell, never acted on. */
type ReportOnlyClass = 'fail_loop' | 'unknown';
/** Which apps report a report-only class (the others show "Not used"). */
const REPORT_ONLY_INSTANCES: Record<ReportOnlyClass, readonly Instance[]> = {
  fail_loop: ['lazylibrarian'],
  unknown: INSTANCES,
};
type Mode = 'census' | 'enforce';
type ModeMatrix = Record<Instance, Partial<Record<EnforceableClass, Mode>>>;

/** A grid of the form: its apps (columns) and its rows. */
interface GridSpec {
  id: 'arr' | 'suite';
  title: string;
  instances: readonly Instance[];
  classes: readonly EnforceableClass[];
  reportOnly: readonly ReportOnlyClass[];
  hints: Partial<Record<EnforceableClass | ReportOnlyClass, string>>;
}

const INSTANCE_LABEL: Record<Instance, string> = {
  sonarr: 'Sonarr',
  radarr: 'Radarr',
  lidarr: 'Lidarr',
  lazylibrarian: 'LazyLibrarian',
  kapowarr: 'Kapowarr',
};

const CLASS_LABEL: Record<EnforceableClass | ReportOnlyClass, string> = {
  have_better: 'Already have it',
  retry_import: 'Retry the import',
  bad_release: 'Bad release',
  manual_match: 'Needs a manual match',
  leftover: 'Leftover download',
  fail_loop: 'Keeps failing',
  unknown: 'Unknown reason',
};

const GRIDS: readonly GridSpec[] = [
  {
    id: 'arr',
    title: 'Sonarr, Radarr and Lidarr',
    instances: ['sonarr', 'radarr', 'lidarr'],
    classes: ['have_better', 'retry_import', 'bad_release', 'manual_match'],
    reportOnly: ['unknown'],
    hints: {
      have_better:
        'The library already holds this at equal or better quality. Enforcing removes the download and blocklists the release. Nothing is searched again.',
      retry_import:
        'A completed download stuck short of importing. Enforcing asks the app to re-run its import pass, then escalates if it stays stuck.',
      bad_release:
        'A failed or defective release. Enforcing blocklists it and searches once for a replacement while the item is still monitored. On Sonarr and Radarr it also searches once after a download fails, as long as the app is not set to search again by itself. An item that fails twice within 30 days is listed in the nightly digest and left alone until 30 days have passed since its first try.',
      manual_match:
        'Lidarr could not match the downloaded files to the album closely enough to import them. Enforcing blocks that release name in Lidarr, removes the download and searches for the album again while it is monitored and still missing tracks. An album that fails this way twice within 30 days is listed in the nightly digest and left for a manual import until 30 days have passed since its first removal.',
      unknown: 'Report only. The janitor never acts on a reason it does not recognize.',
    },
  },
  {
    id: 'suite',
    title: 'Books and comics',
    instances: ['lazylibrarian', 'kapowarr'],
    classes: ['retry_import', 'bad_release', 'leftover'],
    reportOnly: ['fail_loop', 'unknown'],
    hints: {
      retry_import:
        'A finished download LazyLibrarian has not imported. Enforcing asks LazyLibrarian to run its import pass again, then treats the download as a bad release if it stays stuck.',
      bad_release:
        'A failed download the app has not cleared. On LazyLibrarian, enforcing deletes the job from SABnzbd so LazyLibrarian marks it failed and wants the book again. On Kapowarr, it removes the download, blocklists it and searches the volume again while it is monitored. Torrents are never touched, so they keep seeding.',
      leftover:
        'The SABnzbd folder of a book LazyLibrarian has already imported. Enforcing deletes the folder once every library copy is confirmed on disk. Nothing is searched.',
      fail_loop:
        'Report only. A book still wanted after five or more failed grabs in LazyLibrarian’s own searches. Listed in the nightly digest.',
      unknown: 'Report only. The janitor never acts on a reason it does not recognize.',
    },
  },
];

/** The ladder families' names (DESIGN-046 D-17). */
const FAMILY_LABEL: Record<string, string> = {
  arr: 'Sonarr, Radarr and Lidarr',
  books: 'Books (LazyLibrarian)',
  comics: 'Comics (Kapowarr)',
};

/** One cell's mode, or null when the app has no cell for the class. */
function cellMode(m: ModeMatrix, instance: Instance, klass: EnforceableClass): Mode | null {
  if (!INSTANCE_CLASSES[instance].includes(klass)) return null;
  return m[instance]?.[klass] ?? 'census';
}

interface KnobDraft {
  maxActionsPerRun: string;
  minItemAgeHours: string;
  retryEscalateRuns: string;
}

const intOrNaN = (s: string): number => (/^-?\d+$/.test(s.trim()) ? Number(s) : NaN);

/** A full copy of the matrix: every app and every cell present (an absent cell reads as census, as in the domain). */
function cloneMatrix(m: Partial<Record<Instance, Partial<Record<EnforceableClass, Mode>>>>): ModeMatrix {
  const out = {} as ModeMatrix;
  for (const instance of INSTANCES) {
    out[instance] = {};
    for (const klass of INSTANCE_CLASSES[instance]) out[instance][klass] = m[instance]?.[klass] ?? 'census';
  }
  return out;
}

function LadderPill({ level, due }: { level: number; due: boolean }) {
  const label = level === 0 ? 'L0 · census' : level === 1 ? `L${level} · partial` : `L${level} · enforced`;
  return (
    <span className={`janitor-pill ${due ? 'janitor-pill--due' : `janitor-pill--l${Math.min(level, 2)}`}`}>
      {label}
    </span>
  );
}

export default function AdminJanitorPage() {
  const utils = trpc.useUtils();
  const status = trpc.queueCleanup.status.useQuery();
  const [modesDraft, setModesDraft] = useState<ModeMatrix | null>(null);
  const [knobsDraft, setKnobsDraft] = useState<KnobDraft | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const save = trpc.queueCleanup.config.set.useMutation({
    onError: (err) => {
      setError(describeMutationError(err));
      setSaved(false);
    },
    onSuccess: () => {
      setError(null);
      setSaved(true);
      setModesDraft(null);
      setKnobsDraft(null);
    },
    onSettled: () => void utils.queueCleanup.status.invalidate(),
  });

  const data = status.data;
  const cfg = data?.config;
  const serverModes: ModeMatrix | null = cfg
    ? cloneMatrix(cfg.modes as Partial<Record<Instance, Partial<Record<EnforceableClass, Mode>>>>)
    : null;
  const serverKnobs: KnobDraft | null = cfg
    ? {
        maxActionsPerRun: String(cfg.maxActionsPerRun),
        minItemAgeHours: String(cfg.minItemAgeHours),
        retryEscalateRuns: String(cfg.retryEscalateRuns),
      }
    : null;
  const modes = modesDraft ?? serverModes;
  const knobs = knobsDraft ?? serverKnobs;

  const toggleCell = (instance: Instance, klass: EnforceableClass) => {
    if (!modes) return;
    const current = cellMode(modes, instance, klass);
    if (current === null) return;
    setSaved(false);
    const next = cloneMatrix(modes);
    next[instance][klass] = current === 'census' ? 'enforce' : 'census';
    setModesDraft(next);
  };

  const patchKnobs = (next: Partial<KnobDraft>) => {
    if (!knobs) return;
    setSaved(false);
    setKnobsDraft({ ...knobs, ...next });
  };

  const cap = knobs ? intOrNaN(knobs.maxActionsPerRun) : NaN;
  const age = knobs ? intOrNaN(knobs.minItemAgeHours) : NaN;
  const esc = knobs ? intOrNaN(knobs.retryEscalateRuns) : NaN;

  // Mirror the domain writer's invariants (queueCleanupConfigError) so Save can never submit an unstorable set.
  const invalidMsg: string | null = !knobs
    ? null
    : !(cap >= 1 && cap <= 100)
      ? 'Actions per run must be 1 to 100.'
      : !(age >= 0 && age <= 168)
        ? 'Minimum age must be 0 to 168 hours.'
        : !(esc >= 1 && esc <= 48)
          ? 'Escalate after must be 1 to 48 runs.'
          : null;

  // The cells this save would flip census→enforce. Enforcing is the consequential direction (ADR-014):
  // it is what turns automated mutations on, so it alone earns the two-step confirm.
  const escalations: string[] = [];
  if (modes && serverModes) {
    for (const instance of INSTANCES) {
      for (const klass of INSTANCE_CLASSES[instance]) {
        if (
          cellMode(serverModes, instance, klass) === 'census' &&
          cellMode(modes, instance, klass) === 'enforce'
        ) {
          escalations.push(`${INSTANCE_LABEL[instance]}: ${CLASS_LABEL[klass]}`);
        }
      }
    }
  }

  const dirty =
    (modes !== null &&
      serverModes !== null &&
      JSON.stringify(modes) !== JSON.stringify(serverModes)) ||
    (knobs !== null && serverKnobs !== null && JSON.stringify(knobs) !== JSON.stringify(serverKnobs));
  const canSave = modes !== null && knobs !== null && invalidMsg === null && dirty && !save.isPending;

  const doSave = () => {
    if (!canSave || !modes || !knobs) return;
    const m = (instance: Instance, klass: EnforceableClass): Mode => cellMode(modes, instance, klass) ?? 'census';
    save.mutate({
      modes: {
        sonarr: { have_better: m('sonarr', 'have_better'), retry_import: m('sonarr', 'retry_import'), bad_release: m('sonarr', 'bad_release') },
        radarr: { have_better: m('radarr', 'have_better'), retry_import: m('radarr', 'retry_import'), bad_release: m('radarr', 'bad_release') },
        lidarr: {
          have_better: m('lidarr', 'have_better'),
          retry_import: m('lidarr', 'retry_import'),
          bad_release: m('lidarr', 'bad_release'),
          manual_match: m('lidarr', 'manual_match'),
        },
        lazylibrarian: {
          retry_import: m('lazylibrarian', 'retry_import'),
          bad_release: m('lazylibrarian', 'bad_release'),
          leftover: m('lazylibrarian', 'leftover'),
        },
        kapowarr: { bad_release: m('kapowarr', 'bad_release') },
      },
      maxActionsPerRun: cap,
      minItemAgeHours: age,
      retryEscalateRuns: esc,
    });
  };

  const ladders = data?.ladders ?? [];
  const summary = data?.summary ?? [];
  const summaryCell = (instance: Instance, klass: EnforceableClass | ReportOnlyClass) =>
    summary.find((s) => s.instance === instance && s.actionClass === klass) ?? null;

  return (
    <>
      <div className="admin-head">
        <h1>Queue janitor</h1>
      </div>
      <p className="muted">
        The janitor sweeps stuck and failed downloads out of Sonarr, Radarr, Lidarr, LazyLibrarian and Kapowarr
        every hour. It starts in census, where it only records what it would do. Each class of problem is promoted
        to enforcement per app, one audited flip at a time.
      </p>

      {status.isLoading ? <p className="muted">Loading…</p> : null}

      {/* Ladders, one per family (DESIGN-046 D-17). */}
      {ladders.length > 0 ? (
        <section className="card janitor" data-testid="janitor-ladder" aria-label="Promotion ladders">
          <h2>Promotion ladders</h2>
          {ladders.map((ladder) => (
            <div className="janitor-ladder" key={ladder.family} data-testid={`janitor-ladder-${ladder.family}`}>
              <div className="janitor__head">
                <h3>{FAMILY_LABEL[ladder.family] ?? ladder.family}</h3>
                <LadderPill level={ladder.level} due={ladder.promotionDue} />
              </div>
              <p className="muted janitor__age">
                {ladder.ageDays === null
                  ? 'Never changed. These apps run on the all-census defaults.'
                  : `Last changed ${ladder.ageDays} ${ladder.ageDays === 1 ? 'day' : 'days'} ago.`}
              </p>
              {ladder.promotionDue ? (
                <p className="alert" role="status" data-testid={`janitor-nag-${ladder.family}`}>
                  Promotion is due. Review the census evidence below and either advance this ladder or record a
                  blocker in the build plan.
                </p>
              ) : null}
              <p className="janitor__criteria">{ladder.nextCriteria}</p>
            </div>
          ))}
        </section>
      ) : null}

      {/* Mode grids + knobs: one form, one Save. */}
      {cfg && modes && knobs ? (
        <section className="card janitor" data-testid="janitor-config" aria-label="Janitor config">
          <h2>Enforcement</h2>
          <p className="muted">
            {data?.source === 'db'
              ? 'Saved config. Every save is audited.'
              : 'Running on the all-census defaults. The first save takes over, audited.'}
          </p>
          {error ? (
            <p className="alert" role="alert">
              {error}
            </p>
          ) : null}

          {GRIDS.map((grid) => (
            <div className="janitor-grid-block" key={grid.id}>
              <h3>{grid.title}</h3>
              <div className="janitor-grid-wrap">
                <table
                  className="janitor-grid"
                  data-testid={grid.id === 'arr' ? 'janitor-mode-grid' : `janitor-mode-grid-${grid.id}`}
                >
                  <thead>
                    <tr>
                      <th scope="col">Problem class</th>
                      {grid.instances.map((i) => (
                        <th key={i} scope="col">
                          {INSTANCE_LABEL[i]}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {grid.classes.map((klass) => (
                      <tr key={klass}>
                        <th scope="row">
                          <span className="janitor-grid__class">{CLASS_LABEL[klass]}</span>
                          <span className="field-hint">{grid.hints[klass]}</span>
                        </th>
                        {grid.instances.map((instance) => {
                          const mode = cellMode(modes, instance, klass);
                          if (mode === null) {
                            // This app never reports the class, so it has no cell for it.
                            return (
                              <td key={instance}>
                                <span className="janitor-mode janitor-mode--fixed">Not used</span>
                              </td>
                            );
                          }
                          return (
                            <td key={instance}>
                              <button
                                type="button"
                                className={`janitor-mode janitor-mode--${mode}`}
                                data-testid={`janitor-cell-${instance}-${klass}`}
                                aria-pressed={mode === 'enforce'}
                                aria-label={`${CLASS_LABEL[klass]} on ${INSTANCE_LABEL[instance]}: ${mode}`}
                                onClick={() => toggleCell(instance, klass)}
                              >
                                {mode === 'census' ? 'Census' : 'Enforce'}
                              </button>
                            </td>
                          );
                        })}
                      </tr>
                    ))}
                    {grid.reportOnly.map((klass) => (
                      <tr key={klass}>
                        <th scope="row">
                          <span className="janitor-grid__class">{CLASS_LABEL[klass]}</span>
                          <span className="field-hint">{grid.hints[klass]}</span>
                        </th>
                        {grid.instances.map((instance) => (
                          <td key={instance}>
                            <span className="janitor-mode janitor-mode--fixed">
                              {REPORT_ONLY_INSTANCES[klass].includes(instance) ? 'Report only' : 'Not used'}
                            </span>
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          ))}

          <div className="janitor-knobs">
            <label className="field janitor-knob">
              <span>Actions per run</span>
              <input
                type="number"
                min={1}
                max={100}
                value={knobs.maxActionsPerRun}
                data-testid="janitor-cap"
                aria-label="Actions per run"
                onChange={(e) => patchKnobs({ maxActionsPerRun: e.target.value })}
              />
              <span className="field-hint">
                The most mutations one hourly run may make per app. A runaway rule can never empty a queue in
                one pass.
              </span>
            </label>
            <label className="field janitor-knob">
              <span>Minimum age (hours)</span>
              <input
                type="number"
                min={0}
                max={168}
                value={knobs.minItemAgeHours}
                data-testid="janitor-age"
                aria-label="Minimum age in hours"
                onChange={(e) => patchKnobs({ minItemAgeHours: e.target.value })}
              />
              <span className="field-hint">
                Freshly finished downloads get this long to import on their own before the janitor may touch
                them.
              </span>
            </label>
            <label className="field janitor-knob">
              <span>Escalate after (runs)</span>
              <input
                type="number"
                min={1}
                max={48}
                value={knobs.retryEscalateRuns}
                data-testid="janitor-escalate"
                aria-label="Escalate after this many runs"
                onChange={(e) => patchKnobs({ retryEscalateRuns: e.target.value })}
              />
              <span className="field-hint">
                An import still stuck after this many retry passes is treated as a bad release instead.
              </span>
            </label>
          </div>

          <div className="form-actions janitor__save">
            {escalations.length > 0 ? (
              <ConfirmButton
                className="btn primary"
                data-testid="janitor-save"
                disabled={!canSave}
                label={save.isPending ? 'Saving…' : 'Save'}
                confirmLabel={`Enforce ${escalations.length} ${escalations.length === 1 ? 'cell' : 'cells'}?`}
                restingAriaLabel={`Save janitor config, enabling enforcement for ${escalations.join(', ')}. Click twice to confirm.`}
                confirmAriaLabel={`Confirm: enable enforcement for ${escalations.join(', ')}`}
                onConfirm={doSave}
              />
            ) : (
              <button
                type="button"
                className="btn primary"
                data-testid="janitor-save"
                disabled={!canSave}
                onClick={doSave}
              >
                {save.isPending ? 'Saving…' : 'Save'}
              </button>
            )}
            {/* Reserved status slot — text recolors, never reflows (ADR-015). */}
            <span className="janitor__status" role="status">
              {invalidMsg ?? (saved ? 'Saved' : dirty ? 'Unsaved' : ' ')}
            </span>
          </div>
        </section>
      ) : null}

      {/* Last 7 days */}
      {status.isSuccess ? (
        <section className="card janitor" data-testid="janitor-summary" aria-label="Last seven days">
          <h2>Last 7 days</h2>
          {summary.length === 0 ? (
            <p className="muted">
              No janitor runs recorded yet. The census appears here after the first hourly run.
            </p>
          ) : (
            GRIDS.map((grid) => (
              <div className="janitor-grid-block" key={grid.id}>
                <h3>{grid.title}</h3>
                <div className="janitor-grid-wrap">
                  <table className="janitor-grid janitor-grid--summary">
                    <thead>
                      <tr>
                        <th scope="col">Problem class</th>
                        {grid.instances.map((i) => (
                          <th key={i} scope="col">
                            {INSTANCE_LABEL[i]}
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {[...grid.classes, ...grid.reportOnly].map((klass) => (
                        <tr key={klass}>
                          <th scope="row">{CLASS_LABEL[klass]}</th>
                          {grid.instances.map((instance) => {
                            const cell = summaryCell(instance, klass);
                            return (
                              <td key={instance}>
                                {cell ? (
                                  <>
                                    {cell.observed} seen
                                    {cell.enforced > 0 ? (
                                      <span className="janitor-grid__enforced"> · {cell.enforced} handled</span>
                                    ) : null}
                                  </>
                                ) : (
                                  <span className="muted">0</span>
                                )}
                              </td>
                            );
                          })}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            ))
          )}
        </section>
      ) : null}
    </>
  );
}
