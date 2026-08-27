import { defineConfig } from "vitest/config";

export default defineConfig({
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
