cat /sys/fs/cgroup/memory.stat /sys/fs/cgroup/memory.events /sys/fs/cgroup/memory.pressure
for f in /proc/[0-9]*/comm; do
 read -r comm < "$f" 2>/dev/null || continue
 [ "$comm" = llama-server ] || continue
 pid=${f#/proc/}; pid=${pid%/comm}
 printf 'LOADER %s\n' "$pid"
 tr '\0' ' ' < "/proc/$pid/cmdline"; printf '\n'
 cat "/proc/$pid/io" "/proc/$pid/wchan" "/proc/$pid/schedstat" "/proc/$pid/smaps_rollup" 2>/dev/null
 printf '\n'
 for fd in /proc/$pid/fd/*; do
  target=$(readlink "$fd" 2>/dev/null) || continue
  case "$target" in /models/blobs/sha256-*|/tmp/media-repair-nemotron-1018-local/models/blobs/sha256-*) printf 'BLOB_FD %s %s\n' "$fd" "$target"; cat "/proc/$pid/fdinfo/${fd##*/}" 2>/dev/null;; esac
 done
 for task in /proc/$pid/task/*/wchan; do printf 'WAIT %s ' "$task"; cat "$task" 2>/dev/null; printf '\n'; done
 done
