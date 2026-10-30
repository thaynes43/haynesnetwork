# 2026-10-30 — HaynesTower storage and retained-download inventory

Canonical work: OpenProject Story **#297**, Epic **#293**. Initial capacity and client
evidence is in **#294**; inventory checkpoints are #297 journals 3429 and 3434.

**No deletion was performed or authorized by this inventory. No retained download was
proved safe to purge.** This is a read-only inventory and a list of concrete review
candidates, with private title and file lists excluded from this public record.

## Scope and measurement

Reads ran on 2026-10-30, with filesystem observations from approximately 14:39 to
15:05 UTC, through existing app APIs and the SABnzbd pod's existing NFS
mount, `haynestower.haynesnetwork:/mnt/user/data` at `/data/haynestower`. `Media` is a
child of that share. The host's other shares and physical disk directory placement
were not available through this mount.

The supported `hw-ssh list` includes HaynesTower, but the actual `hw-ssh haynestower`
read probe failed with a TCP22 connection timeout, exit 255, before any remote command
ran. The existing NFS mount reports the server at `192.168.40.39`. No alternate SSH
route, identity, credential or grant was attempted.

One recursive scan ran at a time, using `nice -n 19`, `ionice -c 3`, time limits and
entry limits. Symlinks were counted without traversal. A slow initial Music pass was
stopped by terminating only the investigator's own Python process; the remaining
categories were scanned separately with progress reports and per-category limits.
No app process, scheduled job, configuration or library file was changed.

Tables report the sum of regular files' NFS-reported `st_blocks * 512`, in decimal
TB/GB. These exclude directory/filesystem overhead, are not per-disk measurements,
and do not establish reclaimable unique extents. Hardlinks are discussed below.
The scans and API reads are live observations over a time window, not an atomic
snapshot. The pooled share can also include staging; it is not another physical
array whose capacity should be added to disk metrics.

The #294 capacity baseline was 28 unique XFS data disks: **525.957719 TB total,
76.269424 TB free, 85.50% used**. `/mnt/user` and `/mnt/user0` are duplicate pooled
views. Separate pools were staging 4.0008 TB and apps 2.0004 TB; CephFS is separate.
Radarr's 529.9585 TB view included staging. This inventory does not replace those
physical capacity measurements with a sum of folder names.

## Media folders

| Folder under `data/Media` | Allocated file TB | Files | Completion |
| --- | ---: | ---: | --- |
| TV Shows | 220.696409 | 79,933 | Complete |
| Movies | 171.238891 | 8,417 | Complete |
| NewFolder | 33.396617 | 9,293 | Complete |
| Music | At least 8.763610 | 304,235 observed | Partial: 420-second cap, 29 directories pending |
| Audio Books | 0.309778 | 26,939 | Complete |
| Comics | 0.066093 | 1,737 | Complete |
| YouTube | 0.047797 | 534 | Complete |
| EBooks | 0.010779 | 1,853 | Complete |
| Trailers | 0.008972 | 18 | Complete |

Completed categories reported zero scan/stat errors.

The final Music pass stopped at its fixed limit at 15:05:35 UTC; it also reported no
scan/stat errors, but its unvisited directories prevent a complete total. Its
observed files were predominantly FLAC and MP3, and all observed file mtimes were
older than 30 days. Age alone does not establish obsolescence. No further scan was
started after this limit. The observed sum across Media names is at least
434.538947 TB of reported file blocks; it includes hardlinked names and is not a
unique physical-byte or reclaimable-space total.

`NewFolder` has 260 direct child directories and one direct text file. Its 9,228 MP4
files account for 33.333657 TB; 64 other video files are WMV, AVI, MKV and MOV. It is
video content, with no general scratch/archive signature. There are no reported
hardlinked names in this folder.

At 14:45 UTC, none of the three Plex servers reported a literal library location
containing `NewFolder`. Tower's Plex reports container-local aliases such as
`/data/Movies` and `/data/TV Shows`; their host bind mappings remain unverified.
Native item-path reads also found all 1,073 Sonarr series under
`Media/TV Shows`, all 9,458 Radarr movies under `Media/Movies`, and no item under
`NewFolder`. Lidarr's current root is on CephFS. This establishes absent native *arr
path coverage and no literal Plex location, rather than proving every container alias
unrelated to the folder. It does not establish abandonment. Ownership and retention
intent for this video library remain unresolved. **Q-01:** the driver's owner question
about `NewFolder` ownership/retention is pending; there is no purge decision.

## Other material folders

| Folder under `data` | Allocated file TB | Files | Observation |
| --- | ---: | ---: | --- |
| usenet/complete | 1.867367 | 28,177 | Legacy completed tree; current clients do not reference its entries |
| usenet/complete-k8s | 1.845839 | 2,161 | Mix of queued, completed and unreferenced retained entries |
| torrents | 1.295953 | 2,454 | Legacy client/seed ownership not available |
| directdownload | 0.827690 | 36,612 | Ownership and current use unresolved |
| usenet/incomplete | 0.063298 | 13,554 | 19 top-level entries, 37 nested directories; every file mtime older than 30 days |
| maintainerr | 0.000024 | 5 | Application data, retained |

`torrents-k8s`, `db`, `downloads`, `dump`, `images`, `template`, `private` and `snippets`
contained no regular files in the inspected view. These observations cover `data`,
not every share or storage device on the host.

The legacy `torrents` tree has 240 names with `nlink > 1`, accounting for 127.176 GB
of reported file blocks. Media also contains multi-link names: Movies 5 / 71.924 GB,
TV Shows 29 / 44.002 GB, Audio Books 16 / 1.719 GB, EBooks 25 / 0.514 GB, and Music's
observed 165 names / 9.016 GB. The 240 observed Media multi-link
names match the torrent count and reported block sum, consistent with library/seed
hardlinks; exact inode pairing across those trees was not performed. These figures
must not be added as unique recoverable storage. The completed and incomplete Usenet
trees reported no multi-link names. Releasing a torrent name may leave a library
hardlink holding its blocks.

Current qBittorrent evidence from #294 was 1,253 completed books torrents, all on
CephFS, approximately 0.371 TB nominal. They are excluded from Tower accounting and
preserved as seeded downloads. That says nothing about a legacy host torrent client.

## Retained-download manifest

Both SAB APIs were read using their existing own-process credentials, remotely only;
no credential value was printed or copied. At approximately 14:41 UTC:

- Main SAB: queue 0, history 351, all Completed, oldest July 10. Tower entries were
  317 TV, one movie and two uncategorized jobs. Its 24 Lidarr and seven LazyLibrarian
  jobs were on CephFS and excluded from Tower accounting.
- Fast SAB: queue 0, history 281, all Completed/TV, oldest July 30.
- Native queues: Sonarr 76 rows / 32 download GUIDs; Radarr one row / one GUID;
  Lidarr 22 rows / 20 GUIDs, on CephFS. Pack rows repeat download sizes, so row sums
  are not storage measurements. Counts changed during the investigation and are
  timestamped observations.

The private exact-path manifest completed at **14:57:12 UTC**, in 18.1 seconds,
with zero file errors or incomplete entries. Its categories are:

| Review class | Entries | Actual allocated bytes | Treatment |
| --- | ---: | ---: | --- |
| Current completed tree, referenced by native Arr queue | 33 | 115,467,976,704 | Preserve; blocked/pending imports |
| Current completed tree, SAB Completed without current imported-copy proof | 552 | 1,032,910,712,832 | Preserve pending content/import decision |
| Current completed tree, unreferenced by current SAB history and Arr queues | 128 | 697,460,731,904 | Review ownership and wanted content; absence of references is not import proof |
| Legacy completed tree, unreferenced by current SAB history and Arr queues | 2,033 | 1,867,366,584,320 | Review legacy client ownership and wanted content |
| Legacy incomplete tree | 19 | 63,297,896,448 | Strongest stale-scratch review candidate; confirm no legacy client still owns it |

An entry is an immediate retained child directory or loose file, not necessarily a
download GUID. Current-client reference checks do not inventory legacy host clients.
File mtime is not download completion time or proof of abandonment.

Native import evidence was checked independently of SAB history:

- The exact `downloadId` history filter was verified, then 623 serial bounded native
  GUID reads completed with zero errors or foreign IDs. Only 14 Sonarr SAB jobs had
  successful import records. All 14 storage folders and all 80 unique recorded
  source files were already absent, so those jobs supplied zero cleanup bytes.
- All **23,490 Sonarr successful-import records** from July 3 through October 30 and
  all **1,338 Radarr successful-import records** available in its native history were
  joined to retained file paths. A source file needed a native import record and a
  current regular library file whose size matched the recorded import to enter the
  duplicate-review subset. **No retained file met that test.**
- This does not prove that files were never imported by a predecessor application
  or path mapping. It prevents calling the retained trees proved imported duplicates.
  No full media-content hashes were read.

The driver reported a 14:44:10 UTC read-only protection snapshot with zero open
Fixes, zero open Repairs and zero unfinished Watch Carries. It is not a permanent
clearance: active state, client ownership, selected paths and any library-copy proof
must be rechecked immediately before a separately authorized cleanup.

## Review outcome and missing evidence

**Proved safe to purge now: zero bytes.** The first review target is the 63.298 GB
legacy incomplete tree, followed by 697.461 GB of current unreferenced completed
entries and 1.867367 TB of legacy completed entries. These are measured candidates
for an owner/content decision, not instructions to delete them. `NewFolder` is an
owner-unresolved video library; `directdownload` and legacy torrents also need an
owner/use decision. Library files, seeded downloads and current queued imports stay
protected.

The remaining exact read gaps are:

1. Music's 29 unvisited directories after the fixed scan limit; the reported Music
   figure is a lower bound, not a completed inventory.
2. Host physical disk directory attribution, other share/pool contents, and reported
   inode/block relationships across physical and pooled views. The supported SSH
   route timed out; no network or access change was requested.
3. Non-secret Unraid allocation, minimum-free, split-level, include/exclude, primary/
   secondary storage and mover settings, including whether a folder is constrained
   to particular disks. These are not exposed by the mounted `data` share.
4. Legacy host container/client inventory and data mounts; active download/seed
   ownership of the legacy completed, incomplete, torrent and direct-download trees.
5. Owner intent for unreferenced retained content and `NewFolder`; native import
   evidence from any predecessor app/path mapping if it is to justify duplicate
   cleanup. A missing history row alone supplies no such proof.

The canonical OpenProject item holds aggregate evidence and handoff. Private local
JSON contains the exact candidate paths and API joins, outside the repository; no
private title or username list is committed. Those session-local manifests are
ephemeral observations, not durable ownership proof; future cleanup needs fresh
reads and its own authorization. No deletion, move, backfill, job trigger,
janitor-mode change, configuration change, downtime or new credential/grant occurred.
