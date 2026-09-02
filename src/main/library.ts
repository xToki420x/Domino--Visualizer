import { app, dialog, shell } from 'electron';
import { promises as fs, existsSync } from 'node:fs';
import path from 'node:path';
import type { LibraryEntry, LibraryKind, ImportResult } from '@shared/types';

/**
 * Two-tier content library.
 *
 * Every kind has a read-only "builtin" root shipped with the app and a
 * writable "user" root under userData. Reads prefer the user copy, so editing a
 * builtin shader transparently forks it into user space instead of mutating the
 * install. Ids are always root-relative POSIX paths, which keeps them stable
 * across machines and safe to put in settings.
 */

interface KindConfig {
  dir: string;
  exts: string[];
  filterName: string;
}

const KINDS: Record<LibraryKind, KindConfig> = {
  shader: { dir: 'shaders', exts: ['.glsl', '.frag', '.fs', '.txt'], filterName: 'Shaders' },
  milk: { dir: 'milk', exts: ['.milk'], filterName: 'MilkDrop Presets' },
  preset: { dir: 'presets', exts: ['.json'], filterName: 'Domino Presets' },
};

let cachedBuiltinBase: string | null = null;

/**
 * Locate the bundled resources directory.
 *
 * `app.getAppPath()` alone is not reliable: it points at the directory of
 * whatever script Electron was handed, so it differs between `electron .`,
 * `electron-vite dev`, and a test harness that boots main directly. Probing a
 * few candidates and keeping the first that exists makes the library work
 * under all of them, which matters because a wrong answer here shows up as a
 * silently empty preset list rather than an error.
 */
function builtinBase(): string {
  if (cachedBuiltinBase) return cachedBuiltinBase;

  const candidates = app.isPackaged
    ? [path.join(process.resourcesPath, 'resources')]
    : [
        // Relative to the compiled main bundle (out/main/index.js).
        path.resolve(__dirname, '../../resources'),
        path.join(app.getAppPath(), 'resources'),
        path.resolve(process.cwd(), 'resources'),
      ];

  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      cachedBuiltinBase = candidate;
      return candidate;
    }
  }

  // Nothing found: fall back to the first candidate so callers get a stable
  // path, and the empty listing surfaces in the UI rather than throwing.
  cachedBuiltinBase = candidates[0];
  return cachedBuiltinBase;
}

function builtinRoot(kind: LibraryKind): string {
  return path.join(builtinBase(), KINDS[kind].dir);
}

function userRoot(kind: LibraryKind): string {
  return path.join(app.getPath('userData'), 'library', KINDS[kind].dir);
}

/**
 * Resolve a library id to an absolute path inside `root`, refusing anything
 * that escapes it. Ids come from the renderer, so this is a trust boundary:
 * `..`, absolute paths, and NT drive prefixes all have to be rejected here.
 */
function resolveWithin(root: string, id: string): string | null {
  if (typeof id !== 'string' || id.length === 0 || id.length > 1024) return null;
  if (id.includes('\0')) return null;
  const normalized = path.normalize(id).replace(/\\/g, '/');
  if (path.isAbsolute(normalized) || /^[a-zA-Z]:/.test(normalized)) return null;
  const full = path.resolve(root, normalized);
  const rel = path.relative(root, full);
  if (rel.startsWith('..') || path.isAbsolute(rel)) return null;
  return full;
}

async function walk(root: string, kind: LibraryKind, builtin: boolean): Promise<LibraryEntry[]> {
  const out: LibraryEntry[] = [];
  const exts = KINDS[kind].exts;

  async function recurse(dir: string, depth: number): Promise<void> {
    if (depth > 6) return;
    let dirents;
    try {
      dirents = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return; // Missing roots are normal (fresh install, no user library yet).
    }
    for (const dirent of dirents) {
      const full = path.join(dir, dirent.name);
      if (dirent.isDirectory()) {
        await recurse(full, depth + 1);
        continue;
      }
      if (!dirent.isFile()) continue;
      const ext = path.extname(dirent.name).toLowerCase();
      if (!exts.includes(ext)) continue;
      let stat;
      try {
        stat = await fs.stat(full);
      } catch {
        continue;
      }
      const rel = path.relative(root, full).replace(/\\/g, '/');
      out.push({
        id: rel,
        name: path.basename(dirent.name, ext),
        path: full,
        kind,
        group: path.dirname(rel) === '.' ? '' : path.dirname(rel),
        builtin,
        sizeBytes: stat.size,
        modifiedMs: stat.mtimeMs,
      });
    }
  }

  await recurse(root, 0);
  return out;
}

export async function listLibrary(kind: LibraryKind): Promise<LibraryEntry[]> {
  const [builtins, users] = await Promise.all([
    walk(builtinRoot(kind), kind, true),
    walk(userRoot(kind), kind, false),
  ]);
  // A user file with the same id shadows the builtin.
  const byId = new Map<string, LibraryEntry>();
  for (const entry of builtins) byId.set(entry.id, entry);
  for (const entry of users) byId.set(entry.id, entry);
  return [...byId.values()].sort(
    (a, b) => a.group.localeCompare(b.group) || a.name.localeCompare(b.name),
  );
}

export async function readLibrary(kind: LibraryKind, id: string): Promise<string> {
  const userPath = resolveWithin(userRoot(kind), id);
  if (userPath) {
    try {
      return await fs.readFile(userPath, 'utf8');
    } catch {
      /* fall through to builtin */
    }
  }
  const builtinPath = resolveWithin(builtinRoot(kind), id);
  if (!builtinPath) throw new Error(`Invalid library id: ${id}`);
  return await fs.readFile(builtinPath, 'utf8');
}

/** Writes always land in user space, never over the builtin resources. */
export async function writeLibrary(
  kind: LibraryKind,
  id: string,
  content: string,
): Promise<string> {
  const full = resolveWithin(userRoot(kind), id);
  if (!full) throw new Error(`Invalid library id: ${id}`);
  await fs.mkdir(path.dirname(full), { recursive: true });
  await fs.writeFile(full, content, 'utf8');
  return full;
}

export async function deleteLibrary(kind: LibraryKind, id: string): Promise<void> {
  const full = resolveWithin(userRoot(kind), id);
  if (!full) throw new Error(`Invalid library id: ${id}`);
  await fs.unlink(full);
}

/** True when a name is already taken, so the UI can warn before overwriting. */
export async function libraryExists(kind: LibraryKind, id: string): Promise<boolean> {
  for (const root of [userRoot(kind), builtinRoot(kind)]) {
    const full = resolveWithin(root, id);
    if (full && existsSync(full)) return true;
  }
  return false;
}

/**
 * Rename within the library.
 *
 * Renaming a builtin is allowed and means "make me a copy under this name":
 * the content is read from wherever it lives and written to user space, and
 * only a user-space original is removed. The bundled file is never touched.
 */
export async function renameLibrary(
  kind: LibraryKind,
  fromId: string,
  toId: string,
): Promise<string> {
  const target = resolveWithin(userRoot(kind), toId);
  if (!target) throw new Error(`Invalid library id: ${toId}`);
  if (existsSync(target)) throw new Error('A file with that name already exists.');

  const content = await readLibrary(kind, fromId);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, content, 'utf8');

  const source = resolveWithin(userRoot(kind), fromId);
  if (source && existsSync(source)) {
    await fs.unlink(source);
  }
  return target;
}

export async function importIntoLibrary(kind: LibraryKind): Promise<ImportResult> {
  const cfg = KINDS[kind];
  const picked = await dialog.showOpenDialog({
    title: `Import ${cfg.filterName}`,
    properties: ['openFile', 'openDirectory', 'multiSelections'],
    filters: [
      { name: cfg.filterName, extensions: cfg.exts.map((e) => e.slice(1)) },
      { name: 'All Files', extensions: ['*'] },
    ],
  });
  if (picked.canceled || picked.filePaths.length === 0) {
    return { ok: true, imported: 0, skipped: 0 };
  }

  const dest = userRoot(kind);
  await fs.mkdir(dest, { recursive: true });
  let imported = 0;
  let skipped = 0;

  async function copyFile(src: string, relDir: string): Promise<void> {
    const ext = path.extname(src).toLowerCase();
    if (!cfg.exts.includes(ext)) {
      skipped++;
      return;
    }
    const target = path.join(dest, relDir, path.basename(src));
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.copyFile(src, target);
    imported++;
  }

  async function copyTree(src: string, relDir: string, depth: number): Promise<void> {
    if (depth > 6) return;
    const dirents = await fs.readdir(src, { withFileTypes: true });
    for (const dirent of dirents) {
      const full = path.join(src, dirent.name);
      if (dirent.isDirectory()) {
        await copyTree(full, path.join(relDir, dirent.name), depth + 1);
      } else if (dirent.isFile()) {
        await copyFile(full, relDir);
      }
    }
  }

  try {
    for (const p of picked.filePaths) {
      const stat = await fs.stat(p);
      if (stat.isDirectory()) {
        await copyTree(p, path.basename(p), 0);
      } else {
        await copyFile(p, '');
      }
    }
    return { ok: true, imported, skipped };
  } catch (err) {
    return { ok: false, imported, skipped, error: (err as Error).message };
  }
}

export async function revealLibrary(kind: LibraryKind): Promise<void> {
  const root = userRoot(kind);
  await fs.mkdir(root, { recursive: true });
  await shell.openPath(root);
}
