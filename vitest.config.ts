import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  test: {
    include: ["packages/**/*.test.ts"],
  },
  resolve: {
    alias: {
      "@presto/score": path.resolve("packages/score/src/index.ts"),
      "@presto/mini": path.resolve("packages/mini/src/index.ts"),
      "@presto/language": path.resolve("packages/language/src/index.ts"),
      "@presto/musicxml": path.resolve("packages/musicxml/src/index.ts"),
      "@presto/playback": path.resolve("packages/playback/src/index.ts"),
    },
  },
});
