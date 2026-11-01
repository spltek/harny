import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { homedir } from "node:os";
import ignore, { type Ignore } from "ignore";
import type { FileSystem } from "./file-system";

/**
 * Directories skipped ONLY when no git ignore file governs the tree (fallback).
 * When `.gitignore` / `.git/info/exclude` / global excludes are present they are
 * AUTHORITATIVE (like ripgrep), so a project that tracks `dist/` is not
 * over-skipped.
 */
const DEFAULT_SKIP_DIRS: ReadonlySet<string> = new Set([
  ".git",
  "node_modules",
  "dist",
  "build",
  "out",
  "coverage",
  ".next",
  ".nuxt",
  ".turbo",
  "target",
  "vendor",
  "__pycache__",
  ".venv",
  "venv",
  ".tox",
  ".mypy_cache",
  ".pytest_cache",
  ".cache",
  ".gradle",
  ".idea",
]);

interface WalkOptions {
  /** Skip dot-files/dot-dirs (fd/rg default). Default true. */
  skipHidden?: boolean;
  /** Directory names to skip when no ignore file governs the tree. Default {@link DEFAULT_SKIP_DIRS}. */
  skipDirs?: ReadonlySet<string>;
  maxDepth?: number;
  /** Stop once this many files were collected (perf guard). */
  maxFiles?: number;
  /** Respect `.gitignore` / `.ignore` / `.git/info/exclude` / global excludes (default true). */
  respectGitignore?: boolean;
  /** Also apply the machine-global git excludes (default true). */
  useGlobalExcludes?: boolean;
  /** Home dir for global excludes (default `os.homedir()`); injectable for tests. */
  homeDir?: string;
  /** Env for XDG_CONFIG_HOME (default `process.env`); injectable for tests. */
  env?: Record<string, string | undefined>;
}

/** A parsed ignore file, anchored at the directory it applies from. */
interface Matcher {
  base: string;
  ig: Ignore;
}

const toPosix = (p: string): string => p.split(sep).join("/");

/** Build a matcher from raw ignore-file content anchored at `base`. */
function matcherFromContent(content: string, base: string): Matcher | undefined {
  if (!content.trim()) return undefined;
  try {
    return { base, ig: ignore().add(content) };
  } catch {
    return undefined;
  }
}

/** A directory's own `.gitignore` + `.ignore` (concatenated), if any. */
function loadDirMatcher(fs: FileSystem, dir: string): Matcher | undefined {
  let content = "";
  for (const name of [".gitignore", ".ignore"]) {
    const p = join(dir, name);
    try {
      if (fs.exists(p)) content += fs.readText(p) + "\n";
    } catch {
      /* unreadable */
    }
  }
  return matcherFromContent(content, dir);
}

/** A single ignore file (e.g. `.git/info/exclude`, global excludes). */
function loadFileMatcher(fs: FileSystem, file: string, base: string): Matcher | undefined {
  try {
    if (!fs.exists(file)) return undefined;
    return matcherFromContent(fs.readText(file), base);
  } catch {
    return undefined;
  }
}

/** Nearest ancestor (inclusive) containing a `.git` entry, if any. */
function findRepoRoot(fs: FileSystem, start: string): string | undefined {
  let dir = resolve(start);
  for (;;) {
    try {
      if (fs.exists(join(dir, ".git"))) return dir;
    } catch {
      /* ignore */
    }
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

function expandTilde(p: string, home: string): string {
  if (p === "~") return home;
  if (p.startsWith("~/") || p.startsWith("~\\")) return join(home, p.slice(2));
  return p;
}

/** Read `core.excludesFile` from a git config file (simple INI scan). */
function readExcludesFile(fs: FileSystem, configPath: string): string | undefined {
  try {
    if (!fs.exists(configPath)) return undefined;
    let section = "";
    for (const raw of fs.readText(configPath).split(/\r?\n/)) {
      const line = raw.trim();
      if (!line || line.startsWith("#") || line.startsWith(";")) continue;
      const sec = line.match(/^\[([^\]]+)\]$/);
      if (sec) {
        section = sec[1].trim().toLowerCase();
        continue;
      }
      if (section !== "core") continue;
      const m = line.match(/^excludesfile\s*=\s*(.+)$/i);
      if (m) return m[1].trim().replace(/^["']|["']$/g, "");
    }
  } catch {
    /* unreadable */
  }
  return undefined;
}

/** Machine-global git ignore files: `core.excludesFile` + the XDG default. */
function systemConfigFiles(env: Record<string, string | undefined>): string[] {
  if (env.GIT_CONFIG_SYSTEM) return [env.GIT_CONFIG_SYSTEM];
  if (process.platform === "win32") return env.ProgramData ? [join(env.ProgramData, "Git", "config")] : [];
  return ["/etc/gitconfig"];
}

function globalConfigFiles(home: string, env: Record<string, string | undefined>): string[] {
  if (env.GIT_CONFIG_GLOBAL) return [env.GIT_CONFIG_GLOBAL];
  const xdg = env.XDG_CONFIG_HOME?.trim() || join(home, ".config");
  return [join(xdg, "git", "config"), join(home, ".gitconfig")];
}

function globalIgnoreFiles(fs: FileSystem, opts: WalkOptions): string[] {
  const home = opts.homeDir ?? homedir();
  const env = opts.env ?? process.env;
  const xdg = env.XDG_CONFIG_HOME?.trim() || join(home, ".config");
  const out: string[] = [];
  for (const cfg of [...systemConfigFiles(env), ...globalConfigFiles(home, env)]) {
    const v = readExcludesFile(fs, cfg);
    if (v) out.push(expandTilde(v, home));
  }
  out.push(join(xdg, "git", "ignore"));
  return [...new Set(out)];
}

/**
 * Resolve the real git dir of a repo root. `.git` is usually a directory, but
 * for a linked WORKTREE or a submodule it is a FILE containing `gitdir: <path>`
 * (absolute or relative to the repo root).
 */
function resolveGitDir(fs: FileSystem, repoRoot: string): string | undefined {
  const dotGit = join(repoRoot, ".git");
  try {
    if (!fs.exists(dotGit)) return undefined;
    if (fs.isDirectory(dotGit)) return dotGit;
    const m = fs.readText(dotGit).match(/^\s*gitdir:\s*(.+?)\s*$/m);
    if (!m) return undefined;
    const p = m[1].trim();
    return isAbsolute(p) ? p : resolve(repoRoot, p);
  } catch {
    return undefined;
  }
}

/**
 * The COMMON git dir: linked worktrees keep shared state (including
 * `info/exclude`) in the common dir, referenced by `<gitDir>/commondir`.
 */
function commonGitDir(fs: FileSystem, gitDir: string): string {
  try {
    const p = join(gitDir, "commondir");
    if (fs.exists(p)) {
      const rel = fs.readText(p).trim();
      if (rel) return isAbsolute(rel) ? rel : resolve(gitDir, rel);
    }
  } catch {
    /* fall through */
  }
  return gitDir;
}

/**
 * Matchers from the repo root down to the walk root's PARENT (global excludes +
 * `.git/info/exclude` + ancestor `.gitignore`s). The walk root's OWN files are
 * added by the loop, so nothing is loaded twice.
 */
function ancestorMatchers(fs: FileSystem, walkRoot: string, opts: WalkOptions): Matcher[] {
  const repoRoot = findRepoRoot(fs, walkRoot);
  if (!repoRoot) return [];
  const rel = relative(repoRoot, walkRoot);
  if (rel.startsWith("..") || isAbsolute(rel)) return [];

  const out: Matcher[] = [];
  if (opts.useGlobalExcludes !== false) {
    for (const f of globalIgnoreFiles(fs, opts)) {
      const m = loadFileMatcher(fs, f, repoRoot);
      if (m) out.push(m);
    }
  }
  const excludeMatcher = (() => {
    const gitDir = resolveGitDir(fs, repoRoot);
    if (!gitDir) return undefined;
    return loadFileMatcher(fs, join(commonGitDir(fs, gitDir), "info", "exclude"), repoRoot);
  })();
  if (excludeMatcher) out.push(excludeMatcher);

  const segments = rel.split(/[\\/]/).filter(Boolean);
  if (segments.length > 0) {
    let cur = repoRoot;
    const rootMatcher = loadDirMatcher(fs, cur);
    if (rootMatcher) out.push(rootMatcher);
    for (let i = 0; i < segments.length - 1; i++) {
      cur = join(cur, segments[i]);
      const m = loadDirMatcher(fs, cur);
      if (m) out.push(m);
    }
  }
  return out;
}

/**
 * Is `abs` ignored by the accumulated matchers? Evaluated shallow→deep; the
 * DEEPEST matcher that actually has a matching rule decides (git precedence).
 */
function isIgnored(abs: string, matchers: readonly Matcher[]): boolean {
  let ignored = false;
  for (const m of matchers) {
    const rel = toPosix(relative(m.base, abs));
    if (!rel || rel.startsWith("..") || isAbsolute(rel)) continue;
    const t = m.ig.test(rel);
    if (t.ignored || t.unignored) ignored = m.ig.ignores(rel);
  }
  return ignored;
}

/**
 * Recursively list the FILES under `root` (directories excluded). Pure Node +
 * `node:path`, so it behaves identically on every OS. Git semantics: respects
 * `.gitignore`, `.ignore`, `.git/info/exclude`, ancestor ignore files and the
 * machine-global excludes (ripgrep-like), with per-directory precedence.
 */
export function walkFiles(fs: FileSystem, root: string, opts: WalkOptions = {}): string[] {
  const skipHidden = opts.skipHidden ?? true;
  const skipDirs = opts.skipDirs ?? DEFAULT_SKIP_DIRS;
  const respect = opts.respectGitignore ?? true;
  const maxDepth = opts.maxDepth ?? 12;
  const maxFiles = opts.maxFiles ?? Number.POSITIVE_INFINITY;
  const out: string[] = [];
  const seen = new Set<string>();

  const base = respect ? ancestorMatchers(fs, root, opts) : [];
  const stack: Array<{ dir: string; depth: number; matchers: Matcher[] }> = [{ dir: root, depth: 0, matchers: base }];
  while (stack.length > 0 && out.length < maxFiles) {
    const { dir, depth, matchers } = stack.pop()!;
    const real = fs.realpath(dir);
    if (seen.has(real)) continue;
    seen.add(real);

    const own = respect ? loadDirMatcher(fs, dir) : undefined;
    const branch = own ? [...matchers, own] : matchers;

    let entries: string[];
    try {
      entries = fs.list(dir);
    } catch {
      continue;
    }
    for (const name of entries) {
      if (out.length >= maxFiles) break;
      if (name === ".git") continue;
      if (skipHidden && name.startsWith(".")) continue;
      const abs = join(dir, name);
      if (respect && branch.length > 0 && isIgnored(abs, branch)) continue;
      if (fs.exists(abs) && fs.isDirectory(abs)) {
        // Curated fallback ONLY when no ignore file governs this branch.
        if (branch.length === 0 && skipDirs.has(name)) continue;
        if (depth < maxDepth) stack.push({ dir: abs, depth: depth + 1, matchers: branch });
      } else {
        out.push(abs);
      }
    }
  }
  return out;
}
