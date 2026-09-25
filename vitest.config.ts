import path from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    env: {
      // Any test that opens an on-disk DB writes here, never into the real data/.
      // Secret hermeticity lives in config/env.ts itself: it skips loading
      // .env entirely whenever process.env.VITEST is set.
      DATA_DIR: path.resolve(process.cwd(), ".vitest-data"),
    },
    server: {
      // node:sqlite is still experimental and isn't in Node's public
      // builtinModules list, which Vite's default externalization check
      // relies on — without this, Vite tries (and fails) to bundle it as a
      // regular package named "sqlite" instead of passing it through to Node.
      deps: {
        external: [/^(node:)?sqlite$/],
      },
    },
  },
});
