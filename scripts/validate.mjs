#!/usr/bin/env node
// Validates the plugin's static manifests. This repo is config-heavy, so this is
// the "test suite" — CI runs it on every push/PR. It grows as components land
// (commands, hooks, bundled bins).

import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const errors = [];
const checked = [];

function readJson(rel) {
  const abs = path.join(root, rel);
  if (!existsSync(abs)) return { missing: true };
  try {
    return { value: JSON.parse(readFileSync(abs, "utf8")) };
  } catch (err) {
    errors.push(`${rel}: invalid JSON — ${err.message}`);
    return { error: true };
  }
}

function require(condition, message) {
  if (!condition) errors.push(message);
}

// --- plugin.json ---
const plugin = readJson(".claude-plugin/plugin.json");
if (plugin.missing) {
  errors.push(".claude-plugin/plugin.json is missing");
} else if (plugin.value) {
  checked.push("plugin.json");
  const p = plugin.value;
  require(typeof p.name === "string" && /^[a-z0-9-]+$/.test(p.name), "plugin.json: name must be kebab-case");
  require(p.version === undefined || typeof p.version === "string", "plugin.json: version must be a string");
  require(p.author === undefined || typeof p.author === "object", "plugin.json: author must be an object (no string shorthand)");
}

// --- marketplace.json ---
const market = readJson(".claude-plugin/marketplace.json");
if (market.missing) {
  errors.push(".claude-plugin/marketplace.json is missing");
} else if (market.value) {
  checked.push("marketplace.json");
  const m = market.value;
  require(typeof m.name === "string", "marketplace.json: name is required");
  require(m.owner && typeof m.owner.name === "string", "marketplace.json: owner.name is required");
  require(Array.isArray(m.plugins) && m.plugins.length > 0, "marketplace.json: plugins[] must be non-empty");
  for (const entry of m.plugins ?? []) {
    require(typeof entry.name === "string", "marketplace.json: each plugin entry needs a name");
    require(entry.source !== undefined, `marketplace.json: plugin "${entry.name}" needs a source`);
  }
}

// --- .mcp.json ---
const mcp = readJson(".mcp.json");
if (mcp.missing) {
  errors.push(".mcp.json is missing");
} else if (mcp.value) {
  checked.push(".mcp.json");
  const server = mcp.value.mcpServers?.librarian;
  require(server, ".mcp.json: mcpServers.librarian is required");
  if (server) {
    require(server.type === "http", ".mcp.json: librarian.type must be \"http\"");
    require(
      typeof server.url === "string" && server.url.includes("${LIBRARIAN_MCP_URL}"),
      ".mcp.json: url must reference ${LIBRARIAN_MCP_URL}",
    );
    require(
      server.headers?.Authorization?.includes("${LIBRARIAN_AGENT_TOKEN}"),
      ".mcp.json: Authorization header must use ${LIBRARIAN_AGENT_TOKEN}",
    );
  }
}

// --- hooks/hooks.json + dispatch + bundled bins (land together in PR C) ---
const hooks = readJson("hooks/hooks.json");
if (!hooks.missing && hooks.value) {
  checked.push("hooks.json");
  const h = hooks.value.hooks;
  require(h && typeof h === "object", "hooks.json: top-level hooks object required");
  for (const [event, groups] of Object.entries(h ?? {})) {
    require(Array.isArray(groups), `hooks.json: ${event} must be an array of matcher groups`);
    for (const group of Array.isArray(groups) ? groups : []) {
      const entries = group?.hooks;
      require(Array.isArray(entries) && entries.length > 0, `hooks.json: ${event} group needs a hooks[] array`);
      for (const hook of Array.isArray(entries) ? entries : []) {
        require(hook?.type === "command", `hooks.json: ${event} hook must be type "command"`);
        require(
          typeof hook?.command === "string" && hook.command.includes("${CLAUDE_PLUGIN_ROOT}"),
          `hooks.json: ${event} command must reference \${CLAUDE_PLUGIN_ROOT}`,
        );
      }
    }
  }

  // The remaining UserPromptSubmit hook drives the conv-state injection
  // bin. PR 2 (sessions-rethink) retired the session dispatch script and
  // the two session bins; conv-state injection is the only artifact left.
  require(
    existsSync(path.join(root, "scripts/inject-conv-state.sh")),
    "scripts/inject-conv-state.sh is missing",
  );
  const binNames = ["librarian-conv-state-inject.js"];
  for (const binName of binNames) {
    require(existsSync(path.join(root, "bin", binName)), `bin/${binName} is missing (run npm run build)`);
  }

  // Drift guard: the committed bins must match the hashes build-bundle.mjs recorded.
  // A hand-edited or stale bin (not regenerated from source) fails CI here.
  const prov = readJson("bin/PROVENANCE.json");
  if (prov.missing) {
    errors.push("bin/PROVENANCE.json is missing (run npm run build)");
  } else if (prov.value) {
    checked.push("PROVENANCE.json");
    for (const binName of binNames) {
      const recorded = prov.value.bins?.[binName];
      require(typeof recorded === "string", `PROVENANCE.json: no hash recorded for ${binName}`);
      const abs = path.join(root, "bin", binName);
      if (recorded && existsSync(abs)) {
        const actual = createHash("sha256").update(readFileSync(abs)).digest("hex");
        require(
          actual === recorded,
          `bin/${binName} does not match PROVENANCE.json — regenerate with \`npm run build\` (do not hand-edit bundles)`,
        );
      }
    }
  }
}

// --- skills/<name>/SKILL.md (optional until PR D): frontmatter name + description ---
const skillsDir = path.join(root, "skills");
if (existsSync(skillsDir)) {
  for (const name of readdirSync(skillsDir)) {
    const skillFile = path.join(skillsDir, name, "SKILL.md");
    if (!existsSync(skillFile)) {
      errors.push(`skills/${name}: missing SKILL.md`);
      continue;
    }
    checked.push(`skills/${name}`);
    const text = readFileSync(skillFile, "utf8");
    const fm = text.match(/^---\n([\s\S]*?)\n---/);
    require(Boolean(fm), `skills/${name}/SKILL.md: missing YAML frontmatter`);
    if (fm) {
      require(/\bname:\s*\S/.test(fm[1]), `skills/${name}/SKILL.md: frontmatter needs a name`);
      require(/\bdescription:\s*\S/.test(fm[1]), `skills/${name}/SKILL.md: frontmatter needs a description`);
    }
  }
}

// --- commands/ (optional until PR B): every file is markdown ---
const commandsDir = path.join(root, "commands");
if (existsSync(commandsDir)) {
  const files = readdirSync(commandsDir);
  checked.push(`commands/ (${files.length})`);
  for (const f of files) {
    require(f.endsWith(".md"), `commands/${f}: commands must be .md files`);
  }
}

if (errors.length) {
  console.error("Plugin validation FAILED:");
  for (const e of errors) console.error(` - ${e}`);
  process.exit(1);
}
console.log(`Plugin validation passed (${checked.join(", ")}).`);
