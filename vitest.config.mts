import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: [
      // `vscode` does not exist on disk — it is injected by the editor at runtime.
      // Bare imports are resolved at TRANSFORM time, so without a target a dynamic
      // `await import("vscode")` inside the extension code fails to resolve in the
      // jsdom environment and takes the whole file down before a single test runs
      // (see the stub's own note). `vi.mock("vscode", …)` still wins at runtime:
      // it is registered before the module graph is evaluated.
      { find: /^vscode$/, replacement: fileURLToPath(new URL("./src/test/vscode.test-utils.ts", import.meta.url)) },
    ],
  },
  plugins: [
    {
      // Icon artwork lives as real .svg files under media/icons/ and reaches the
      // bundles as TEXT (esbuild `loader: {".svg": "text"}`). Vite would
      // otherwise hand a test the asset URL instead of the markup, so the jsdom
      // tests would assert against `<svg>` placeholders instead of the drawing.
      // Same bytes as production, and no test-only branch in the sources.
      // (The stylesheet needs none of this: it is imported with `?raw`, which Vite
      // supports natively.)
      name: "svg-as-text",
      enforce: "pre",
      transform(_code, id) {
        const file = id.split("?")[0];
        if (!file.endsWith(".svg")) return null;
        return { code: `export default ${JSON.stringify(readFileSync(file, "utf8"))};`, map: null };
      },
    },
    {
      // `import css from "./view.css?raw"` is native in Vite, but Vitest STUBS every CSS module
      // (its css option is off by default) and `?raw` does not escape that. So the text is
      // produced here: Vite's own resolver finds the file (`this.resolve`), and the id gets a
      // neutral `.rawtext` suffix so the CSS pipeline cannot recognise (and empty) it.
      name: "raw-text-in-tests",
      enforce: "pre",
      async resolveId(source, importer, options) {
        if (!source.endsWith("?raw")) return null;
        const resolved = await this.resolve(source.slice(0, -4), importer, { ...options, skipSelf: true });
        return resolved ? resolved.id + ".rawtext" : null;
      },
      load(id) {
        if (!id.endsWith(".rawtext")) return null;
        return `export default ${JSON.stringify(readFileSync(id.slice(0, -8), "utf8"))};`;
      },
    },
  ],
  test: {
    include: ["src/**/*.test.ts"],
    setupFiles: ["src/chat/webview/prism.test-setup.ts"],
    environment: "node",
    coverage: {
      provider: "v8",
      reporter: ["text", "html"],
      include: ["src/core/**/*.ts", "src/chat/**/*.ts"],
      exclude: ["src/**/*.test.ts", "src/extension.ts", "src/logger.ts"],
    },
  },
});
