"""claude-schema-1 (dev-c8): the run-level half of the fail-closed guarantee (review round 6).  Loaded only when the run's adapter is the schema-mode
Claude adapter; every legacy path, record and byte is untouched.

THE INVARIANT, AND ITS SCOPE.  For a run whose adapter is in schema mode, no CLI output stream and no internal exception (an `Exception` raised while
parsing a reply, building or writing a record, accounting, finalising, or formatting another exception) can make the run:
  (a) lose the raw call output: it is kept as bytes before any parsing (`<run>/raw/<case>-<n>.raw`, and base64 in the record);
  (b) lose an established stop reason (a missing schema registration, a budget stop, an unmetered call, a fail-closed stop): a later failure is attached
      as `secondary_failure`, never in its place;
  (c) start another case or call after a stop: the stop is sticky on the adapter and checked before every case and every call;
  (d) exit 0 after a stop or with a call whose cost is unknown;
  (e) record `harness_crash` and go on: such a failure becomes a fail-closed stop.
NOT covered: process-control `BaseException`s (`KeyboardInterrupt`, `SystemExit`, `GeneratorExit`) and failures of the operating system or the file
system itself (a full disk, a read-only or vanished run directory, the process being killed); those can still end the run without the records above.
Records of a schema-mode run are written with `ensure_ascii=True`, so a lone surrogate can never make a write fail."""
import json

from . import adapters as A
from . import claude_schema as CS
from . import protocol as P

safe_str = CS.safe_str


# ---------------------------------------------------------------------------------------------------------------------------- reply parsing (Rule C)
def parse_reply(text):
    """P.parse_reply behind the same bounds as the stream: a reply that is not text, too long or nested too deep is an invalid reply (the ordinary repair
    path), and any other failure of the parse is too; nothing raises."""
    if not isinstance(text, str):
        return None, 'reply is not text', {}
    why = CS._prescan(text)
    if why is not None:
        return None, 'reply is over the bounds (%s)' % why, {}
    try:
        return P.parse_reply(text)
    except Exception as e:  # noqa: BLE001
        return None, 'reply could not be parsed (%s)' % type(e).__name__, {}


# ---------------------------------------------------------------------------------------------------------------------------- records that always build
def raw_files(adapter):
    sink = getattr(adapter, 'raw_sink', None)
    try:
        return sorted(p.name for p in sink.glob('*.raw')) if sink is not None and sink.is_dir() else []
    except Exception:  # noqa: BLE001
        return []


def minimal_aborted_record(case, case_sha, run_id, reason, turns, exc=None, adapter=None, secondary=None):
    """The started-aborted record when the full one cannot be built: only strings and numbers (always serializable, always writable), with the `usage`
    block finalisation reads, every raw stream and error the turns hold, and the raw files of the run."""
    def s(x):
        return safe_str(x, 100000) if isinstance(x, str) else None
    cost, reported = 0.0, 0
    for t in turns or []:
        c = ((t.get('usage') or {}) if isinstance(t, dict) else {}).get('cost_usd')
        if isinstance(c, float) and c == c:
            cost += c
            reported += 1
    return {'record_version': 1, 'status': 'started_aborted', 'scored': False, 'abort_reason': safe_str(reason, 2000), 'case_id': safe_str((case or {}).get('id')),
            'case_sha256': s(case_sha), 'harness_version': P.HARNESS_VERSION, 'run_id': safe_str(run_id),
            **({'partial_record_error': '%s: %s' % (type(exc).__name__, safe_str(exc))} if exc is not None else {}),
            **({'secondary_failure': safe_str(secondary, 2000)} if secondary else {}),
            'usage': {'model_calls': len(turns or []), 'input_tokens': 0, 'output_tokens': 0, 'cost_usd': round(cost, 6), 'cost_reported_calls': reported},
            'raw_files': raw_files(adapter),
            'turns': [{'n': t.get('n') if isinstance(t.get('n'), int) else None, 'error': s(t.get('error')), 'text': s(t.get('text')),
                       'raw_response': s(t.get('raw_response'))} for t in turns or [] if isinstance(t, dict)]}


def finalizable(partial):
    u = (partial or {}).get('usage') if isinstance(partial, dict) else None
    return isinstance(u, dict) and isinstance(u.get('cost_usd'), (int, float)) and isinstance(u.get('cost_reported_calls'), int) and 'case_id' in partial


def partial_from_record(R, case, case_sha, adapter, rec, reason, secondary=None):
    """A started-aborted record from a full record a stop overtook (a harness error after the call, an unknown cost); minimal when it cannot be built."""
    try:
        p = R.started_aborted_record(case, case_sha, adapter, {'version': rec['prompt']['version'], 'sha256': rec['prompt']['sha256']}, rec.get('run_id'),
                                     rec.get('started_at'), (rec.get('wall') or {}).get('total_s') or 0.0, rec.get('turns') or [], rec.get('tool_calls') or [],
                                     rec.get('repair_prompts') or [], reason, rec.get('evidence_mode'), rec.get('evidence_format'))
        if secondary:
            p['secondary_failure'] = safe_str(secondary, 2000)
        p['raw_files'] = raw_files(adapter)
        return p if finalizable(p) else minimal_aborted_record(case, case_sha, rec.get('run_id'), reason, rec.get('turns'), None, adapter, secondary)
    except Exception as e:  # noqa: BLE001
        return minimal_aborted_record(case, case_sha, (rec or {}).get('run_id'), reason, (rec or {}).get('turns'), e, adapter, secondary)


def stop(adapter, reason, partial=None, secondary=None):
    """An AbortRun that keeps the established stop as its primary reason (Rule B) and marks the adapter stopped."""
    primary = getattr(adapter, 'schema_stop', None) or reason
    if getattr(adapter, 'schema_stop', None) is None:
        adapter.schema_stop = safe_str(reason, 2000)
    ab = A.AbortRun(primary)
    ab.partial = partial
    if secondary:
        ab.secondary_failure = safe_str(secondary, 2000)
    return ab


# ---------------------------------------------------------------------------------------------------------------------------- the guarded case
def guarded_run_case(R, kw):
    """run_case for a schema-mode adapter: no case starts after a stop; an abort always carries a finalisable partial record; any other failure, a
    harness-crash record or a record with an unknown cost becomes a fail-closed stop that keeps the primary reason."""
    adapter, case, sha, run_id = kw['adapter'], kw['case'], kw['case_sha'], kw.get('run_id', '')
    if getattr(adapter, 'schema_stop', None):
        raise stop(adapter, None, minimal_aborted_record(case, sha, run_id, adapter.schema_stop, [], None, adapter))
    try:
        rec = R.run_case(**kw, _inner=True)
    except A.AbortRun as e:
        reason = safe_str(e, 2000)
        if getattr(adapter, 'schema_stop', None) is None:
            adapter.schema_stop = reason
        if not finalizable(getattr(e, 'partial', None)):
            e.partial = minimal_aborted_record(case, sha, run_id, reason, [], None, adapter)
        raise
    except Exception as e:  # noqa: BLE001 - Rule C: anything after the call
        secondary = 'a schema-mode case failed after its call: %s: %s' % (type(e).__name__, safe_str(e))
        raise stop(adapter, 'claude-schema-1: ' + secondary + '; stopping the run (fail closed)',
                   minimal_aborted_record(case, sha, run_id, getattr(adapter, 'schema_stop', None) or secondary, [], None, adapter, secondary), secondary)
    if (rec.get('error') or {}).get('kind') == 'harness_crash':
        secondary = 'harness error in a schema-mode case: %s' % safe_str((rec.get('error') or {}).get('message'))
        reason = 'claude-schema-1: %s; stopping the run (fail closed)' % secondary
        raise stop(adapter, reason, partial_from_record(R, case, sha, adapter, rec, getattr(adapter, 'schema_stop', None) or reason, secondary), secondary)
    if any('text' in t and not isinstance(((t.get('usage') or {}).get('cost_usd')), float) for t in rec.get('turns') or []):
        reason = 'claude-schema-1: a call of this case has no validated cost; stopping the run'
        raise stop(adapter, reason, partial_from_record(R, case, sha, adapter, rec, reason))
    return rec


# ---------------------------------------------------------------------------------------------------------------------------- the run loop
def write_json(path, obj):
    path.write_text(json.dumps(obj, indent=2, ensure_ascii=True, sort_keys=True, default=safe_str) + '\n')


def run_loop(R, args, adapter, out, run_id, suite_dir, scratch, cases, ocr_backend, evidence_bounds, manifest, limits):
    """main()'s case loop and finalisation for a schema-mode run (main hands over after building the manifest)."""
    aborted, records, partials, audit, secondary = None, [], [], None, []

    def note(what, e):
        secondary.append('%s: %s: %s' % (what, type(e).__name__, safe_str(e)))

    adapter.raw_sink = out / 'raw'
    if limits.enabled:
        limits.wrap(adapter)
        limits.start()
    try:
        manifest['preflight'] = adapter.preflight()
        manifest.update(adapter.describe())
        write_json(out / 'manifest.json', manifest)
        audit = open(out / 'audit.jsonl', 'a')
        for case, sha in cases:
            established = getattr(adapter, 'schema_stop', None) or (limits.stopped if limits.enabled else None)
            if established:                                   # Rule B: no case starts after a stop
                aborted = aborted or established
                break
            adapter.current_case = case['id']
            try:
                adapter.before_case()
            except A.AbortRun as e:
                aborted = safe_str(e, 2000)
                break
            try:
                rec = R.run_case(case, sha, adapter, suite_dir, scratch, ocr_backend=ocr_backend, replay=args.replay, run_id=run_id,
                                 tool_output_bytes=args.tool_output_bytes, prompt_version=args.prompt, evidence_mode=args.evidence,
                                 evidence_bounds=evidence_bounds, guards=args.guards, evidence_format=args.evidence_format)
            except A.AbortRun as e:
                aborted = safe_str(e, 2000)
                partial = e.partial if finalizable(getattr(e, 'partial', None)) else minimal_aborted_record(case, sha, run_id, aborted, [], None, adapter)
                if getattr(e, 'secondary_failure', None):
                    partial.setdefault('secondary_failure', e.secondary_failure)
                try:
                    (out / 'started-aborted').mkdir(exist_ok=True)
                    write_json(out / 'started-aborted' / (case['id'] + '.json'), partial)
                except Exception as we:  # noqa: BLE001
                    note('writing the started-aborted record', we)
                partials.append(partial)
                break
            except Exception as e:  # noqa: BLE001 - e.g. a malformed case file: in schema mode a fail-closed stop, never a crash record and go on
                aborted = 'claude-schema-1: the case could not run (%s: %s); stopping the run (fail closed)' % (type(e).__name__, safe_str(e))
                break
            try:
                rec.update(run_id=run_id, harness_git_sha=manifest['harness_git']['sha'], config_hash=manifest['config_hash'])
                write_json(out / (case['id'] + '.json'), rec)
                audit.write(R.canonical({'run_id': run_id, 'case_id': case['id'], 'case_sha256': sha, 'at': rec['started_at'],
                                         'forced': rec['forced'], **rec['action_audit']}) + '\n')
                audit.flush()
            except Exception as e:  # noqa: BLE001 - Rule C: a record that cannot be written stops the run
                aborted = 'claude-schema-1: writing the record of %s failed (%s); stopping the run (fail closed)' % (case['id'], type(e).__name__)
                note('writing a record', e)
                break
            records.append(rec)
            try:
                d = rec['decision']
                print('%s -> %s/%s%s %.1fs' % (case['id'], d['class'], d['action'], ' (forced)' if rec['forced'] else '', rec['wall']['total_s']), flush=True)
            except Exception:  # noqa: BLE001 - printing is cosmetic
                pass
    except A.AbortRun as e:
        aborted = aborted or safe_str(e, 2000)
        try:
            manifest.update(adapter.describe())
        except Exception as de:  # noqa: BLE001
            note('describing the adapter', de)
    except Exception as e:  # noqa: BLE001 - Rule C: the loop itself failed
        aborted = aborted or 'claude-schema-1: the run loop failed (%s); stopping the run (fail closed)' % type(e).__name__
        note('the run loop', e)
    finally:
        try:
            if audit:
                audit.close()
        except Exception as e:  # noqa: BLE001
            note('closing the audit log', e)
        established = getattr(adapter, 'schema_stop', None) or (limits.stopped if limits.enabled else None)
        aborted = aborted or established
        unknown = [r['case_id'] for r in records if not isinstance((r.get('usage') or {}).get('cost_usd'), float)]
        if unknown:                                           # (d): never exit 0 with an unknown cost
            aborted = aborted or 'claude-schema-1: the cost of %s is unknown' % ', '.join(unknown)
        for step, fn in (('limits', lambda: manifest.update(limits_state=limits.state()) if limits.enabled else None),
                         ('finish', lambda: manifest.update(finish=adapter.finish()))):
            try:
                fn()
            except Exception as e:  # noqa: BLE001
                note('finalising (%s)' % step, e)
        try:
            if limits.enabled:
                manifest['limits_state']['elapsed_after_cleanup_s'] = round(limits.elapsed(), 1)
                manifest['limits_state']['cost_usd'] = round(limits.cost, 6)
                manifest['limit_violations'] = limits.violations()
                if manifest['limit_violations']:
                    text = '; '.join('%s: %s' % (v['kind'], v['detail']) for v in manifest['limit_violations'])
                    aborted = text if not aborted else '%s [limit violation] %s' % (aborted, text)
        except Exception as e:  # noqa: BLE001
            note('finalising (limits)', e)
        import datetime
        manifest['aborted'] = aborted
        manifest['ended_at'] = datetime.datetime.now(datetime.timezone.utc).isoformat()
        manifest['records_written'] = [r['case_id'] for r in records]
        manifest['started_aborted'] = [p.get('case_id') for p in partials]
        manifest['never_started'] = [i for i in manifest['case_ids'] if i not in manifest['records_written'] and i not in manifest['started_aborted']]
        manifest['raw_files'] = raw_files(adapter)
        if secondary:
            manifest['secondary_failures'] = list(secondary)
        try:
            summary = R.summarize_run(records, manifest, partials)
        except Exception as e:  # noqa: BLE001 - Rule C: finalisation
            note('summarising the run', e)
            summary = {'harness_version': P.HARNESS_VERSION, 'run_id': run_id, 'aborted': aborted, 'summary_error': safe_str(e)}
            manifest['secondary_failures'] = list(secondary)
        for path, obj in ((out / 'manifest.json', manifest), (out / 'run_summary.json', summary)):
            try:
                write_json(path, obj)
            except Exception as e:  # noqa: BLE001
                note('writing %s' % path.name, e)
                aborted = aborted or 'claude-schema-1: writing %s failed; stopping the run (fail closed)' % path.name
    if aborted:
        try:
            import sys
            print('ABORTED: ' + safe_str(aborted, 2000), file=sys.stderr)
        except Exception:  # noqa: BLE001
            pass
        return 3
    return 0
