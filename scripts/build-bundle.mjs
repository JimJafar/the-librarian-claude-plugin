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
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
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

// Stamp provenance so the committed artifacts are auditable and drift-checkable:
// validate.mjs (run in CI) asserts each bin still matches the recorded hash, so a
// hand-edited or stale bin fails CI. The monorepo SHA + lifecycle version record
// WHICH source produced these bytes (CI can't rebuild from the monorepo).
function sha256(file) {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}
function tryExec(cmd, args) {
  try {
    return execFileSync(cmd, args, { encoding: "utf8" }).trim();
  } catch {
    return "unknown";
  }
}
const lifecycleVersion = (() => {
  try {
    const pkg = path.join(monorepo, "integrations/shared/librarian-lifecycle/package.json");
    return JSON.parse(readFileSync(pkg, "utf8")).version ?? "unknown";
  } catch {
    return "unknown";
  }
})();
const provenance = {
  source: "@librarian/lifecycle",
  monorepoSha: tryExec("git", ["-C", monorepo, "rev-parse", "HEAD"]),
  lifecycleVersion,
  bins: Object.fromEntries(
    Object.keys(entries).map((name) => [`${name}.js`, sha256(path.join(root, "bin", `${name}.js`))]),
  ),
};
writeFileSync(
  path.join(root, "bin", "PROVENANCE.json"),
  `${JSON.stringify(provenance, null, 2)}\n`,
);
console.log(
  `wrote bin/PROVENANCE.json (monorepo ${provenance.monorepoSha.slice(0, 12)}, lifecycle ${lifecycleVersion})`,
);
