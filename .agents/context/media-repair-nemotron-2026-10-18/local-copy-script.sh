set -e
printf 'COPY_PID=%s\n' "$$" >&2
child=
trap 'test -z "$child" || kill "$child" 2>/dev/null; exit 143' TERM INT
test ! -e /tmp/media-repair-nemotron-1018-local
mkdir -m 700 /tmp/media-repair-nemotron-1018-local
mkdir -p /tmp/media-repair-nemotron-1018-local/models/blobs /tmp/media-repair-nemotron-1018-local/models/manifests/registry.ollama.ai/library/nemotron-3.5-bolt
printf "COPY sha256-bdc72596f81bbe5ecc80608061f6e922a3d04d3a2f7e0a14c2bb6eca6271734a\n"
nice -n 19 cp -- /models/blobs/sha256-bdc72596f81bbe5ecc80608061f6e922a3d04d3a2f7e0a14c2bb6eca6271734a /tmp/media-repair-nemotron-1018-local/models/blobs/sha256-bdc72596f81bbe5ecc80608061f6e922a3d04d3a2f7e0a14c2bb6eca6271734a & child=$!; wait "$child"; child=
nice -n 19 sha256sum /tmp/media-repair-nemotron-1018-local/models/blobs/sha256-bdc72596f81bbe5ecc80608061f6e922a3d04d3a2f7e0a14c2bb6eca6271734a & child=$!; wait "$child"; child=
chmod 400 /tmp/media-repair-nemotron-1018-local/models/blobs/sha256-bdc72596f81bbe5ecc80608061f6e922a3d04d3a2f7e0a14c2bb6eca6271734a
printf "COPY sha256-91d63363e782c8a3d5f4be42816eba8e0d42dd2530bd07a7d0d2dc440599af75\n"
nice -n 19 cp -- /models/blobs/sha256-91d63363e782c8a3d5f4be42816eba8e0d42dd2530bd07a7d0d2dc440599af75 /tmp/media-repair-nemotron-1018-local/models/blobs/sha256-91d63363e782c8a3d5f4be42816eba8e0d42dd2530bd07a7d0d2dc440599af75 & child=$!; wait "$child"; child=
nice -n 19 sha256sum /tmp/media-repair-nemotron-1018-local/models/blobs/sha256-91d63363e782c8a3d5f4be42816eba8e0d42dd2530bd07a7d0d2dc440599af75 & child=$!; wait "$child"; child=
chmod 400 /tmp/media-repair-nemotron-1018-local/models/blobs/sha256-91d63363e782c8a3d5f4be42816eba8e0d42dd2530bd07a7d0d2dc440599af75
printf "COPY sha256-0ee891eadc7bf0cae6289b249c74eb1ef420534351f6ef8b64d49f0ca6a926b0\n"
nice -n 19 cp -- /models/blobs/sha256-0ee891eadc7bf0cae6289b249c74eb1ef420534351f6ef8b64d49f0ca6a926b0 /tmp/media-repair-nemotron-1018-local/models/blobs/sha256-0ee891eadc7bf0cae6289b249c74eb1ef420534351f6ef8b64d49f0ca6a926b0 & child=$!; wait "$child"; child=
nice -n 19 sha256sum /tmp/media-repair-nemotron-1018-local/models/blobs/sha256-0ee891eadc7bf0cae6289b249c74eb1ef420534351f6ef8b64d49f0ca6a926b0 & child=$!; wait "$child"; child=
chmod 400 /tmp/media-repair-nemotron-1018-local/models/blobs/sha256-0ee891eadc7bf0cae6289b249c74eb1ef420534351f6ef8b64d49f0ca6a926b0
printf "COPY sha256-080e1ea41c9562a7804dbf30c6fbd4d17e216c6b8ff666f88e6edb1816010194\n"
nice -n 19 cp -- /models/blobs/sha256-080e1ea41c9562a7804dbf30c6fbd4d17e216c6b8ff666f88e6edb1816010194 /tmp/media-repair-nemotron-1018-local/models/blobs/sha256-080e1ea41c9562a7804dbf30c6fbd4d17e216c6b8ff666f88e6edb1816010194 & child=$!; wait "$child"; child=
nice -n 19 sha256sum /tmp/media-repair-nemotron-1018-local/models/blobs/sha256-080e1ea41c9562a7804dbf30c6fbd4d17e216c6b8ff666f88e6edb1816010194 & child=$!; wait "$child"; child=
chmod 400 /tmp/media-repair-nemotron-1018-local/models/blobs/sha256-080e1ea41c9562a7804dbf30c6fbd4d17e216c6b8ff666f88e6edb1816010194
printf "COPY sha256-bf6afc09321cbabba412015fa925ab9480d04859607f233b278334544937ea34\n"
nice -n 19 cp -- /models/blobs/sha256-bf6afc09321cbabba412015fa925ab9480d04859607f233b278334544937ea34 /tmp/media-repair-nemotron-1018-local/models/blobs/sha256-bf6afc09321cbabba412015fa925ab9480d04859607f233b278334544937ea34 & child=$!; wait "$child"; child=
nice -n 19 sha256sum /tmp/media-repair-nemotron-1018-local/models/blobs/sha256-bf6afc09321cbabba412015fa925ab9480d04859607f233b278334544937ea34 & child=$!; wait "$child"; child=
chmod 400 /tmp/media-repair-nemotron-1018-local/models/blobs/sha256-bf6afc09321cbabba412015fa925ab9480d04859607f233b278334544937ea34
printf "COPY sha256-4a3e6daa08124f0e8133aa1446e6dc16a9e7420e264686864da246bc93f966dc\n"
nice -n 19 cp -- /models/blobs/sha256-4a3e6daa08124f0e8133aa1446e6dc16a9e7420e264686864da246bc93f966dc /tmp/media-repair-nemotron-1018-local/models/blobs/sha256-4a3e6daa08124f0e8133aa1446e6dc16a9e7420e264686864da246bc93f966dc & child=$!; wait "$child"; child=
nice -n 19 sha256sum /tmp/media-repair-nemotron-1018-local/models/blobs/sha256-4a3e6daa08124f0e8133aa1446e6dc16a9e7420e264686864da246bc93f966dc & child=$!; wait "$child"; child=
chmod 400 /tmp/media-repair-nemotron-1018-local/models/blobs/sha256-4a3e6daa08124f0e8133aa1446e6dc16a9e7420e264686864da246bc93f966dc
printf "COPY sha256-d6d3deeca27134af015d1ab4d57ee655dd6d624dbef4f5dfd18f4b54f76bb554\n"
nice -n 19 cp -- /models/blobs/sha256-d6d3deeca27134af015d1ab4d57ee655dd6d624dbef4f5dfd18f4b54f76bb554 /tmp/media-repair-nemotron-1018-local/models/blobs/sha256-d6d3deeca27134af015d1ab4d57ee655dd6d624dbef4f5dfd18f4b54f76bb554 & child=$!; wait "$child"; child=
nice -n 19 sha256sum /tmp/media-repair-nemotron-1018-local/models/blobs/sha256-d6d3deeca27134af015d1ab4d57ee655dd6d624dbef4f5dfd18f4b54f76bb554 & child=$!; wait "$child"; child=
chmod 400 /tmp/media-repair-nemotron-1018-local/models/blobs/sha256-d6d3deeca27134af015d1ab4d57ee655dd6d624dbef4f5dfd18f4b54f76bb554
cp -- /models/manifests/registry.ollama.ai/library/nemotron-3.5-bolt/74b-a9b /tmp/media-repair-nemotron-1018-local/models/manifests/registry.ollama.ai/library/nemotron-3.5-bolt/74b-a9b
sha256sum /tmp/media-repair-nemotron-1018-local/models/manifests/registry.ollama.ai/library/nemotron-3.5-bolt/74b-a9b
stat -c "%u %a %F" /tmp/media-repair-nemotron-1018-local
df -B1 -T /tmp/media-repair-nemotron-1018-local
