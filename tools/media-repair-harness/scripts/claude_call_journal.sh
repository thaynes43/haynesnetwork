#!/bin/bash
# Pass-through `claude` shim for the validity run (#159, Amendment 1): put its directory first on PATH as `claude`.
# It journals each call's start, end and exit status, and keeps a durable copy of the CLI's stdout (the JSON reply), so an
# interrupted run still shows which calls started and what they returned.  It never reads or logs stdin (the prompt) or the
# arguments (the system prompt), and it passes stdin, stdout, stderr and the exit status through unchanged.
#   MRH_CLAUDE_REAL     absolute path of the real claude binary (required)
#   MRH_CALL_JOURNAL    journal directory (required; created if missing)
set -o pipefail
: "${MRH_CLAUDE_REAL:?MRH_CLAUDE_REAL unset}" "${MRH_CALL_JOURNAL:?MRH_CALL_JOURNAL unset}"
mkdir -p "$MRH_CALL_JOURNAL"
id="$(date -u +%Y%m%dT%H%M%S%N)-$$"
printf '%s start %s nargs=%d\n' "$(date -u +%FT%T.%NZ)" "$id" "$#" >> "$MRH_CALL_JOURNAL/calls.log"
"$MRH_CLAUDE_REAL" "$@" | tee "$MRH_CALL_JOURNAL/out-$id.json"
rc=$?
printf '%s end %s rc=%d\n' "$(date -u +%FT%T.%NZ)" "$id" "$rc" >> "$MRH_CALL_JOURNAL/calls.log"
exit $rc
