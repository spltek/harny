import { readFileSync } from "node:fs";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    {
      // Icon artwork lives as real .svg files under media/icons/ and reaches the
      // bundles as TEXT (esbuild `loader: {".svg": "text"}`). Vite would
      // otherwise hand a test the asset URL instead of the markup, so the jsdom
      // tests would assert against `<svg>` placeholders instead of the drawing.
      // Same bytes as production, and no test-only branch in the sources.
      name: "svg-as-text",
      enforce: "pre",
      transform(_code, id) {
        const file = id.split("?")[0];
        if (!file.endsWith(".svg")) return null;
        return { code: `export default ${JSON.stringify(readFileSync(file, "utf8"))};`, map: null };
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
