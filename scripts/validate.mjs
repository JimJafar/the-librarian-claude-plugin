#!/usr/bin/env node
// Validates the plugin's static manifests. This repo is config-heavy, so this is
// the "test suite" — CI runs it on every push/PR. It grows as components land
// (commands, hooks, bundled bins).

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

// --- hooks/hooks.json (optional until PR C) ---
const hooks = readJson("hooks/hooks.json");
if (!hooks.missing && hooks.value) {
  checked.push("hooks.json");
  require(hooks.value.hooks && typeof hooks.value.hooks === "object", "hooks.json: top-level hooks object required");
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
