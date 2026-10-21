#!/bin/bash
# Pass-through `claude` shim for the validity run (#159, Amendments 1-3): put its directory first on PATH as `claude`.
# It journals each call's start and the close of its stdout, and keeps a durable copy of the CLI's stdout (the JSON reply), so an
# interrupted run still shows which calls started and what they returned.  It never reads or logs stdin (the prompt) or the
# arguments (the system prompt); a `--version` call (the runner's preflight) is tagged kind=version, every other call kind=call.
# The shim EXECs the real CLI (Amendment 2), so the caller's process id is the CLI's: a timeout kill reaches the CLI itself, and
# stdin, stderr and the exit status pass through unchanged; stdout passes through tee.  It REFUSES to start the CLI (exit 97,
# nothing executed) when the journal directory or the start record cannot be written (Amendment 3).
#   MRH_CLAUDE_REAL     absolute path of the real claude binary (required)
#   MRH_CALL_JOURNAL    journal directory (required; created if missing)
: "${MRH_CLAUDE_REAL:?MRH_CLAUDE_REAL unset}" "${MRH_CALL_JOURNAL:?MRH_CALL_JOURNAL unset}"
mkdir -p "$MRH_CALL_JOURNAL" || { echo "claude shim: cannot create journal $MRH_CALL_JOURNAL; refusing" >&2; exit 97; }
id="$(date -u +%Y%m%dT%H%M%S%N)-$$"
kind=call; [ "$#" -eq 1 ] && [ "$1" = "--version" ] && kind=version
printf '%s start %s kind=%s nargs=%d\n' "$(date -u +%FT%T.%NZ)" "$id" "$kind" "$#" >> "$MRH_CALL_JOURNAL/calls.log" \
  || { echo "claude shim: cannot write the start record; refusing" >&2; exit 97; }
: > "$MRH_CALL_JOURNAL/out-$id.json" || { echo "claude shim: cannot create the reply copy; refusing" >&2; exit 97; }
exec "$MRH_CLAUDE_REAL" "$@" > >(tee "$MRH_CALL_JOURNAL/out-$id.json"; printf '%s stdout-closed %s\n' "$(date -u +%FT%T.%NZ)" "$id" >> "$MRH_CALL_JOURNAL/calls.log")
