#!/usr/bin/env node
// Regenerate the bundled lifecycle artifacts in bin/ from the @librarian/lifecycle
// package in a sibling the-librarian checkout.
//
// We bundle from the package's COMPILED dist/ (not src/): the source uses NodeNext
// `./foo.js` import specifiers that resolve to .ts files, which esbuild does not
// remap — but the compiled dist has real .js files that bundle cleanly. The
// lifecycle runtime is dependency-light (no @librarian/core, no node:sqlite), so
// each bundle is small and self-contained.
//
// The COMMITTED bin/*.js are the distributable; run this after the lifecycle
// changes. Set LIBRARIAN_MONOREPO to point at your the-librarian checkout if it is
// not the sibling directory.

import { build } from "esbuild";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const monorepo = process.env.LIBRARIAN_MONOREPO || path.resolve(root, "..", "the-librarian");
const dist = path.join(monorepo, "integrations", "shared", "librarian-lifecycle", "dist", "bin");

const entries = {
  "librarian-claude-hook": path.join(dist, "claude-code-hook.js"),
  "librarian-mcp-call": path.join(dist, "mcp-call.js"),
};

if (!existsSync(entries["librarian-claude-hook"])) {
  console.error(
    `@librarian/lifecycle is not built at:\n  ${dist}\n\n` +
      `Build it first:\n  pnpm --filter @librarian/lifecycle build   (in ${monorepo})\n\n` +
      `Or set LIBRARIAN_MONOREPO to your the-librarian checkout.`,
  );
  process.exit(1);
}

for (const [name, entryPoint] of Object.entries(entries)) {
  await build({
    entryPoints: [entryPoint],
    outfile: path.join(root, "bin", `${name}.js`),
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node18",
    // No shebang banner: esbuild already hoists the entry file's shebang, and the
    // bins are always run as `node <bin>` (dispatch.sh / spawnSync), so the
    // shebang is cosmetic. A banner here would duplicate it and break `node --check`.
    legalComments: "none",
  });
  console.log(`bundled bin/${name}.js`);
}
