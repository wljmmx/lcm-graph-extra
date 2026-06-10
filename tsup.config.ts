import { defineConfig } from "tsup";

import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  // DTS disabled: SDK types resolved at runtime via OpenClaw plugin loader
  dts: false,
  sourcemap: true,
  clean: true,
  target: "es2022",
  external: ["openclaw/plugin-sdk", "node:sqlite"],
});
