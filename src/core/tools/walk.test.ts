import { describe, it, expect } from "vitest";
import type { FileSystem } from "./file-system";
import { walkFiles } from "./walk";

/** In-memory FS: `{ "/w/a.ts": "content" }`; directories derived from paths. */
function memFs(files: Record<string, string>): FileSystem {
  const norm = (p: string): string => p.replace(/\\/g, "/");
  const dirs = new Set<string>();
  for (const p of Object.keys(files)) {
    const parts = p.split("/");
    for (let i = 1; i < parts.length; i++) dirs.add(parts.slice(0, i).join("/"));
  }
  return {
    readText: (p) => {
      const k = norm(p);
      if (!(k in files)) throw new Error(`ENOENT: ${k}`);
      return files[k];
    },
    writeText: () => {},
    exists: (p) => {
      const k = norm(p);
      return k in files || dirs.has(k);
    },
    isDirectory: (p) => dirs.has(norm(p)),
    realpath: (p) => p,
    list: (d) => {
      const k = norm(d);
      if (!dirs.has(k)) return [];
      const prefix = k.endsWith("/") ? k : k + "/";
      const out = new Set<string>();
      for (const p of [...Object.keys(files), ...dirs]) {
        if (!p.startsWith(prefix)) continue;
        const rest = p.slice(prefix.length);
        if (rest) out.add(rest.split("/")[0]);
      }
      return [...out];
    },
    size: (p) => (files[norm(p)] ?? "").length,
    mtimeMs: () => 0,
    mkdirRecursive: () => {},
    delete: () => {},
  };
}

const paths = (files: string[]) => files.map((f) => f.replace(/\\/g, "/"));

describe("walkFiles + .gitignore", () => {
  it("respects .gitignore patterns (dirs, *.ext)", () => {
    const fs = memFs({
      "/w/.gitignore": "node_modules\ndist\n*.log\n",
      "/w/node_modules/x.ts": "",
      "/w/dist/bundle.js": "",
      "/w/src/app.ts": "",
      "/w/debug.log": "",
      "/w/readme.md": "",
    });
    const found = paths(walkFiles(fs, "/w"));
    expect(found).toContain("/w/src/app.ts");
    expect(found).toContain("/w/readme.md");
    expect(found.some((f) => f.includes("node_modules"))).toBe(false);
    expect(found.some((f) => f.includes("dist"))).toBe(false);
    expect(found.some((f) => f.endsWith(".log"))).toBe(false);
    // the .gitignore itself is a dot-file → not returned
    expect(found.some((f) => f.endsWith(".gitignore"))).toBe(false);
  });

  it("honours negation (!keep.log)", () => {
    const fs = memFs({
      "/w/.gitignore": "*.log\n!keep.log\n",
      "/w/a.log": "",
      "/w/keep.log": "",
    });
    const found = paths(walkFiles(fs, "/w"));
    expect(found).toContain("/w/keep.log");
    expect(found).not.toContain("/w/a.log");
  });

  it("applies the DEEPEST .gitignore (per-directory precedence)", () => {
    const fs = memFs({
      "/w/.gitignore": "*.log\n",
      "/w/src/.gitignore": "!important.log\n",
      "/w/a.log": "",
      "/w/src/b.log": "",
      "/w/src/important.log": "",
    });
    const found = paths(walkFiles(fs, "/w"));
    expect(found).toContain("/w/src/important.log"); // re-included deeper
    expect(found).not.toContain("/w/a.log");
    expect(found).not.toContain("/w/src/b.log");
  });

  it("anchored /pattern only applies at the .gitignore's directory", () => {
    const fs = memFs({
      "/w/.gitignore": "/build\n",
      "/w/build/x.js": "",
      "/w/src/build/y.js": "",
    });
    const found = paths(walkFiles(fs, "/w"));
    expect(found.some((f) => f === "/w/build/x.js")).toBe(false); // ignored at root
    expect(found).toContain("/w/src/build/y.js"); // nested not matched by /build
  });

  it("falls back to the curated list when there is NO .gitignore", () => {
    const fs = memFs({ "/w/node_modules/x.ts": "", "/w/a.ts": "" });
    const found = paths(walkFiles(fs, "/w"));
    expect(found).toContain("/w/a.ts");
    expect(found.some((f) => f.includes("node_modules"))).toBe(false);
  });

  it("respects .ignore too, and always skips .git", () => {
    const fs = memFs({ "/w/.ignore": "*.tmp\n", "/w/a.tmp": "", "/w/a.ts": "", "/w/.git/config": "" });
    const found = paths(walkFiles(fs, "/w"));
    expect(found).toContain("/w/a.ts");
    expect(found.some((f) => f.endsWith(".tmp"))).toBe(false);
    expect(found.some((f) => f.includes(".git/"))).toBe(false);
  });

  it("honours .git/info/exclude (repo-level, no .gitignore)", () => {
    const fs = memFs({
      "/repo/.git/info/exclude": "secret.txt\n",
      "/repo/secret.txt": "",
      "/repo/a.ts": "",
    });
    const found = paths(walkFiles(fs, "/repo"));
    expect(found).toContain("/repo/a.ts");
    expect(found).not.toContain("/repo/secret.txt");
  });

  it("honours the global core.excludesFile from ~/.gitconfig", () => {
    const fs = memFs({
      "/home/.gitconfig": "[core]\n\texcludesFile = /home/.gitignore_global\n",
      "/home/.gitignore_global": "*.bak\n",
      "/repo/.git/HEAD": "",
      "/repo/a.ts": "",
      "/repo/old.bak": "",
    });
    const found = paths(walkFiles(fs, "/repo", { homeDir: "/home", env: {} }));
    expect(found).toContain("/repo/a.ts");
    expect(found).not.toContain("/repo/old.bak");
  });

  it("honours the XDG default global ignore ($XDG_CONFIG_HOME/git/ignore)", () => {
    const fs = memFs({
      "/xdg/git/ignore": "*.tmp\n",
      "/repo/.git/HEAD": "",
      "/repo/a.ts": "",
      "/repo/a.tmp": "",
    });
    const found = paths(walkFiles(fs, "/repo", { homeDir: "/home", env: { XDG_CONFIG_HOME: "/xdg" } }));
    expect(found).toContain("/repo/a.ts");
    expect(found).not.toContain("/repo/a.tmp");
  });

  it("can disable the global excludes (useGlobalExcludes:false)", () => {
    const fs = memFs({
      "/home/.gitignore_global": "*.bak\n",
      "/home/.gitconfig": "[core]\nexcludesFile = /home/.gitignore_global\n",
      "/repo/.git/HEAD": "",
      "/repo/old.bak": "",
    });
    const found = paths(walkFiles(fs, "/repo", { homeDir: "/home", env: {}, useGlobalExcludes: false }));
    expect(found).toContain("/repo/old.bak");
  });

  it("applies ANCESTOR .gitignore when walking a subdirectory", () => {
    const fs = memFs({
      "/repo/.git/HEAD": "",
      "/repo/.gitignore": "*.log\n",
      "/repo/src/a.log": "",
      "/repo/src/a.ts": "",
    });
    const found = paths(walkFiles(fs, "/repo/src"));
    expect(found).toContain("/repo/src/a.ts");
    expect(found).not.toContain("/repo/src/a.log");
  });

  it("resolves a WORKTREE (.git file -> gitdir -> commondir info/exclude)", () => {
    const fs = memFs({
      "/wt/.git": "gitdir: /main/.git/worktrees/wt\n",
      "/main/.git/worktrees/wt/commondir": "../..\n",
      "/main/.git/info/exclude": "secret.txt\n",
      "/wt/secret.txt": "",
      "/wt/a.ts": "",
    });
    const found = paths(walkFiles(fs, "/wt"));
    expect(found).toContain("/wt/a.ts");
    expect(found).not.toContain("/wt/secret.txt");
  });

  it("reads the global config from GIT_CONFIG_GLOBAL when set", () => {
    const fs = memFs({
      "/custom/config": "[core]\nexcludesFile = /custom/ignore\n",
      "/custom/ignore": "*.bak\n",
      "/repo/.git/HEAD": "",
      "/repo/a.ts": "",
      "/repo/old.bak": "",
    });
    const found = paths(walkFiles(fs, "/repo", { homeDir: "/home", env: { GIT_CONFIG_GLOBAL: "/custom/config" } }));
    expect(found).toContain("/repo/a.ts");
    expect(found).not.toContain("/repo/old.bak");
  });

  it("gitignore can be disabled (respectGitignore:false → curated fallback)", () => {
    const fs = memFs({ "/w/.gitignore": "*.log\n", "/w/a.log": "", "/w/a.ts": "" });
    expect(paths(walkFiles(fs, "/w", { respectGitignore: false }))).toContain("/w/a.log");
  });
});
