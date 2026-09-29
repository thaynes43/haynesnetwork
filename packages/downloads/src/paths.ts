// ADR-095 / DESIGN-046 D-18 — the filesystem side of the queue janitor's LazyLibrarian `leftover` class. LazyLibrarian
// copies a finished download into its library and leaves the SABnzbd folder behind; SABnzbd cannot delete a completed
// job's folder (its history delete removes only the incomplete folder, SABnzbd 5.1.3 `_api_history_delete`). The
// janitor's job therefore mounts the book library READ-ONLY and the LazyLibrarian category's completed folder
// READ-WRITE, at the same paths LazyLibrarian and SABnzbd use, so their recorded paths resolve unchanged.
//
// This module is the READ half (safe everywhere): whether both mounts are present, whether a recorded library
// destination exists as a file under a library root, and whether a SABnzbd job folder exists as a direct child of the
// download root. The delete is the confined WRITE half (`DownloadFolderCleaner`, ./write). Every check refuses a
// symlink and anything outside its root, so a crafted path can never reach beyond the one folder.
import { lstat, readdir, realpath } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path';

/** The filesystem calls the probe and the cleaner make (injectable for tests). */
export interface DownloadPathFs {
  lstat(path: string): Promise<{ isFile(): boolean; isDirectory(): boolean; isSymbolicLink(): boolean }>;
  realpath(path: string): Promise<string>;
  /** The names of a directory's entries with their types (`readdir(path, { withFileTypes: true })`). */
  readdir(path: string): Promise<Array<{ name: string; isDirectory(): boolean; isSymbolicLink(): boolean }>>;
}

export const nodeDownloadPathFs: DownloadPathFs = {
  lstat,
  realpath,
  readdir: (path) => readdir(path, { withFileTypes: true }),
};

/** LazyLibrarian's SABnzbd category folder, where SABnzbd files every finished LazyLibrarian job (live 2026-09-29:
 *  `download_dir` in LazyLibrarian's config, `storage` in SABnzbd's history). */
export const LL_DOWNLOAD_ROOT_DEFAULT = '/data/cephfs-hdd/data/usenet/complete-k8s/lazylibrarian';
/** LazyLibrarian's library folders (`ebook_dir`, `audio_dir`), where a Processed download's copy is recorded. */
export const LL_LIBRARY_ROOTS_DEFAULT = [
  '/data/cephfs-hdd/data/media/books/EBooks',
  '/data/cephfs-hdd/data/media/books/AudioBooks',
] as const;

/** The janitor's LazyLibrarian path config: the download root and the library roots (DESIGN-046 D-18). */
export interface LlJanitorPaths {
  downloadRoot: string;
  libraryRoots: string[];
}

/**
 * Read `JANITOR_LL_DOWNLOAD_ROOT` and `JANITOR_LL_LIBRARY_ROOTS` (colon-separated), each defaulting to the live
 * cluster paths. Only absolute paths are kept. No secret here.
 */
export function llJanitorPathsFromEnv(env: Record<string, string | undefined> = process.env): LlJanitorPaths {
  const downloadRoot = env.JANITOR_LL_DOWNLOAD_ROOT?.trim() || LL_DOWNLOAD_ROOT_DEFAULT;
  const rawRoots = env.JANITOR_LL_LIBRARY_ROOTS?.trim();
  const libraryRoots = (rawRoots ? rawRoots.split(':') : [...LL_LIBRARY_ROOTS_DEFAULT])
    .map((r) => r.trim())
    .filter((r) => r !== '' && isAbsolute(r));
  return { downloadRoot, libraryRoots };
}

/** True when `child` lies strictly inside `root` (lexically, after resolving `.` and `..`). Pure. */
export function isStrictlyUnder(child: string, root: string): boolean {
  if (!isAbsolute(child) || !isAbsolute(root)) return false;
  const c = resolve(child);
  const r = resolve(root);
  return c !== r && c.startsWith(r.endsWith(sep) ? r : r + sep);
}

/** True when `child` is a direct child of `root` (lexically, after resolving `.` and `..`). Pure. */
export function isDirectChildOf(child: string, root: string): boolean {
  if (!isAbsolute(child) || !isAbsolute(root)) return false;
  const c = resolve(child);
  return c !== resolve(root) && dirname(c) === resolve(root);
}

async function lstatOrNull(fs: DownloadPathFs, path: string) {
  try {
    return await fs.lstat(path);
  } catch {
    return null;
  }
}

/**
 * The READ-ONLY path checks behind the `leftover` class. `available()` is false when either mount is absent (the
 * roots do not exist as directories in the janitor's container): then the janitor does not observe leftovers at all.
 */
export class DownloadPathProbe {
  private readonly fs: DownloadPathFs;

  constructor(
    readonly paths: LlJanitorPaths,
    fs: DownloadPathFs = nodeDownloadPathFs,
  ) {
    this.fs = fs;
  }

  /** Both mounts are present: the download root and every library root are real directories. */
  async available(): Promise<boolean> {
    if (this.paths.libraryRoots.length === 0) return false;
    for (const root of [this.paths.downloadRoot, ...this.paths.libraryRoots]) {
      const st = await lstatOrNull(this.fs, root);
      if (!st || !st.isDirectory() || st.isSymbolicLink()) return false;
    }
    return true;
  }

  /**
   * A recorded library destination (LazyLibrarian's `DLResult` on a Processed row) exists: an absolute path strictly
   * under a library root that is a regular file, not a symlink, whose real path is still under that root.
   */
  async libraryFileExists(path: string | null | undefined): Promise<boolean> {
    if (!path || !isAbsolute(path)) return false;
    // A "library copy" inside the download folder is no copy at all: it goes with the folder (a misconfigured root
    // that contains the download root must never pass).
    if (isStrictlyUnder(path, this.paths.downloadRoot)) return false;
    const root = this.paths.libraryRoots.find((r) => isStrictlyUnder(path, r));
    if (!root) return false;
    const st = await lstatOrNull(this.fs, path);
    if (!st || !st.isFile() || st.isSymbolicLink()) return false;
    try {
      return isStrictlyUnder(await this.fs.realpath(path), await this.fs.realpath(root));
    } catch {
      return false;
    }
  }

  /**
   * The names of the download root's direct-child folders (real directories, not symlinks), in one directory read:
   * the cheap first filter before a per-folder check, since SABnzbd's history names thousands of folders that are
   * long gone.
   */
  async listDownloadFolders(): Promise<Set<string>> {
    const entries = await this.fs.readdir(this.paths.downloadRoot);
    return new Set(entries.filter((e) => e.isDirectory() && !e.isSymbolicLink()).map((e) => e.name));
  }

  /** The folder `path` would be, when it is a direct child of the download root (its name), else null. Pure. */
  downloadFolderName(path: string | null | undefined): string | null {
    if (!path || !isDirectChildOf(path, this.paths.downloadRoot)) return null;
    return basename(resolve(path));
  }

  /** The absolute path of a download-root child folder by name. Pure. */
  downloadFolderPath(name: string): string {
    return join(resolve(this.paths.downloadRoot), name);
  }

  /** A SABnzbd job folder exists: a direct child of the download root that is a real directory, not a symlink. */
  async downloadFolderExists(path: string | null | undefined): Promise<boolean> {
    if (!path || !isDirectChildOf(path, this.paths.downloadRoot)) return false;
    const st = await lstatOrNull(this.fs, path);
    if (!st || !st.isDirectory() || st.isSymbolicLink()) return false;
    try {
      return dirname(await this.fs.realpath(path)) === (await this.fs.realpath(this.paths.downloadRoot));
    } catch {
      return false;
    }
  }
}
