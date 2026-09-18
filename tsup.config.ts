import { defineConfig } from "tsup"

export default defineConfig({
  // Two entry points on purpose: `index.ts` is the side-effect-free
  // library export (`createServer`, the client, the transports) and
  // `cli.ts` is the package's `bin`, which starts a server as soon as it
  // is loaded. Splitting is disabled so each output file is
  // self-contained — the bin must work when invoked through npm's
  // `node_modules/.bin` symlink with no shared-chunk resolution.
  entry: ["src/index.ts", "src/cli.ts"],
  format: ["esm"],
  target: "node24",
  dts: true,
  clean: true,
  splitting: false,
  banner: {
    js: "#!/usr/bin/env node",
  },
})
